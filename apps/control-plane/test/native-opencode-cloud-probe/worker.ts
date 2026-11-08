import {DurableObject} from "cloudflare:workers";
import {OpenCode} from "@opencode/client";
import fixture, {ServerAttempt, ServerCoordinator} from "../native-opencode-server-probe/worker";
export {ServerCoordinator, WorkspaceServiceProxy, NativeDynamicWorkerTail, TargetEgress} from "../native-opencode-server-probe/worker";

type TrialEnv = ConstructorParameters<typeof ServerAttempt>[1] & {
  OPENCODE_SERVER: DurableObjectNamespace<OpenCodeCloudHost>;
  TRIAL_CONTROL_TOKEN: string;
};
type Prepared = Awaited<ReturnType<ServerCoordinator["prepareTrial"]>>;
type ProviderBody = {model?: string; stream?: boolean; messages?: Array<{role?: string; [key: string]: unknown}>;
  tools?: Array<{name?: string; function?: {name?: string}}>; [key: string]: unknown};
const VERSION = "2.2.6", PORT = 4096, ROOT = "/opt/pentcloud-opencode-trial", WORKSPACE = ROOT + "/workspace";
const CLI = ROOT + "/node_modules/.bin/opencode";
const INACTIVITY_MS = 5 * 60 * 1000, MAX_LIFETIME_MS = 30 * 60 * 1000;

/** Reuse the exact local integration fixture; only HTTP transport changes. */
export class CloudServerAttempt extends ServerAttempt {
  private readonly cloud: TrialEnv;
  constructor(ctx: DurableObjectState, env: TrialEnv) {super(ctx, env); this.cloud = env;}
  protected override remoteFetch(request: Request): Promise<Response> {
    return this.cloud.OPENCODE_SERVER.getByName("trial").fetch(request);
  }
}

/** Disposable cloud test host. No product supervisor or recovery protocol. */
export class OpenCodeCloudHost extends DurableObject<TrialEnv> {
  private server?: ExecProcess;
  private log = "";
  private releaseProvider?: () => void;
  private gate?: Promise<void>;

  constructor(ctx: DurableObjectState, env: TrialEnv) {
    super(ctx, env);
    if (ctx.container?.running) ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(INACTIVITY_MS));
  }
  private clean(value: unknown) {
    return String(value).replaceAll(this.env.TRIAL_CONTROL_TOKEN, "[redacted]")
      .replaceAll(btoa("opencode:" + this.env.TRIAL_CONTROL_TOKEN), "[redacted]");
  }
  private async phase(name: string, extra: Record<string, unknown> = {}) {
    await this.ctx.storage.put("status", {...await this.ctx.storage.get<Record<string, unknown>>("status"), phase: name, ...extra});
  }
  async boot(prepared: Prepared, origin: string) {
    if (await this.ctx.storage.get("status")) throw new Error("Use fresh trial storage for a cloud boot");
    const deadline = Date.now() + MAX_LIFETIME_MS;
    await this.ctx.storage.put("prepared", prepared);
    await this.phase("starting", {deadline, expectedVersion: VERSION, image: "cloudflare/debian-trixie", instance: "standard-1"});
    await this.ctx.storage.setAlarm(deadline);
    this.ctx.waitUntil(this.bootstrap(prepared, origin).catch(async error => {
      await this.phase("failed", {error: this.clean(error)});
      await this.ctx.container?.destroy().catch(() => undefined);
    }));
    return {started: true, deadline};
  }
  private async command(args: string[], options: ContainerExecOptions = {}) {
    const process = await this.ctx.container!.exec(args, options);
    const output = await process.output();
    const stdout = new TextDecoder().decode(output.stdout), stderr = new TextDecoder().decode(output.stderr);
    if (output.exitCode !== 0) throw new Error(`${args[0]} exited ${output.exitCode}: ${this.clean(stderr || stdout).slice(-2400)}`);
    return stdout.trim();
  }
  private async bootstrap(prepared: Prepared, origin: string) {
    const container = this.ctx.container!;
    container.start({image: "cloudflare/debian-trixie", entrypoint: ["sleep", "infinity"], instance: "standard-1", enableInternet: true});
    await container.setInactivityTimeout(INACTIVITY_MS);
    await this.phase("checking-latest");
    const latest = await this.command(["npm", "view", "@opencode/cli@latest", "version"]);
    if (latest !== VERSION) throw new Error(`Latest OpenCode is ${latest}; update the ${VERSION} fixture before continuing`);
    await this.phase("installing", {latestVersion: latest});
    await this.command(["npm", "install", "--prefix", ROOT, "--no-save", "--package-lock=false", `@opencode/cli@${latest}`]);
    const installedVersion = await this.command([CLI, "--version"]);
    if (!installedVersion.includes(VERSION)) throw new Error("Unexpected installed OpenCode version");
    await this.command(["node", "-e", "const f=require('node:fs');f.mkdirSync(process.argv[1],{recursive:true});f.writeFileSync(process.argv[1]+'/README.md','Separate full-server filesystem; not the PentCloud Durable Object workspace.\\n');", WORKSPACE]);
    const rules = [{action: "*", resource: "*", effect: "deny"},
      ...(prepared.scenario === "tool" ? [{action: "pentcloud_computer_read", resource: "*", effect: "allow"}] : [])];
    const provider = prepared.providerConfig as {settings: Record<string, unknown>};
    const config = {plugins: [], default_agent: prepared.agent, model: `${prepared.model.providerID}/${prepared.model.id}`,
      permissions: rules, agents: {build: {permissions: rules}, [prepared.agent]: {mode: "primary", system: prepared.prompt, permissions: rules}},
      providers: {[prepared.model.providerID]: {...provider, settings: {...provider.settings,
        baseURL: origin + "/__trial/provider/v1", apiKey: this.env.TRIAL_CONTROL_TOKEN, timeout: 60000}}},
      ...(prepared.scenario === "tool" ? {mcp: {servers: {pentcloud: {type: "remote", url: origin + "/mcp",
        headers: {Authorization: "Bearer " + this.env.TRIAL_CONTROL_TOKEN}, oauth: false, codemode: false, protocol: "legacy"}}}} : {})};
    const env = {XDG_CONFIG_HOME: ROOT + "/config", XDG_DATA_HOME: ROOT + "/data", XDG_STATE_HOME: ROOT + "/state", XDG_CACHE_HOME: ROOT + "/cache",
      OPENCODE_CONFIG_DIR: ROOT + "/config", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_PASSWORD: this.env.TRIAL_CONTROL_TOKEN,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), NO_COLOR: "1", TERM: "dumb"};
    await this.ctx.storage.put("serverEnv", env);
    await this.phase("starting-server", {installedVersion});
    this.server = await container.exec([CLI, "serve", "--hostname", "0.0.0.0", "--port", String(PORT), "--cors", origin], {cwd: WORKSPACE, env});
    this.ctx.waitUntil(this.consume(this.server.stdout));
    this.ctx.waitUntil(this.consume(this.server.stderr));
    const client = this.client();
    const deadline = Date.now() + 45000;
    let health;
    while (Date.now() < deadline) {
      try {health = await client.server.info({signal: AbortSignal.timeout(1500)}); break;}
      catch {await new Promise(resolve => setTimeout(resolve, 250));}
    }
    if (!health) throw new Error("OpenCode health did not become ready: " + this.log);
    await this.phase("ready", {health});
  }
  private client() {
    return OpenCode.make({baseUrl: "http://opencode.internal", headers: {Authorization: "Basic " + btoa("opencode:" + this.env.TRIAL_CONTROL_TOKEN)},
      fetch: (input, init) => this.ctx.container!.getTcpPort(PORT).fetch(new Request(input, init))});
  }
  private async consume(stream: ReadableStream | null) {
    if (!stream) return;
    const reader = stream.getReader(), decoder = new TextDecoder();
    try {for (;;) {const chunk = await reader.read(); if (chunk.done) break; this.log = this.clean(this.log + decoder.decode(chunk.value, {stream: true})).slice(-16000);}}
    finally {reader.releaseLock();}
  }
  async status() {
    return {...await this.ctx.storage.get<Record<string, unknown>>("status"), running: this.ctx.container?.running ?? false,
      provider: await this.ctx.storage.get<unknown[]>("provider") ?? [], log: this.log};
  }
  async release() {
    await this.ctx.storage.put("released", true);
    this.releaseProvider?.();
    return {released: true};
  }
  private async model(request: Request) {
    const prepared = (await this.ctx.storage.get<Prepared>("prepared"))!;
    const body = await request.json() as ProviderBody;
    const messages = body.messages ?? [];
    const primary = JSON.stringify(messages).includes("Execute the pinned specialist launch");
    const tools = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter((name): name is string => !!name);
    const toolResults = messages.filter(message => message.role === "tool");
    const observation = {model: body.model, stream: body.stream, primary, tools, toolResultCount: toolResults.length,
      hasBaselineToolResult: toolResults.some(message => JSON.stringify(message).includes(prepared.baselineText.trim())),
      ...(toolResults.length ? {toolResults} : {})};
    const prior = await this.ctx.storage.get<unknown[]>("provider") ?? [];
    await this.ctx.storage.put("provider", [...prior, observation]);
    if (primary && !await this.ctx.storage.get("released")) {
      this.gate ??= new Promise(resolve => {this.releaseProvider = resolve;});
      await this.gate;
    }
    const tool = tools.find(name => /computer_read$/.test(name));
    const callTool = primary && prepared.scenario === "tool" && !toolResults.length && tool;
    const answer = primary ? "PentCloud full-server trial completed: " + prepared.baselineText.trim() : "PentCloud full-server trial";
    const delta = callTool ? {role: "assistant", tool_calls: [{index: 0, id: "call_pentcloud_read_trial", type: "function",
      function: {name: tool, arguments: JSON.stringify({path: "README.md"})}}]} : {role: "assistant", content: answer};
    if (body.stream === false) return Response.json({id: "fixture", object: "chat.completion", model: body.model,
      choices: [{index: 0, message: delta, finish_reason: callTool ? "tool_calls" : "stop"}], usage: {prompt_tokens: 20, completion_tokens: 8, total_tokens: 28}});
    const frame = (delta: unknown, finish_reason: string | null) => "data: " + JSON.stringify({id: "fixture", object: "chat.completion.chunk", model: body.model,
      choices: [{index: 0, delta, finish_reason}]}) + "\n\n";
    return new Response(frame(delta, null) + frame({}, callTool ? "tool_calls" : "stop") + "data: [DONE]\n\n", {headers: {"Content-Type": "text/event-stream"}});
  }
  async nativeChecks() {
    const client = this.client();
    const session = await client.session.get({sessionID: "ses_root"});
    const context = await client.session.context({sessionID: "ses_root"});
    const nativeFile = new TextDecoder().decode(await client.file.read({location: {directory: WORKSPACE}, path: "README.md"}));
    const env = (await this.ctx.storage.get<Record<string, string>>("serverEnv"))!;
    const cliSessions = await this.command([CLI, "--server", `http://127.0.0.1:${PORT}`, "session", "list", "--format", "json"], {cwd: WORKSPACE, env});
    return {health: await client.server.info(), session: {id: session.id, title: session.title}, messages: context.length,
      cliSessions: JSON.parse(cliSessions), nativeFile, serverFilesystemIsSeparate: nativeFile.includes("Separate full-server filesystem")};
  }
  async stop() {
    await this.release();
    await this.ctx.container?.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.phase("stopped");
    return {stopped: !this.ctx.container?.running};
  }
  override async alarm() {
    const upload = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'trial_bundle_upload'").toArray();
    if (upload.length) {await this.ctx.storage.deleteAll(); return;}
    await this.stop();
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname.startsWith("/__trial/provider/")) return this.model(request);
    if (!this.ctx.container?.running || (await this.ctx.storage.get<{phase: string}>("status"))?.phase !== "ready")
      return new Response("Cloud trial server is not ready", {status: 503});
    return this.ctx.container.getTcpPort(PORT).fetch(request);
  }
}

export default {
  async fetch(request: Request, env: TrialEnv): Promise<Response> {
    const url = new URL(request.url), host = env.OPENCODE_SERVER.getByName("trial");
    const controlled = url.pathname.startsWith("/__trial/") || url.pathname === "/mcp";
    if (controlled && (!env.TRIAL_CONTROL_TOKEN || request.headers.get("Authorization") !== "Bearer " + env.TRIAL_CONTROL_TOKEN))
      return new Response("Unauthorized", {status: 401});
    try {
      if (url.pathname === "/__trial/boot" && request.method === "POST") {
        const scenario = (await request.json() as {scenario: "advice" | "tool" | "cancel"}).scenario;
        const prepared = await env.COORDINATOR.getByName("global").prepareTrial(scenario) as unknown as Prepared;
        await env.ATTEMPTS.getByName("job-0").configure({baseUrl: "http://opencode.internal", password: env.TRIAL_CONTROL_TOKEN});
        const started = await host.boot(prepared, url.origin);
        return Response.json({...started, prepared: {id: prepared.id, scenario, agent: prepared.agent, model: prepared.model, baselineText: prepared.baselineText}}, {status: 202});
      }
      if (url.pathname === "/__trial/host" && request.method === "GET") return Response.json(await host.status());
      if (url.pathname === "/__trial/release" && request.method === "POST") return Response.json(await host.release());
      if (url.pathname === "/__trial/native" && request.method === "GET") return Response.json(await host.nativeChecks());
      if (url.pathname === "/__trial/cleanup" && request.method === "POST") {
        try {await env.COORDINATOR.getByName("global").cleanupTrial();}
        finally {await host.stop();}
        return Response.json({cleaned: true});
      }
      if (url.pathname.startsWith("/__trial/provider/")) return host.fetch(request);
      if (url.pathname.startsWith("/__trial/")) {
        url.pathname = url.pathname.slice("/__trial".length);
        return fixture.fetch(new Request(url, request), env);
      }
      if (url.pathname === "/mcp") return fixture.fetch(request, env);
      return host.fetch(request);
    } catch (error) {
      return Response.json({error: String(error).replaceAll(env.TRIAL_CONTROL_TOKEN, "[redacted]")}, {status: 500});
    }
  },
};
