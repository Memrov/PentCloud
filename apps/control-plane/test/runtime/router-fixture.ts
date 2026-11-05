import { DurableObject } from "cloudflare:workers";
import worker from "../../src/native/worker";

// Test only: the real router and signed auth see a narrow lifecycle RPC fixture.
export default {fetch(request:Request,env:RuntimeFixtureEnv){
  const coordinator=env.COORDINATOR.getByName("global");
  return worker.fetch(request,{...env,TOOLBOX:{
    async status(){await coordinator.noteRemote("toolboxStatus","[]");return {state:"stopped",inactivityTimeoutMs:1800000};},
    async ready(generation?:string){await coordinator.noteRemote("toolboxReady",JSON.stringify([generation??null]));return generation?{error:"generation_lost"}:{state:"booting",generation:"fixture-generation"};},
  }} as unknown as Parameters<typeof worker.fetch>[1]);
}};
export { ResultValidation } from "../../src/native/worker";
export interface RuntimeFixtureEnv {
  COORDINATOR: DurableObjectNamespace<RouterControl>;
  ATTEMPTS: DurableObjectNamespace<RouterAttempt>;
  RESULTS: Workflow<unknown>;
  CONTROL_TOKEN: string;
  OPENCODE_GO_API_KEY: string;
}
export interface RecordedCall {
  method: string;
  args: unknown[];
}
const run = {
  id: "run-1",
  status: "running",
  baselineRepo: "fixture-repo",
  inputCommit: "a".repeat(40),
  maxDepth: 4,
  maxJobs: 32,
};
const job = {
  id: "job-1",
  runId: run.id,
  role: "primary",
  tool: "primary",
  status: "running",
  revision: 2,
};

/** Service contract fixture: real platform RPC and SQL, no duplicated Coordinator logic. */
export class RouterControl extends DurableObject<RuntimeFixtureEnv> {
  constructor(ctx: DurableObjectState, env: RuntimeFixtureEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS calls (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  private record(method: string, ...args: unknown[]) {
    this.ctx.storage.sql.exec(
      "INSERT INTO calls(value) VALUES (?)",
      JSON.stringify({ method, args }),
    );
  }
  async calls(): Promise<string> {
    return JSON.stringify(
      this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM calls ORDER BY sequence")
        .toArray()
        .map((row) => JSON.parse(row.value) as RecordedCall),
    );
  }
  async onboardingSnapshot(runId?:string){this.record("onboardingSnapshot",runId);return {targets:[],credentials:[],defaults:[]};}
  async onboardingExport(){this.record("onboardingExport");return {version:1,targets:[],credentials:[],setups:[]};}
  async onboardingAction(action:string,value:Record<string,unknown>,actor:string){this.record("onboardingAction",action,value,actor);return {id:value.id,version:1};}
  async activateAnalysis(id:string,revision:number,requestId:string,ack:boolean){this.record("activateAnalysis",id,revision,requestId,ack);return {run,rootJob:job};}
  async modelCatalog(){return {models:[{id:"opencode-go:deepseek-v4-pro",reasoningEfforts:["default"]}],fetchedAt:new Date(0).toISOString(),stale:false};}
  async clearCalls() {
    this.ctx.storage.sql.exec("DELETE FROM calls");
  }
  async listRuns() {
    this.record("listRuns");
    return { runs: [run] };
  }
  async assertJobAvailable(id:string,mutable=false) {
    if(id==="purged")throw new Error("409: attempt was permanently purged");
    return {runId:run.id,...(id==="discovery"?{executionKind:"discovery"}:{})};
  }
  async lifecycleStatus(){this.record("lifecycleStatus");return {safeToUninstall:true};}
  async prepareUninstall(){this.record("prepareUninstall");return {safeToUninstall:true,quiesced:true};}
  async archiveRun(id:string){this.record("archiveRun",id);return {run:{...run,lifecycle:"archived"}};}
  async trashRun(id:string){this.record("trashRun",id);return {run:{...run,lifecycle:"trashed"}};}
  async restoreRun(id:string){this.record("restoreRun",id);return {run:{...run,lifecycle:"active"}};}
  async purgeRun(id:string,confirm:string){this.record("purgeRun",id,confirm);if(id!==confirm)throw new Error("400: confirmation mismatch");return {runId:id,deleted:true};}
  async report(id:string,job?:string){this.record("report",id,job);return new Response("# Accepted report",{headers:{"Content-Type":"text/markdown;charset=utf-8"}});}
  async createRun(value: unknown) {
    this.record("createRun", value);
    return { run, rootJob: job };
  }
  async stageUpload(input: {runId:string;id:string;name:string;sha256:string;body:ReadableStream<Uint8Array>;uploadedBy:string}) {
    const {body,...metadata}=input;
    this.record("stageUpload",{...metadata,text:await new Response(body).text()});
    return {...metadata,size:6,mediaType:"text/plain",kind:"text",status:"ready",sourcePath:".pentagi/materials/source",textPath:".pentagi/materials/source"};
  }
  async files(runId:string,jobId?:string) {
    this.record("files",runId,jobId);
    return {runId,commit:"a".repeat(40),files:[]};
  }
  async file(runId:string,commit:string,path:string,preview:boolean) {
    this.record("file",runId,commit,path,preview);
    if(commit!=="a".repeat(40))throw new Error("404: file commit is not accepted by this run");
    return new Response("<script>inert file</script>",{headers:{"Content-Type":"text/plain;charset=utf-8"}});
  }
  async queueSnapshot() {
    this.record("queueSnapshot");
    return { active: job.id, waiting: [], capacity: 3 };
  }
  async diagnostics() {
    this.record("diagnostics");
    return {coordinator: {}, backlog: {waiting: 0, oldestWaitingMs: 0}};
  }
  async rearmPlatformRecovery(value: {scope: string; observedAt: number; attemptId?: string}) {
    this.record("rearmPlatformRecovery", value);
    if (value.observedAt === 999) throw new Error("409: platform recovery marker changed");
    return {rearmed: true};
  }
  async settings() {
    this.record("settings");
    return { casRevision: 3, locked: false, blockingRunIds: [] };
  }
  async saveSettings(roles: unknown, revision: number, actor: string) {
    this.record("saveSettings", roles, revision, actor);
    if (revision === 999)
      throw new Error("409: fixture settings revision conflict");
    return { casRevision: revision + 1, locked: false, blockingRunIds: [] };
  }
  async getRun(id: string) {
    this.record("getRun", id);
    if (id === "missing") throw new Error("404: fixture run not found");
    if (id === "error")
      throw new Error(
        `409: fixture rejected ${this.env.CONTROL_TOKEN} ${this.env.OPENCODE_GO_API_KEY}`,
      );
    if (id === "unavailable") throw new Error("503: fixture unavailable");
    return { run, jobs: [job] };
  }
  async cancelRun(id: string) {
    this.record("cancelRun", id);
    return { cancelled: true };
  }
  async interrupt(id: string) {
    this.record("interrupt", id);
    return { interrupted: true };
  }
  async steer(id: string, message: string) {
    this.record("steer", id, message);
    return { steered: true };
  }
  async revise(id: string, instructions: string, requestId: string, parentId?: string, uploads?: string[]) {
    if (uploads) this.record("revise", id, instructions, requestId, parentId, uploads);
    else this.record("revise", id, instructions, requestId);
    if (requestId === "conflict")
      throw new Error("409: fixture immutable revision request conflict");
    return {
      job: { ...job, id: "job-revision", revisionOf: id, status: "created" },
    };
  }
  async stream(id: string, request: Request) {
    this.record(
      "stream",
      id,
      request.url,
      request.headers.get("Last-Event-ID"),
    );
    return new Response(
      `id: 5\nevent: activity\ndata: ${JSON.stringify({ instanceId: id, eventId: 5, timestamp: 1000, type: "run.started" })}\n\n`,
      {
        headers: {
          "Content-Type": "text/event-stream",
          "X-Fixture-Stream": "activity",
        },
      },
    );
  }
  async noteRemote(method: string, payload: string) {
    this.record(method, ...(JSON.parse(payload) as unknown[]));
  }
  async reconcileToolOutcome(id: string) {
    this.record("reconcileToolOutcome", id);
    return { reconciling: true };
  }
  async reconcile(repoName: string, ref: string, commit: string) {
    this.record("reconcile", repoName, ref, commit);
    return { accepted: true };
  }
  override async fetch(request: Request) {
    this.record("fetch", request.url, request.headers.get("Upgrade"));
    if (new URL(request.url).searchParams.has("fixture-error"))
      throw new Error(`503: fixture fetch failed ${this.env.CONTROL_TOKEN}`);
    return Response.json({
      routed: "coordinator",
      pathname: new URL(request.url).pathname,
    });
  }
}

export class RouterAttempt extends DurableObject<RuntimeFixtureEnv> {
  async browserLiveView() {
    await this.env.COORDINATOR.getByName("global").noteRemote("browserLiveView", "[]");
    return {available: true, readOnly: true, expiresAt: Date.now() + 60_000, url: "https://live.browser.run/ui/view?wss=fixture-readonly-bearer"};
  }
  async sessionControls() {
    await this.env.COORDINATOR.getByName("global").noteRemote("sessionControls", "[]");
    return { session: "ses_root", canReply: true, forms: [], permissions: [], usage: {stats: {steps: 2}, limits: null, limitsStatus: "not-connected"} };
  }
  async replyNative(kind: string, id: string, input: unknown, cancel = false) {
    await this.env.COORDINATOR.getByName("global").noteRemote("replyNative", JSON.stringify([kind, id, input, cancel]));
    if (id.endsWith("stale")) throw new Error("409: native request is no longer pending");
    return {replied: true};
  }
  async remoteReceipts() {
    await this.env.COORDINATOR.getByName("global").noteRemote(
      "remoteReceipts",
      "[]",
    );
    return [{ id: "call-1.0", tool: "nmap_scan", state: "unknown" }];
  }
  async inspectRemote(tool: string, args: Record<string, unknown>) {
    await this.env.COORDINATOR.getByName("global").noteRemote(
      "inspectRemote",
      JSON.stringify([tool, args]),
    );
    if (tool === "forbidden") throw new Error("403: fixture inspector denied");
    return { status: "completed", scan_id: args.scan_id };
  }
  async reconcileRemote(
    receiptId: string,
    input: { inspectionTool: string; scanId: string },
  ) {
    await this.env.COORDINATOR.getByName("global").noteRemote(
      "reconcileRemote",
      JSON.stringify([receiptId, input]),
    );
    if (input.scanId === "mismatch")
      throw new Error("409: fixture proof mismatch");
    if (input.scanId === "unknown") return { reconciled: false };
    return { reconciled: true, receiptId };
  }
  async controlRemote(
    tool: string,
    args: Record<string, unknown>,
    requestId: string,
  ) {
    await this.env.COORDINATOR.getByName("global").noteRemote(
      "controlRemote",
      JSON.stringify([tool, args, requestId]),
    );
    if (args.job_id === "unowned")
      throw new Error(
        "403: fixture remote control does not belong to this attempt",
      );
    if (args.job_id === "pending")
      return {
        controlled: true,
        verified: false,
        settled: false,
        receiptIds: ["call-owned"],
      };
    if (args.job_id === "invalid-result") return { controlled: true };
    return {
      controlled: true,
      verified: true,
      settled: args.job_id !== "other-held",
      receiptIds: ["call-owned"],
    };
  }
  async events(request: Request) {
    if (new URL(request.url).pathname.includes("/missing/"))
      return new Response("Attempt not initialized", { status: 404 });
    return new Response(
      `id: 8\nevent: session\ndata: ${JSON.stringify({ id: "evt_fixture", type: "session.execution.started", created: 1000, data: { sessionID: "ses_fixture" }, durable: { seq: 8 } })}\n\n`,
      {
        headers: {
          "Content-Type": "text/event-stream",
          "X-Fixture-Cursor": request.headers.get("Last-Event-ID") ?? "",
          "X-Fixture-Url": request.url,
        },
      },
    );
  }
  async inspect() {
    return { sessionId: "ses_fixture", busy: true, messages: [] };
  }
}
