import {OpenCode} from "@opencode/client";
import type {OpenCodeWorkerd} from "@opencode/sdk/workerd";
import {OpenCodeHarness} from "agents/harness/opencode";
import {createMcpHandler} from "agents/mcp/server";
import {McpServer, fromJsonSchema} from "@modelcontextprotocol/server";
import type {Workspace} from "@cloudflare/computer";
import {ProbeAttempt} from "../native-attempt-probe/worker";
import {ProbeCoordinator} from "../native-coordinator-probe/worker";
import {nativeProvider, type OpenCodeModel} from "../../src/native/opencode-models";
import type {AttemptInput, AttemptRecord, RunRecord} from "../../src/native/types";
import type {CloudflareTool} from "../../src/native/cloudflare-tools";
export {WorkspaceServiceProxy} from "@cloudflare/computer";
export {NativeDynamicWorkerTail} from "../../src/native/dynamic-worker-tail";
export {TargetEgress} from "../../src/native/target-egress";

type Scenario = "advice" | "tool" | "cancel";
type Files = Record<string, number[]>;
type Connection = {baseUrl: string; password: string};
type TrialEnv = {
  LOADER: WorkerLoader;
  COORDINATOR: DurableObjectNamespace<ServerCoordinator>;
  ATTEMPTS: DurableObjectNamespace<ServerAttempt>;
};
const jobID = "job-0", runID = "run-0", profile = "pentcloud-adviser";

/** Only the external Git transport is a fixture; commit/provenance checks stay real. */
async function files(workspace: Workspace, root: string, prefix = ""): Promise<Files> {
  const result: Files = {};
  for (const entry of await workspace.fs.readdir(root + (prefix ? "/" + prefix : ""))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) Object.assign(result, await files(workspace, root, path));
    else if (entry.isFile) result[path] = [...new Uint8Array(await new Response(await workspace.fs.readFile(`${root}/${path}`)).arrayBuffer())];
    else throw new Error("Unexpected symbolic link in fixture Git transport");
  }
  return result;
}
async function putFile(workspace: Workspace, root: string, path: string, bytes: number[]) {
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("Invalid fixture path");
  const full = `${root}/${path}`;
  await workspace.fs.mkdir(full.slice(0, full.lastIndexOf("/")), {recursive: true});
  await workspace.fs.writeFile(full, new Uint8Array(bytes));
}

export class ServerCoordinator extends ProbeCoordinator {
  private readonly trial: TrialEnv;
  constructor(ctx: DurableObjectState, env: TrialEnv) {
    super(ctx, env as unknown as ConstructorParameters<typeof ProbeCoordinator>[1]);
    this.trial = env;
  }
  private record<T>(key: string): T {
    return JSON.parse(this.ctx.storage.sql.exec<{value: string}>("SELECT value FROM native_records WHERE key=?", key).one().value) as T;
  }
  private save(key: string, value: unknown) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO native_records(key,value) VALUES(?,?)", key, JSON.stringify(value));
  }
  async prepareTrial(scenario: Scenario) {
    if (!["advice", "tool", "cancel"].includes(scenario)) throw new Error("Unknown scenario");
    if (await this.ctx.storage.get("trial:prepared")) throw new Error("Use fresh fixture storage for each scenario");
    await this.seed(1, "coder", false);
    const prior = this.record<AttemptRecord>(`job:${jobID}`), run = this.record<RunRecord>(`run:${runID}`);
    const task = scenario === "tool"
      ? "Read README.md using the PentCloud computer_read MCP tool, then give a short plain-text summary."
      : "Give a short plain-text assessment of this isolated PentCloud compatibility trial. Do not use tools.";
    const settings = {...prior.settings, promptFormat: "markdown" as const, promptTemplate: "You are PentCloud's adviser. " + task};
    const job = {...prior, role: "adviser" as const, tool: "advice", task, args: {question: task, message: "Isolated full-server trial"}, settings};
    // Holding this fixture run in setup prevents creation of follow-up agents.
    this.save(`run:${runID}`, {...run, task, phase: "setup", settings: {...run.settings, roles: {...run.settings.roles, adviser: settings}}});
    this.save(`job:${jobID}`, job);
    const context = (this as unknown as {contextFor(id: string): Record<string, unknown>}).contextFor(jobID);
    const input: AttemptInput = {
      id: job.id, runId: job.runId, role: job.role, tool: job.tool, task, args: job.args,
      repo: job.repo, remote: job.remote, inputCommit: run.headCommit,
      settingsRevision: job.settingsRevision, settings, context,
      depth: job.depth, attempt: job.attempt, logicalThreadId: job.logicalThreadId, createdAt: job.createdAt,
    };
    const prepared = await this.trial.ATTEMPTS.getByName(jobID).prepareTrial(input) as {prompt: string; providerConfig: unknown};
    await this.ctx.storage.put("trial:prepared", scenario);
    await this.lifecycle.jobs.reschedule("pentcloud:recover", Date.now() + 3600000);
    await this.ctx.storage.deleteAlarm();
    return {id: jobID, runId: runID, scenario, agent: profile, model: {providerID: "opencode-go", id: "deepseek-v4-pro"}, mcpPath: "/mcp", baselineText: "baseline\n", ...prepared};
  }
  async baseline(): Promise<Files> { return files(this.workspace, `/accepted/${runID}`); }
  async receiveCandidate(commit: string, content: Files) {
    for (const [path, bytes] of Object.entries(content)) {
      if (path.startsWith(".git/objects/") || path.startsWith(".git/refs/heads/attempts/"))
        await putFile(this.workspace, `/accepted/${runID}`, path, bytes);
      if (!path.startsWith(".git/")) this.save(`blob:${commit}:${path}`, bytes);
    }
    await this.ctx.storage.put("trial:receivedCandidate", commit);
  }
  async startTrial() {
    if (!await this.ctx.storage.get("trial:prepared")) throw new Error("Prepare the trial first");
    if (!await this.trial.ATTEMPTS.getByName(jobID).configured()) throw new Error("Configure the full OpenCode server first");
    this.ctx.waitUntil(this.recoverNow().catch(error => this.ctx.storage.put("trial:error", String(error))));
    return {started: true, id: jobID};
  }
  async statusTrial() {
    const snapshot = await this.snapshot();
    return {
      coordinator: {jobs: snapshot.jobs, active: snapshot.records.find(row => row.key === "active")?.value ?? null, runs: snapshot.records.filter(row => row.key.startsWith("run:")).map(row => row.value)},
      acceptedHead: await this.mainHead(runID), receivedCandidate: await this.ctx.storage.get("trial:receivedCandidate"),
      error: await this.ctx.storage.get("trial:error"), attempt: await this.trial.ATTEMPTS.getByName(jobID).observation(),
    };
  }
  async cleanupTrial() {
    await this.cancelRun(runID);
    await this.trial.ATTEMPTS.getByName(jobID).cleanupTrial();
    await this.ctx.storage.deleteAlarm();
    return {cleaned: true};
  }
}

export class ServerAttempt extends ProbeAttempt {
  private readonly trial: TrialEnv;
  constructor(ctx: DurableObjectState, env: TrialEnv) {
    super(ctx, env);
    this.trial = env;
    Object.assign(this.env, {COORDINATOR: env.COORDINATOR});
    // The original probe stubs abort because it does not run models. This trial
    // must exercise the real remote interrupt implementation.
    this.harness.abort = OpenCodeHarness.prototype.abort.bind(this.harness);
    this.workspace.git.clone = async options => {
      if (options.headers?.Authorization !== `Basic ${btoa("x:local-probe-token-read")}`) throw new Error("Missing fixture read token");
      for (const [path, bytes] of Object.entries(await env.COORDINATOR.getByName("global").baseline()))
        await putFile(this.workspace, options.dir!, path, bytes);
      return undefined as never;
    };
    this.workspace.git.push = async options => {
      if (options?.headers?.Authorization !== `Basic ${btoa("x:local-probe-token-write")}`) throw new Error("Missing fixture write token");
      if (options.remoteRef !== `attempts/${jobID}`) throw new Error("Only the candidate branch may be published");
      const commit = await this.workspace.git.revParse({dir: this.directory, ref: "HEAD"});
      await env.COORDINATOR.getByName("global").receiveCandidate(commit, await files(this.workspace, this.directory));
      return {ok: true, error: null, refs: {}};
    };
  }
  async prepareTrial(input: AttemptInput): Promise<{prompt: string; providerConfig: unknown}> {
    const internal = this as unknown as {
      initialize(input: AttemptInput): Promise<{prompt: string}>;
      selectedModel(input: AttemptInput): OpenCodeModel;
    };
    const state = await internal.initialize(input);
    return {prompt: state.prompt, providerConfig: nativeProvider(internal.selectedModel(input), "local-probe-go")};
  }
  async configure(connection: Connection) {
    const url = new URL(connection.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || !connection.password) throw new Error("Server URL and password are required");
    await this.ctx.storage.put("trial:connection", connection);
    return {configured: true};
  }
  async configured() { return !!await this.ctx.storage.get("trial:connection"); }
  protected remoteFetch(request: Request): Promise<Response> { return fetch(request); }
  protected override async createOpenCode(options: OpenCodeWorkerd.CreateOptions): Promise<OpenCodeWorkerd.Interface> {
    const connection = await this.ctx.storage.get<Connection>("trial:connection");
    if (!connection) throw new Error("Full server is not configured");
    const lifetime = new AbortController();
    const client = OpenCode.make({
      baseUrl: connection.baseUrl,
      headers: {Authorization: `Basic ${btoa("opencode:" + connection.password)}`},
      fetch: (input, init) => {
        const request = new Request(input, init);
        return this.remoteFetch(new Request(request, {signal: AbortSignal.any([request.signal, lifetime.signal])}));
      },
    });
    const close = async () => { lifetime.abort("PentCloud client detached"); };
    const plugin = Object.assign(async () => { throw new Error("Plugins must be installed in the full server"); }, client.plugin);
    await this.ctx.storage.put("trial:opened", {agent: options.config?.default_agent, engine: "remote-full-server"});
    return {...client, sessions: client.session, events: client.event, plugin, close, [Symbol.asyncDispose]: close};
  }
  async observation() {
    let history: unknown[] = [], historyError: string | undefined;
    if (await this.ctx.storage.get("trial:opened")) {
      try { history = await this.harness.session().history(); }
      catch (error) { historyError = String(error); }
    }
    const execution = await this.execution();
    const recordedWork = execution.result ? await this.recordedWork(runID) : undefined;
    return {execution, history, historyError, recordedWork, session: this.harness.session().id,
      opened: await this.ctx.storage.get("trial:opened"), mcp: await this.ctx.storage.get("trial:mcp") ?? []};
  }
  async detach() {
    const before = await this.harness.session().history();
    await this.harness.dispose();
    const after = await this.harness.session().history();
    return {session: this.harness.session().id, before: before.length, after: after.length, preserved: JSON.stringify(before) === JSON.stringify(after)};
  }
  async mcp(request: Request): Promise<Response> {
    const internal = this as unknown as {
      cloudflareTools(): Promise<CloudflareTool[]>;
      callCloudflareTool(tool: CloudflareTool, args: unknown, id: string, signal: AbortSignal): Promise<{content: string}>;
    };
    const tool = (await internal.cloudflareTools()).find(item => item.name === "computer_read")!;
    return createMcpHandler(() => {
      const server = new McpServer({name: "pentcloud-existing-workspace", version: "1.0.0"});
      server.registerTool("computer_read", {description: tool.description, inputSchema: fromJsonSchema(tool.input as Parameters<typeof fromJsonSchema>[0]), annotations: {readOnlyHint: true}}, async (args, context) => {
        const request = context.mcpReq;
        const prior = await this.ctx.storage.get<unknown[]>("trial:mcp") ?? [];
        await this.ctx.storage.put("trial:mcp", [...prior, {requestId: request.id, metadata: request._meta ?? null, arguments: args}]);
        // The MCP request id is used only for this read. No effect is assigned
        // an invented durable tool-call identity.
        const result = await internal.callCloudflareTool(tool, args, String(request.id), request.signal);
        return {content: [{type: "text" as const, text: result.content}]};
      });
      return server;
    }).fetch(request);
  }
  async cleanupTrial() {
    await this.harness.abort().catch(() => false);
    await this.harness.dispose();
    await this.ctx.storage.deleteAlarm();
  }
}

export default {
  async fetch(request: Request, env: TrialEnv) {
    const path = new URL(request.url).pathname;
    const coordinator = env.COORDINATOR.getByName("global"), attempt = env.ATTEMPTS.getByName(jobID);
    try {
      if (path === "/health") return Response.json({ready: true});
      if (path === "/mcp") return await attempt.mcp(request);
      if (path === "/prepare" && request.method === "POST") return Response.json(await coordinator.prepareTrial((await request.json() as {scenario: Scenario}).scenario));
      if (path === "/configure" && request.method === "POST") return Response.json(await attempt.configure(await request.json() as Connection));
      if (path === "/start" && request.method === "POST") return Response.json(await coordinator.startTrial(), {status: 202});
      if (path === "/status" && request.method === "GET") return Response.json(await coordinator.statusTrial());
      if (path === "/detach" && request.method === "POST") return Response.json(await attempt.detach());
      if (path === "/cancel" && request.method === "POST") return Response.json(await coordinator.cancelRun(runID));
      if (path === "/cleanup" && request.method === "POST") return Response.json(await coordinator.cleanupTrial());
      return new Response("Not found", {status: 404});
    } catch (error) { return Response.json({error: error instanceof Error ? error.stack : String(error)}, {status: 500}); }
  },
};
