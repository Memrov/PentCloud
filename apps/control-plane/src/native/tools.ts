import type {ToolboxService} from "../../../../shared/toolbox-rpc";
import { RpcTarget } from "cloudflare:workers";
import type { Workspace } from "@cloudflare/computer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Role } from "./types";
import { uniqueClientIds } from "./mcp-ids";
import { TOOLBOX_GENERATION_HEADER, toolboxGeneration, ToolboxGenerationLostError } from "./toolbox-lifecycle";
import { REPO_DIR, assertRoleWrite, confinedRelative } from "./tool-policy";
export * from "./tool-policy";

export interface WorkspaceAuthority {
  role: Role;
  id: string;
  root?: string;
  active(): Promise<void>;
}
/** Refuse symlinks at every component, including nonexistent write destinations. */
export async function resolveWorkspacePath(
  workspace: Workspace,
  requested: string,
  write = false,
  authority?: WorkspaceAuthority,
): Promise<string> {
  const root = authority?.root ?? REPO_DIR;
  const confined = confinedRelative(requested, root);
  const relative =
    write && authority
      ? assertRoleWrite(authority.role, authority.id, confined)
      : confined;
  if (write) await authority?.active();
  const parts = relative === "." ? [] : relative.split("/");
  for (let i = 0; i <= parts.length; i++) {
    const candidate = `${root}${i ? "/" + parts.slice(0, i).join("/") : ""}`;
    try {
      if ((await workspace.fs.lstat(candidate)).isSymbolicLink)
        throw new Error("Symlink paths are unavailable to model tools");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return `${root}${relative === "." ? "" : "/" + relative}`;
}
function isNotFound(error: unknown) {
  return (
    error instanceof Error &&
    (/ENOENT|not found|does not exist/i.test(error.message) ||
      ("code" in error && error.code === "ENOENT"))
  );
}

/** Only these filesystem capabilities cross into the shell isolate. */
export class GuardedFilesystem extends RpcTarget {
  constructor(
    private workspace: Workspace,
    private authority: WorkspaceAuthority,
  ) {
    super();
  }
  private async path(path: string, write = false) {
    return resolveWorkspacePath(this.workspace, path, write, this.authority);
  }
  async readFile(path: string, options: "utf8" | { encoding: "utf8" }): Promise<string>;
  async readFile(path: string, options?: { byteOffset?: number; byteLength?: number }): Promise<ReadableStream<Uint8Array>>;
  async readFile(path: string, options?: { encoding?: "utf8"; byteOffset?: number; byteLength?: number } | "utf8") {
    const target = await this.path(path);
    return options === "utf8" || options?.encoding === "utf8"
      ? this.workspace.fs.readFile(target, "utf8")
      : this.workspace.fs.readFile(target, options ?? {});
  }
  async exists(path: string) {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string) {
    return this.workspace.fs.stat(await this.path(path));
  }
  async statOrNull(path: string) {
    try {
      return await this.stat(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async lstat(path: string) {
    return this.workspace.fs.lstat(await this.path(path));
  }
  async lstatOrNull(path: string) {
    return this.statOrNull(path);
  }
  async readdir(path: string, options?: { limit?: number; offset?: number }) {
    return (await this.workspace.fs.readdir(await this.path(path), options)).filter(
      (e) => e.name.toLowerCase() !== ".git",
    );
  }
  async find(path: string, pattern?: string, options?: { limit?: number; offset?: number }) {
    return (
      await this.workspace.fs.find(await this.path(path), pattern, options)
    ).filter((e) => !e.path.split("/").includes(".git"));
  }
  async ls(path: string) {
    return (await this.workspace.fs.ls(await this.path(path))).filter(
      (p) => !p.split("/").includes(".git"),
    );
  }
  async grep(
    pattern: string,
    path: string,
    options?: Parameters<Workspace["fs"]["grep"]>[2],
  ) {
    return (
      await this.workspace.fs.grep(pattern, await this.path(path), options)
    ).filter((match) => !match.path.split("/").includes(".git"));
  }
  async readlink(_path: string): Promise<string> {
    throw new Error("Symlinks are unavailable to model tools");
  }
  async writeFile(path: string, content: string | Uint8Array, options?: { mode?: number }) {
    await this.workspace.fs.writeFile(await this.path(path, true), content, options);
  }
  async mkdir(path: string, options?: { recursive?: boolean }) {
    await this.authority.active();
    // Stock file tools ensure parent directories even when they already exist.
    // Recursive mkdir of an existing directory is a no-op; actual writes remain guarded.
    if (options?.recursive && (await this.statOrNull(path))?.isDirectory) return;
    await this.workspace.fs.mkdir(await this.path(path, true), options);
  }
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
    if(confinedRelative(path,this.authority.root??REPO_DIR)===`.pentagi/evidence/${this.authority.id}`)throw new Error("Captured evidence directory is runtime owned");
    await this.workspace.fs.rm(await this.path(path, true), options);
  }
  async chmod(path: string, mode: number) {
    await this.workspace.fs.chmod(await this.path(path, true), mode);
  }
  async symlink(_target: string, _path: string): Promise<void> {
    throw new Error("Symlinks are unavailable to model tools");
  }
  async rename(from: string, to: string) {
    if([from,to].some(path=>confinedRelative(path,this.authority.root??REPO_DIR)===`.pentagi/evidence/${this.authority.id}`))throw new Error("Captured evidence directory is runtime owned");
    await this.workspace.fs.rename(
      await this.path(from, true),
      await this.path(to, true),
    );
  }
}
export class GuardedGit extends RpcTarget {
  constructor(
    private workspace: Workspace,
    private authority: WorkspaceAuthority,
  ) {
    super();
  }
  async cli(input: Parameters<Workspace["git"]["cli"]>[0]) {
    await this.authority.active();
    const argv = input.argv;
    if (
      !argv ||
      !["status", "diff", "log", "show", "ls-files", "rev-parse"].includes(
        argv[0] ?? "",
      ) ||
      argv.some(
        (arg) =>
          arg === "-C" ||
          arg.startsWith("--git-dir") ||
          arg.startsWith("--work-tree") ||
          arg === "--output" ||
          arg.startsWith("--output="),
      )
    )
      return {
        stdout: "",
        stderr:
          "git: only read-only inspection is available; runtime publishes candidate commits\n",
        exitCode: 1,
      };
    return this.workspace.git.cli({
      ...input,
      cwd: this.authority.root ?? REPO_DIR,
    });
  }
}
class DeniedArtifacts extends RpcTarget {
  async cli() {
    return {
      stdout: "",
      stderr: "artifacts: publication is owned by the runtime\n",
      exitCode: 1,
    };
  }
}
export class GuardedWorkspace extends RpcTarget {
  private readonly filesystem: GuardedFilesystem;
  private readonly gitClient: GuardedGit;
  private readonly artifactClient = new DeniedArtifacts();
  get fs() {
    return this.filesystem;
  }
  get git() {
    return this.gitClient;
  }
  get artifacts() {
    return this.artifactClient;
  }
  constructor(workspace: Workspace, authority: WorkspaceAuthority) {
    super();
    this.filesystem = new GuardedFilesystem(workspace, authority);
    this.gitClient = new GuardedGit(workspace, authority);
  }
}

export interface RemoteTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}
export interface ToolboxSession {
  sessionId: string;
  protocolVersion?: string;
  /** Older unversioned sessions are read only to fence them, never migrated. */
  generation?: string;
}
export interface ToolboxSessionStorage {
  load(): Promise<ToolboxSession | undefined>;
  save(session: ToolboxSession): Promise<void>;
  clear(): Promise<void>;
}
const CONTROL_TIMEOUT_MS = 30_000;
/** The official MCP client owns framing, sessions and protocol negotiation. */
export class ToolboxMCP {
  private readonly client = new Client(
    { name: "pentagi-native", version: "1" },
    {
      capabilities: {},
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
  private connected = false;
  private connecting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private saved: ToolboxSession | undefined;
  private deleteConfirmed = false;
  constructor(
    private fetcher: Pick<ToolboxService, "fetch">,
    private sessions: ToolboxSessionStorage | undefined,
    private readonly generation: string,
  ) { if (!toolboxGeneration(generation)) throw new ToolboxGenerationLostError(); }
  private createTransport(session?: ToolboxSession) {
    if (session && session.generation !== this.generation) throw new ToolboxGenerationLostError();
    const transport = new StreamableHTTPClientTransport(
      new URL("https://toolbox.internal/mcp?codemode=false"),
      {
        ...(session ? { sessionId: session.sessionId } : {}),
        fetch: async (url, init) => {
          const request = new Request(url, init);
          request.headers.set(TOOLBOX_GENERATION_HEADER, this.generation);
          const deleting = request.method === "DELETE";
          const signal = deleting
            ? AbortSignal.any([
                request.signal,
                AbortSignal.timeout(CONTROL_TIMEOUT_MS),
              ])
            : request.signal;
          const response = await this.fetcher.fetch(
            new Request(request, { signal }),
          );
          const responseGeneration = response.headers.get(TOOLBOX_GENERATION_HEADER);
          if (responseGeneration !== this.generation || response.headers.get("X-Pentcloud-Toolbox-Lost") === "true") {
            await response.body?.cancel();
            throw new ToolboxGenerationLostError(response.status === 409);
          }
          // Persist the opaque server session before returning any mutation response.
          // The negotiated version is updated again after initialize completes.
          const id = response.headers.get("Mcp-Session-Id");
          if (id)
            await this.persist({
              sessionId: id,
              ...(transport.protocolVersion
                ? { protocolVersion: transport.protocolVersion }
                : session?.protocolVersion
                  ? { protocolVersion: session.protocolVersion }
                  : {}),
            });
          if (deleting) {
            // SDK accepts 405 as protocol-valid. This application requires positive
            // deletion proof before forgetting the backend group/result registry.
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error(
                `MCP session deletion was not confirmed (HTTP ${response.status})`,
              );
            }
            this.deleteConfirmed = true;
          }
          return response;
        },
      },
    );
    if (session?.protocolVersion)
      transport.setProtocolVersion(session.protocolVersion);
    return transport;
  }
  private async persist(session: ToolboxSession) {
    this.saved = {...session, generation: this.generation};
    await this.sessions?.save(this.saved);
  }
  private connect(): Promise<void> {
    if (this.closing) return this.closing.then(() => this.connect());
    if (this.connected) return Promise.resolve();
    return (this.connecting ??= (async () => {
      const saved = this.saved ?? (await this.sessions?.load());
      const transport = this.createTransport(saved);
      this.transport = transport;
      try {
        // Public SDK sessionId resume deliberately skips initialize. Default
        // strict-capability enforcement is off, so no private Client mutation is needed.
        await this.client.connect(uniqueClientIds(transport as Transport), {
          timeout: CONTROL_TIMEOUT_MS,
        });
        if (transport.sessionId)
          await this.persist({
            sessionId: transport.sessionId,
            ...(transport.protocolVersion
              ? { protocolVersion: transport.protocolVersion }
              : {}),
          });
        this.connected = true;
      } catch (error) {
        if (transport.sessionId)
          await this.persist({
            sessionId: transport.sessionId,
            ...(transport.protocolVersion
              ? { protocolVersion: transport.protocolVersion }
              : {}),
          });
        throw error;
      }
    })().finally(() => {
      this.connecting = undefined;
    }));
  }
  async list(): Promise<RemoteTool[]> {
    await this.connect();
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const result = await this.client.listTools(cursor ? { cursor } : {}, {
        timeout: CONTROL_TIMEOUT_MS,
      });
      tools.push(...result.tools);
      if (!result.nextCursor) return tools;
      if (result.nextCursor === cursor)
        throw new Error("Toolbox MCP cursor did not advance");
      cursor = result.nextCursor;
    }
    throw new Error("Toolbox MCP catalog pagination exceeded limit");
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 10_800_000,
  ) {
    await this.connect();
    // A tool deadline is not an attempt deadline. Mutations are never retried.
    return this.client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
  }
  /** Close only this isolate's streams, preserving backend/result identity for recovery. */
  async detach() {
    await this.client.close();
    this.connected = false;
    this.transport = undefined;
  }
  /** Retire a terminal session. Failed/unsupported DELETE keeps durable ownership. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.connecting?.catch(() => undefined);
      const saved = this.saved ?? (await this.sessions?.load());
      const transport =
        this.transport ?? (saved ? this.createTransport(saved) : undefined);
      try {
        if (transport?.sessionId) {
          this.deleteConfirmed = false;
          await transport.terminateSession();
          if (!this.deleteConfirmed)
            throw new Error("MCP session deletion was not confirmed");
          await this.sessions?.clear();
          this.saved = undefined;
        }
      } finally {
        await this.detach();
      }
    })().finally(() => {
      this.closing = undefined;
    }));
  }
}
