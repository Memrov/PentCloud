import {KaliFiles} from "./files";
import {toolboxFileRoot,type ToolboxFileScope,type ToolboxStockOutput,type ToolboxFile} from "../../../../shared/toolbox-files";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  TOOLBOX_GENERATION_HEADER as GENERATION_HEADER, toolboxGeneration,
  type ToolboxLifecycle, type ToolboxStatus, type ToolboxReadiness, type ToolboxActivity,
  type ToolboxFailure, type ToolboxUnavailable,
} from "../../../../shared/toolbox-rpc";

type Env = Cloudflare.Env;
const INACTIVITY_MS = 30 * 60 * 1000;
const GENERATION_LABEL = "pentcloud-gen";
const EGRESS_LABEL="pentcloud-net";
const mcpMethods = ["GET", "POST", "DELETE"];
type StartupPhase = "container_binding" | "bearer_configuration" | "stock_image_configuration" | "container_start" | "inactivity_timeout";

/** Bounded native failure text only: no stack, structured options or credentials. */
function startupDiagnostic(error: unknown, phase: StartupPhase, secret: string | undefined) {
  const names = ["Error", "TypeError", "RangeError", "InternalError", "NotSupportedError", "InvalidStateError", "SecurityError", "AbortError", "TimeoutError"];
  const errorName = error instanceof Error && names.includes(error.name) ? error.name : "Error";
  let detail = error instanceof Error ? error.message : typeof error === "string" ? error : "Unclassified native error";
  if (secret) detail = detail.split(secret).join("[redacted]");
  detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").split(/\r?\n/, 1)[0] ?? "";
  const structured = detail.search(/\{|\[(?!redacted\])/);
  if (structured !== -1) detail = detail.slice(0, structured) + "[structured detail omitted]";
  return { phase, errorName, detail: detail.slice(0, 240) };
}

function json(value: object, status = 200, generation?: string): Response {
  return Response.json(value, { status, headers: {
    "Cache-Control": "no-store",
    ...(generation ? { [GENERATION_HEADER]: generation } : {}),
    ...(status === 202 ? { "Retry-After": "2" } : {}),
  } });
}
function lost(generation?: string): Response {
  const response = json({ state: "lost", ...(generation ? { generation } : {}) }, 409, generation);
  response.headers.set("X-Pentcloud-Toolbox-Lost", "true");
  return response;
}
function mcpRequest(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("cf-access-") ||
      ["cookie", "host", "authorization", GENERATION_HEADER.toLowerCase()].includes(name.toLowerCase())) headers.delete(name);
  }
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(`http://kali.internal/mcp${new URL(request.url).search}`,
    new Request(request, { headers, redirect: "manual" }));
}

/** One shared native runtime. The Coordinator remains the only admission authority. */
export class KaliToolbox extends DurableObject<Env> implements ToolboxLifecycle {
  private lifecycleGate: Promise<void> = Promise.resolve();
  private timeoutSetup: Promise<void> | undefined;
  private intercepts:Promise<void>|undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (ctx.container?.running) {
      // The native setting must be restored after DO restart. No monitor,
      // renewal timer or cleanup alarm keeps the object/container alive.
      ctx.waitUntil(this.ensureTimeout().catch(error => {
        console.error("pentcloud.toolbox.runtime_unavailable", { operation: "constructor", ...startupDiagnostic(error, "inactivity_timeout", this.env.KALI_MCP_TOKEN) });
      }));
    }
  }
  private get container(): Container {
    if (!this.ctx.container) throw new Error("Native toolbox container is not configured");
    return this.ctx.container;
  }
  private ensureTimeout(): Promise<void> {
    if (!this.timeoutSetup) {
      const setup: Promise<void> = Promise.resolve().then(() => this.container.setInactivityTimeout(INACTIVITY_MS)).catch(error => {
        if (this.timeoutSetup === setup) this.timeoutSetup = undefined;
        throw error;
      });
      this.timeoutSetup = setup;
    }
    return this.timeoutSetup;
  }
  private async current(): Promise<{ running: boolean; generation?: string }> {
    const container = this.container;
    if (!container.running) return { running: false };
    const info = await container.inspect();
    if (!container.running || !info) return { running: false };
    const generation = info.labels[GENERATION_LABEL];
    return { running: true, ...(generation ? { generation } : {}) };
  }
  private async installOutbound(generation:string){
    if(this.intercepts)return this.intercepts;
    const work=(async()=>{const worker=this.ctx.exports.KaliOutbound({props:{generation}});await this.container.interceptAllOutboundHttp(worker);await this.container.interceptOutboundHttps("*",worker);})();
    this.intercepts=work;try{await work;}catch(error){if(this.intercepts===work)this.intercepts=undefined;throw error;}
  }
  private async start(image: string): Promise<string> {
    this.timeoutSetup = undefined;
    this.intercepts=undefined;
    const generation = crypto.randomUUID();
    this.container.start({
      image,
      instance: { vcpu: 2, memoryMib: 6144, diskMb: 20000 },
      enableInternet: false,
      labels: { [GENERATION_LABEL]: generation,[EGRESS_LABEL]:"managed-v1" },
      env: {
        PENTCLOUD_KALI_TOKEN: this.env.KALI_MCP_TOKEN,
        MCP_GATEWAY_TOKEN_FILE: "/tmp/pentcloud-mcp-token",
        MCP_GATEWAY_USE_TLS: "false",
        SSL_CERT_FILE:"/etc/ssl/certs/ca-certificates.crt",
        CURL_CA_BUNDLE:"/etc/ssl/certs/ca-certificates.crt",
        REQUESTS_CA_BUNDLE:"/etc/ssl/certs/ca-certificates.crt",
        NODE_EXTRA_CA_CERTS:"/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      },
      // Preserve the exact image/entrypoint and inherited OCI PATH. Supply the
      // runtime-only bearer through the stock secret-file contract.
      entrypoint: ["/bin/bash", "-c", 'umask 077; for i in {1..100}; do [ -s /etc/cloudflare/certs/cloudflare-containers-ca.crt ] && break; sleep 0.1; done; test -s /etc/cloudflare/certs/cloudflare-containers-ca.crt || exit 78; cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/pentcloud-outbound.crt; update-ca-certificates >/dev/null 2>&1 || exit 78; printf %s "$PENTCLOUD_KALI_TOKEN" > /tmp/pentcloud-mcp-token; unset PENTCLOUD_KALI_TOKEN; exec /usr/bin/tini -g -- /opt/kali-mcp/bin/entrypoint.sh'],
    });
    // Native interception readiness can await the running controller. Internet
    // stays disabled while startup waits for its injected CA certificate.
    await this.installOutbound(generation);
    return generation;
  }
  /** Serialize inspection/start through dispatch; upstream responses never hold this gate. */
  private async serialized<T>(operation: string, run: (scope: {release(): void; phase?: StartupPhase}) => Promise<T>): Promise<T | ToolboxUnavailable> {
    const previous = this.lifecycleGate;
    let release!: () => void;
    this.lifecycleGate = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const scope: {release(): void; phase?: StartupPhase} = {release};
    try { return await run(scope); }
    catch (error) {
      console.error("pentcloud.toolbox.runtime_unavailable", {
        operation,
        ...(scope.phase ? startupDiagnostic(error, scope.phase, this.env.KALI_MCP_TOKEN) : {}),
      });
      return {error: "unavailable"};
    } finally { release(); }
  }
  async status(): Promise<ToolboxStatus | ToolboxUnavailable> {
    return this.serialized("status", async scope => {
      scope.phase = "container_binding";
      const current = await this.current();
      return {state: current.running ? "running" : "stopped", ...(current.generation ? {generation: current.generation} : {}), inactivityTimeoutMs: INACTIVITY_MS};
    });
  }
  async clear():Promise<{state:"stopped"}|ToolboxUnavailable> {
    return this.serialized("clear",async()=>{
      if(this.container.running)await this.container.destroy();
      if(this.container.running)throw new Error("Container cleanup has not finished");
      this.timeoutSetup=undefined;
      this.intercepts=undefined;
      return {state:"stopped" as const};
    });
  }
  async ready(expectedGeneration?: string): Promise<ToolboxReadiness | ToolboxFailure> {
    if (expectedGeneration !== undefined && !toolboxGeneration(expectedGeneration)) return {error: "generation_lost"};
    return this.serialized("ready", async scope => {
      scope.phase = "container_binding";
      // A pinned request is recovery, never permission to replace a runtime.
      if (!this.container.running && expectedGeneration !== undefined) return {error: "generation_lost"};
      if (!this.container.running) {
        scope.phase = "bearer_configuration";
        if (typeof this.env.KALI_MCP_TOKEN !== "string" || this.env.KALI_MCP_TOKEN.length < 16)
          throw new Error("Native toolbox bearer is missing or shorter than the stock minimum");
        scope.phase = "stock_image_configuration";
        const image = this.container.images?.stock;
        if (typeof image !== "string" || !image) throw new Error("Named stock image is unavailable");
        scope.phase = "container_start";
        const generation = await this.start(image);
        scope.phase = "inactivity_timeout";
        await this.ensureTimeout();
        return {state: "booting", generation};
      }
      const current = await this.current();
      if (!current.running || !current.generation || (expectedGeneration !== undefined && expectedGeneration !== current.generation))
        return {error: "generation_lost", ...(current.generation ? {generation: current.generation} : {})};
      scope.phase = "inactivity_timeout";
      await this.ensureTimeout();
      try {
        // Transport-only readiness creates no MCP session or tool mutation.
        const pending = this.container.getTcpPort(8081).fetch("http://kali.internal/mcp", {
          method: "GET", headers: { Authorization: `Bearer ${this.env.KALI_MCP_TOKEN}`, Accept: "application/json, text/event-stream" },
          signal: AbortSignal.timeout(2000), redirect: "manual",
        });
        scope.release();
        const response = await pending;
        await response.body?.cancel();
        if ([200, 204, 400, 405, 406].includes(response.status)) return {state: "ready", generation: current.generation};
        if ([401, 403].includes(response.status)) return {error: "unavailable"};
      } catch { /* Cold startup can outlive a short readiness poll. */ }
      return {state: "booting", generation: current.generation};
    });
  }
  async activity(generation: string): Promise<ToolboxActivity | ToolboxFailure> {
    if (!toolboxGeneration(generation)) return {error: "generation_lost"};
    return this.serialized("activity", async scope => {
      scope.phase = "container_binding";
      const current = await this.current();
      if (!current.running || !current.generation || generation !== current.generation)
        return {error: "generation_lost", ...(current.generation ? {generation: current.generation} : {})};
      scope.phase = "inactivity_timeout";
      await this.ensureTimeout();
      // Receiving the RPC is native activity; no timer or monitor renews it.
      return {state: "running", generation: current.generation};
    });
  }
  async configureAccess(generation:string,attempt:string):Promise<void>{
    if(!toolboxGeneration(generation)||!/^[a-f0-9]{64}$/.test(attempt))throw new Error("Invalid target access owner");
    const current=await this.current(),info=current.running?await this.container.inspect():undefined;
    if(current.generation!==generation||info?.labels[EGRESS_LABEL]!=="managed-v1")throw new Error("409: Drain and restart the legacy Kali generation before using managed target access");
    await this.installOutbound(generation);await this.ctx.storage.put("egress:owner",{generation,attempt});
  }
  async outbound(generation:string,request:Request):Promise<Response>{
    const current=await this.current(),owner=await this.ctx.storage.get<{generation:string;attempt:string}>("egress:owner");
    if(!current.running||current.generation!==generation||owner?.generation!==generation||!this.env.TARGET_EGRESS)return new Response("No active target access",{status:403});
    const headers=new Headers(request.headers);headers.set("X-Pentcloud-Egress-Attempt",owner.attempt);
    return this.env.TARGET_EGRESS.fetch(new Request(request,{headers,redirect:"manual"}));
  }
  private readonly files=new KaliFiles(()=>this.container,async scope=>{
    toolboxFileRoot(scope);
    const current=await this.current();
    if(!current.running||current.generation!==scope.generation)throw new Error("409: File transfer generation lost");
    await this.ensureTimeout();
  });
  async putFile(scope:ToolboxFileScope,file:ToolboxFile,body:ReadableStream<Uint8Array>){return this.files.put(scope,file,body);}
  async listFiles(scope:ToolboxFileScope,stock?:ToolboxStockOutput){return this.files.list(scope,stock);}
  async getFile(scope:ToolboxFileScope,path:string,stock?:ToolboxStockOutput){return this.files.get(scope,path,stock);}
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://toolbox.internal" || url.pathname !== "/mcp" || (url.search && url.search !== "?codemode=false")) return new Response("Not found", {status: 404});
    if (!mcpMethods.includes(request.method)) return new Response("Method not allowed", {status: 405});
    const result = await this.serialized("/mcp", async scope => {
      const current = await this.current();
      if (!current.running || !current.generation || request.headers.get(GENERATION_HEADER) !== current.generation) return lost(current.generation);
      scope.phase = "inactivity_timeout";
      await this.ensureTimeout();
      scope.phase = undefined;
      // No retry, implicit start, protocol parsing or response buffering. A lost
      // mutation response remains the application's durable unknown receipt.
      const pending = this.container.getTcpPort(8081).fetch(mcpRequest(request, this.env.KALI_MCP_TOKEN));
      scope.release();
      const response = await pending;
      const headers = new Headers(response.headers);
      headers.delete("X-Pentcloud-Toolbox-Lost");
      headers.set(GENERATION_HEADER, current.generation);
      return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
    });
    return result instanceof Response ? result : json({state: "unavailable"}, 503);
  }
}

function toolbox(env: Env) {
  return env.KALI_TOOLBOX.get(env.KALI_TOOLBOX.idFromName("shared"));
}

/** A service-binding capability; never selected by the public default handler. */
export class ToolboxGateway extends WorkerEntrypoint<Env> implements ToolboxLifecycle {
  async configureAccess(generation:string,attempt:string):Promise<void>{return toolbox(this.env).configureAccess(generation,attempt);}
  async clear():Promise<{state:"stopped"}|ToolboxUnavailable>{return toolbox(this.env).clear();}
  async status(): Promise<ToolboxStatus | ToolboxUnavailable> { return toolbox(this.env).status(); }
  async ready(expectedGeneration?: string): Promise<ToolboxReadiness | ToolboxFailure> { return toolbox(this.env).ready(expectedGeneration); }
  async activity(generation: string): Promise<ToolboxActivity | ToolboxFailure> { return toolbox(this.env).activity(generation); }
  async putFile(scope:ToolboxFileScope,file:ToolboxFile,body:ReadableStream<Uint8Array>){return toolbox(this.env).putFile(scope,file,body);}
  async listFiles(scope:ToolboxFileScope,stock?:ToolboxStockOutput){return toolbox(this.env).listFiles(scope,stock);}
  async getFile(scope:ToolboxFileScope,path:string,stock?:ToolboxStockOutput){return toolbox(this.env).getFile(scope,path,stock);}
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://toolbox.internal" || url.pathname !== "/mcp" || (url.search && url.search !== "?codemode=false")) return new Response("Not found", {status: 404});
    if (!mcpMethods.includes(request.method)) return new Response("Method not allowed", {status: 405});
    if (!request.headers.get(GENERATION_HEADER)) return lost();
    return toolbox(this.env).fetch(request);
  }
}

export class KaliOutbound extends WorkerEntrypoint<Env,{generation:string}> {
  override fetch(request:Request):Promise<Response>{return toolbox(this.env).outbound(this.ctx.props.generation,request);}
}

// All runtime capabilities are exposed only through ToolboxGateway bindings.
// Even an accidentally enabled HTTP route cannot accept an operator/MCP key.
export default {
  async fetch(): Promise<Response> { return new Response("Not found", {status:404}); },
} satisfies ExportedHandler<Env>;
