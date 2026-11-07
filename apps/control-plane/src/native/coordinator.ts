import {readFindings} from "./findings";
import {modelSecretMetadata,readModelSecret,plainModelSecretValues} from "./model-secrets";
import {assertEvidencePreserved,validateEvidenceCheckpoint,evidenceRoot,type EvidenceCheckpoint} from "./evidence";
import {discoveryOutcome} from "./discovery";
import {assertRecordedWorkAccess,recordedWorkPage,type RecordedWorkPage} from "./recorded-work";
import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome, type MemoryLimitContext } from "agents/lifecycle";
import { Scheduler } from "agents/schedules";
import { Streams, sseResponse, type StreamWriter } from "agents/streams";
import {
  assertRoleWrite,
  catalogForRole,
  supportedOptionalTools,
  validateToolInput,
  confinedRelative,
  redact,
} from "./tool-policy";
import { State } from "agents/state";
import { WebSockets } from "agents/websockets";
import {
  ACTIVE_ROLES,
  createAgentSettings,
  defaultAgentSettings,
  managedRoleSettings,
  type AgentSettings,
  type RoleSettings,
} from "../settings/catalog";
import { specialistSources } from "./specialist-sources";
import { memoryRecovery, recoveryPending, runtimeVersion, type RuntimeRecovery } from "./runtime-diagnostics";
import { knownRuntimeSecrets } from "../../../../shared/runtime-secrets";
import { TargetDefinitions, type TargetDefinition } from "./target-definitions";
import { OnboardingStore, assertAudience, type SetupDraft, type SavedTarget } from "./onboarding";
import {ScopeCatalog} from "./scope-catalog";
import {targetAccessBrief,readTargetSecret,type ScopedTarget} from "../../../../shared/target-access";
import {LoginChallenges,type VerificationDelivery} from './login-challenge';
import {agentMailAddress,readAgentMail} from './agentmail-verification';
import {verificationAddress} from './target-verification';
import {BountyConnections,platformBinding,platformToken,checkProgramAccess} from './bounty-platform';
import type {BountyPlatform} from '../../../../shared/bounty-connections';
import {type BrowserAuthState} from "./browser-target-access";
import {RunBrowserAuth} from "./run-browser-auth";
import {SourceLibrary,readSource,type ImportReceipt} from "./source-context";
import {parseByokProviders,type OpenCodeRoute} from "./opencode-models";
import type { NewRunInput } from "./types";
import { MaterialStore, type StageMaterialInput } from "./material-store";
import { materialHash, normalizeUploadIds, selectionManifest, type MaterialSelection, type RunFiles, type RunFile } from "./materials";
import {
  assertAdmission,
  assertCompletion,
  canonical,
  digest,
  identifier,
  outstanding,
  publicJob,
  publicRun,
  terminal,
} from "./domain";
import type {
  AttemptInput,
  AttemptRecord,
  AttemptResult,
  NativeEnv,
  Role,
  RunRecord,
} from "./types";

type Activity = {
  instanceId: string;
  eventId: number;
  timestamp: number;
  type: string;
  stepName?: string;
  jobId?: string;
  error?: { name: string; message: string };
};
type ActiveReceipt = { id: string; input: AttemptInput };
type Publication = { runId: string; commit: string; attempt?: string; inputRef?: string };
type InputPreparation = {jobId:string;runId:string;baseCommit:string;selection:MaterialSelection;uploadIds:string[];branch:string;commit?:string};
type PurgeIntent = {runId:string;repo:string;jobIds:string[]};
type Execution = {
  evidence?:EvidenceCheckpoint;
  state: "absent" | "running" | "settled" | "cancelled";
  result?: AttemptResult;
  drained: boolean;
  unresolvedRemote?: number;
  sessionCleanupPending?: boolean;
  recovery?: RuntimeRecovery;
};
type ConversationPreparation={input:AttemptInput;status:"pending"|"ready"|"stopped"};
type AttemptStub = {
  recordedWork(runId:string,offset?:number):Promise<RecordedWorkPage>;
  prepareConversation(input:AttemptInput):Promise<void>;
  run(input: AttemptInput): Promise<AttemptResult>;
  execution(): Promise<Execution>;
  purgeReadiness(runId:string): Promise<{drained:boolean;unresolvedRemote:number;sessionCleanupPending:boolean}>;
  cancel(): Promise<void>;
  purge(runId: string): Promise<{purged:true}>;
  rearmPlatformRecovery(observedAt: number): Promise<{ rearmed: true }>;
};
const delegateRoles: Record<string, Role> = {
  advice: "adviser",
  coder: "coder",
  maintenance: "maintenance",
  memorist: "memorist",
  pentester: "pentester",
  search: "searcher",
};
const RECOVERY_JOB_ID = "pentcloud:recover";
const RECOVERY_HEARTBEAT_MS = 15_000;
const identity = { name: "PentCloud", email: "pentcloud@invalid" };

/** One admission authority for the one shared toolbox; session data lives in attempts. */
export class Coordinator extends DurableObject<NativeEnv> {
  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    defaultGitIdentity: identity,
    artifacts: { binding: this.env.ARTIFACTS },
  });
  private readonly materials = new MaterialStore({
    fs: this.workspace.fs,
    get: <T>(key:string) => this.get<T>(key),
    put: (key,value) => this.put(key,value),
    ...(this.env.AI ? {convert: async (input: {name:string;blob:Blob}) => {
      const raw: unknown = await this.env.AI.toMarkdown(input);
      const value = (Array.isArray(raw) ? raw[0] : raw) as {format:string;data?:string;error?:string;mimetype?:string};
      return value;
    }} : {}),
  });
  private readonly definitionMaterials=new MaterialStore({ownerKind:"target-definition",fs:this.workspace.fs,get:<T>(key:string)=>this.get<T>(key),put:(key,value)=>this.put(key,value)});
  private definitionBusy=0;
  private readonly definitions=new TargetDefinitions({
    get:<T>(key:string)=>this.get<T>(key),put:(key,value)=>this.put(key,value),materials:this.definitionMaterials,runMaterials:this.materials,
    read:async path=>this.workspace.fs.readFile(path),
    validate:id=>{this.assertAdmissionOpen();if(this.onboarding.target(id).kind!=="api")throw new Error("409: Choose an API target");},
  });
  private readonly onboarding = new OnboardingStore({
    get:<T>(key:string)=>this.get<T>(key),put:(key,value)=>this.put(key,value),list:<T>(prefix:string)=>this.list<T>(prefix),
    remove:key=>{this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",key);},
    modelBindings:()=>modelSecretMetadata(this.env),readModelSecret:id=>readModelSecret(this.env,id),
    readTargetSecret:async binding=>{const secret=await readTargetSecret(this.env,binding);this.targetSecretRedactions.push(secret);return secret;},
    byokProviders:()=>parseByokProviders(this.env.OPENCODE_BYOK_PROVIDERS),
    probe:(model,key)=>this.env.MODEL_TESTS.getByName(crypto.randomUUID()).probeModel(model,key),
  });
  private readonly scopeCatalog=new ScopeCatalog({get:<T>(key:string)=>this.get<T>(key),put:(key,value)=>this.put(key,value)});
  private readonly bountyConnections=new BountyConnections(this.env,{get:<T>(key:string)=>this.get<T>(key),put:(key,value)=>this.put(key,value),remove:key=>this.ctx.storage.sql.exec('DELETE FROM native_records WHERE key=?',key)});
  private readonly targetSecretRedactions:string[]=[];
  private readonly sources=new SourceLibrary({
    artifacts:this.env.ARTIFACTS,get:<T>(key:string)=>this.get<T>(key),put:(key,value)=>this.put(key,value),
    target:id=>this.onboarding.target(id),save:(id,revision,sources,actor)=>this.onboarding.saveSources(id,revision,sources,actor),
    assertOpen:()=>this.assertAdmissionOpen(),
  });
  readonly view: State<{
    revision: number;
    runs: ReturnType<typeof publicRun>[];
    jobs: ReturnType<typeof publicJob>[];
    purgedRunIds: string[];
  }> = new State<{
    revision: number;
    runs: ReturnType<typeof publicRun>[];
    jobs: ReturnType<typeof publicJob>[];
    purgedRunIds: string[];
  }>({
    initialState: { revision: 0, runs: [], jobs: [], purgedRunIds: [] },
    onChanged: (): void => {
      this.webSockets.broadcastState();
    },
  });
  readonly webSockets: WebSockets = new WebSockets({
    state: this.view,
    readonly: () => true,
  });
  readonly scheduler = new Scheduler({
    callbacks: {
      expireVerification: async () => { this.loginChallenges.expire();await this.scheduleVerificationExpiry(); },
    },
  });
  readonly streams = new Streams();
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.scheduler)
    .use(this.view)
    .use(this.webSockets);
  private readonly launched = new Set<string>();
  private recovering: Promise<void> | undefined;
  private readonly initializing = new Map<
    string,
    Promise<{ repo: string; remote: string; head: string }>
  >();
  private readonly creations = new Map<string, number>();
  private readonly projections = new Map<string, Promise<void>>();
  private readonly acceptances = new Map<
    string,
    {
      value: string;
      promise: Promise<{ accepted: boolean; duplicate?: boolean }>;
    }
  >();
  private readonly uploads = new Map<string, number>();
  private readonly purges = new Map<string, Promise<{runId:string;deleted:true}>>();
  constructor(ctx: DurableObjectState, env: NativeEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS native_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS native_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS native_activity_run ON native_activity(run_id,id)");
  }
  private get<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM native_records WHERE key = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private put(key: string, value: unknown) {
    if(key.startsWith("run:")&&value&&typeof value==="object"){const run=value as RunRecord;if(["completed","cancelled"].includes(run.phase)||(run.lifecycle??"active")!=="active"){this.browserAuth.clear(run.id);this.loginChallenges.clear(run.id);this.emailWaiters.get(run.id)?.forEach(wake=>wake());}}
    if(key.startsWith('onboarding:target:'))this.loginChallenges.clear('setup:'+key.slice('onboarding:target:'.length));
    this.ctx.storage.sql.exec(
      "INSERT INTO native_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  private list<T>(prefix: string): T[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM native_records WHERE key LIKE ? ORDER BY key",
        `${prefix}%`,
      )
      .toArray()
      .map((r) => JSON.parse(r.value) as T);
  }
  private jobs(runId?: string) {
    return this.list<AttemptRecord>("job:").filter(
      (j) => !runId || j.runId === runId,
    );
  }
  private run(id: string) {
    if(this.get(`purged:run:${identifier(id)}`))throw new Error("409: run was permanently purged");
    const r = this.get<RunRecord>(`run:${identifier(id)}`);
    if (!r) throw new Error("404: run not found");
    return r;
  }
  private job(id: string) {
    if(this.get(`purged:job:${identifier(id)}`))throw new Error("409: attempt was permanently purged");
    const j = this.get<AttemptRecord>(`job:${identifier(id)}`);
    if (!j) throw new Error("404: attempt not found");
    return j;
  }
  private async start() {
    await this.lifecycle.start();
  }
  async onStart() {
    // Retire the old heartbeat through Scheduler's public migration surface.
    for (const schedule of await this.scheduler.list())
      if (schedule.callback === "recover") await this.scheduler.cancel(schedule.id);
    // Preserve a pending native backoff across restart instead of pulling it forward.
    if (!this.lifecycle.jobs.get(RECOVERY_JOB_ID)) await this.wake();
    await this.publish();
  }
  onJob({ job }: LifecycleJobContext): LifecycleJobOutcome {
    if (job.id !== RECOVERY_JOB_ID || job.fn !== "recover") return;
    const recovery = this.get<RuntimeRecovery>("platform:recovery");
    if (recovery?.sealed) return;
    if ((recovery?.nextTime ?? 0) > Date.now())
      return { rescheduleAt: recovery!.nextTime! };
    // Native singleflight ends at dispatch return. Keep only this in-memory
    // guard for the long handoff; the native heartbeat survives its eviction.
    if (!this.recovering) {
      const work = this.recover();
      this.recovering = work;
      // Track the rejecting promise before diagnostic handling masks an OOM.
      this.lifecycle.trackAlarmWork(work);
      this.ctx.waitUntil(work.catch(async error => {
        try { this.activity(await this.activityWriter("coordinator"), "coordinator", "recovery.failed", undefined, undefined, this.safe(String(error))); }
        catch { console.error("pentagi.native.recovery_failed"); }
      }).finally(() => {
        if (this.recovering === work) this.recovering = undefined;
      }));
    } else this.lifecycle.trackAlarmWork(this.recovering);
    return { rescheduleAt: Date.now() + RECOVERY_HEARTBEAT_MS };
  }
  async onAlarmMemoryLimit(context: MemoryLimitContext): Promise<void> {
    const recovery = memoryRecovery(context, this.get<RuntimeRecovery>("platform:recovery"), Date.now(), runtimeVersion(this.env));
    this.put("platform:recovery", recovery);
    if (recovery.sealed) console.error("pentagi.native.coordinator_memory", recovery);
    else console.warn("pentagi.native.coordinator_memory", recovery);
    if (recovery.sealed) await this.lifecycle.jobs.cancel(RECOVERY_JOB_ID);
    else if (recovery.nextTime !== undefined) await this.lifecycle.jobs.reschedule(RECOVERY_JOB_ID, recovery.nextTime);
    const active = this.activeReceipt();
    // The recovery fence is durable before best-effort stream initialization.
    try {
      const id = active?.input.runId ?? "coordinator", writer = await this.activityWriter(id);
      this.activity(writer, id, recovery.sealed ? "platform.memory_recovery_sealed" : "platform.memory_recovery_backoff", undefined, active?.id);
    } catch { console.error("pentagi.native.memory_activity_unavailable"); }
  }

  /** A read-only snapshot never starts lifecycle capabilities or resumes an attempt. */
  async diagnostics() {
    const active = this.activeReceipt(), jobs = this.orderedJobs();
    const waiting = jobs.filter(job => job.status === "created" && this.run(job.runId).phase !== "cancelled");
    const execution = active ? await this.attempt(active.id).execution() : undefined;
    const recovery = this.get<RuntimeRecovery>("platform:recovery");
    return {
      coordinator: { ...(recovery ? { recovery } : {}), ...(runtimeVersion(this.env) ? { version: runtimeVersion(this.env) } : {}) },
      backlog: { waiting: waiting.length, oldestWaitingMs: waiting.length ? Math.max(0, Date.now() - Math.min(...waiting.map(job => job.createdAt))) : 0 },
      ...(active && execution ? { active: {
        id: active.id, state: execution.state, drained: execution.drained,
        unresolvedRemote: execution.unresolvedRemote ?? 0,
        sessionCleanupPending: execution.sessionCleanupPending ?? false,
        ...(execution.recovery ? { recovery: execution.recovery } : {}),
      } } : {}),
    };
  }

  async rearmPlatformRecovery(expected: { scope: "coordinator" | "attempt"; observedAt: number; attemptId?: string }) {
    if (!Number.isSafeInteger(expected.observedAt) || expected.observedAt < 0)
      throw new Error("400: invalid platform recovery marker");
    if (expected.scope === "attempt") {
      const active = this.activeReceipt();
      if (!active || active.id !== expected.attemptId)
        throw new Error("409: attempt no longer owns global execution");
      await this.attempt(active.id).rearmPlatformRecovery(expected.observedAt);
      const { recovery: _prior, ...job } = this.job(active.id);
      this.put(`job:${active.id}`, { ...job, revision: job.revision + 1 });
    } else if (expected.scope === "coordinator") {
      const recovery = this.get<RuntimeRecovery>("platform:recovery");
      if (!recovery?.sealed || recovery.observedAt !== expected.observedAt)
        throw new Error("409: platform recovery marker changed; reload diagnostics");
      const active = this.activeReceipt();
      if (active && (await this.attempt(active.id).execution()).unresolvedRemote)
        throw new Error("409: reconcile remote scanner outcomes before platform recovery");
      this.ctx.storage.transactionSync(() => {
        if (this.get<RuntimeRecovery>("platform:recovery")?.observedAt !== expected.observedAt)
          throw new Error("409: platform recovery marker changed; reload diagnostics");
        this.put("platform:recovery", null);
      });
    } else throw new Error("400: invalid platform recovery scope");
    await this.start();
    await this.wake();
    await this.publish();
    return { rearmed: true };
  }
  private attempt(id: string) {
    return this.env.ATTEMPTS.getByName(id) as unknown as AttemptStub;
  }
  private activeReceipt() {
    return this.get<ActiveReceipt | null>("active") ?? undefined;
  }
  private admissionJobs() {
    const jobs = this.jobs(),
      active = this.activeReceipt();
    // A cancelled or accepted attempt still occupies the toolbox until its local
    // execution drains. Its terminal UI status must not free the physical slot.
    return jobs.map((job) =>
      active?.id === job.id && terminal(job.status)
        ? { ...job, status: "running" as const }
        : job,
    );
  }
  private enqueue(job: AttemptRecord, promises: Promise<unknown>[]) {
    const sequence = (this.get<number>("queue:sequence") ?? 0) + 1;
    this.put("queue:sequence", sequence);
    this.put(`order:${job.id}`, sequence);
    this.put(`job:${job.id}`, job);
    // Agents 0.32 mutates its job row synchronously before awaiting alarm rearm,
    // so this wake joins the admission transaction; the caller awaits after commit.
    promises.push(this.wake());
  }
  private orderedJobs() {
    return this.jobs().sort(
      (a, b) =>
        (this.get<number>(`order:${a.id}`) ?? a.createdAt) -
          (this.get<number>(`order:${b.id}`) ?? b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  }
  /** Reuse the durable admission sequence; no browser-maintained naming ledger. */
  private presentJob = (job: AttemptRecord) => ({...publicJob(job), conversationOrder: this.get<number>(`order:${job.logicalThreadId ?? job.id}`) ?? job.createdAt});
  private track(work: Promise<unknown>) {
    this.lifecycle.trackAlarmWork(work);
    this.ctx.waitUntil(work);
  }
  private wake() {
    const recovery = this.get<RuntimeRecovery>("platform:recovery");
    if (recovery?.sealed) return Promise.resolve();
    // Always persist newer intent, including while a recovery handoff is busy.
    return this.lifecycle.jobs.push({
      id: RECOVERY_JOB_ID, fn: "recover",
      time: Math.max(Date.now(), recovery?.nextTime ?? 0),
      singleflight: true, recoveryLoop: true,
    });
  }
  private async recover() {
    this.loginChallenges.expire();
    this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key LIKE 'target-auth:%' OR (key LIKE 'browser-auth:%' AND json_extract(value,'$.expiresAt')<=?)",Date.now());
    if (recoveryPending(this.get<RuntimeRecovery>("platform:recovery"))) return;
    for (const receipt of this.list<Publication | null>("publication:"))
      if (receipt) await this.projectAccepted(receipt.runId);
    for(const [id] of this.ctx.storage.sql.exec<{key:string}>("SELECT key FROM native_records WHERE key LIKE 'conversation:%'").toArray().map(row=>[row.key.slice(13)] as const)){
      if(this.job(id).inputError){await this.stopConversation(id);continue;}
      if(this.get<ConversationPreparation>("conversation:"+id)?.status!=="pending"||this.job(id).status!=="created"||this.run(this.job(id).runId).phase==="cancelled")continue;
      try{await this.ensureConversation(id);}catch(error){this.activity(await this.activityWriter(this.job(id).runId),this.job(id).runId,"conversation.preparation_failed",undefined,id,this.safe(String(error)));}
    }
    let active = this.activeReceipt();
    if (active) {
      const observedId = active.id,
        execution = await this.attempt(active.id).execution();
      if (this.activeReceipt()?.id !== observedId) return;
      if (execution.recovery && canonical(this.job(active.id).recovery) !== canonical(execution.recovery)) {
        const job = this.job(active.id);
        this.put(`job:${active.id}`, { ...job, recovery: execution.recovery, revision: job.revision + 1 });
        await this.publish();
      }
      if (execution.evidence && !this.job(active.id).evidenceCommits?.includes(execution.evidence.commit)) {
        try {await this.recordEvidence(active.id,execution.evidence);} catch(error) {if(!terminal(this.job(active.id).status))throw error;}
      }
      if (execution.result && !terminal(this.job(active.id).status))
        await this.complete(execution.result);
      active = this.activeReceipt();
      if (active?.id !== observedId) return;
      if (active && terminal(this.job(active.id).status)) {
        if (!execution.drained) {
          if (this.job(active.id).status === "interrupted")
            await this.attempt(active.id).cancel();
          return;
        }
        this.ctx.storage.transactionSync(() => {
          if (this.activeReceipt()?.id === active!.id) {
            const run=this.run(active!.input.runId);
            if(active!.input.execution)this.put("run:"+run.id,{...run,discoveryDrained:true});
            this.put("active", null);
          }
        });
      } else if (active) {
        if (recoveryPending(execution.recovery)) return;
        this.launch(active);
        return;
      }
    }
    await this.advance();
    await this.prepareNextMaterials();
    this.drainUnadmittedDiscovery();
    await this.claimNext();
    await this.publish();
    for(const intent of this.list<PurgeIntent>("purge:"))await this.purgeRun(intent.runId,intent.runId);
  }
  private browserScopes(task: string) {
    const scopes = new Set<string>();
    for (const match of task.matchAll(/https?:\/\/[^\s<>"'`()\[\]{}]+/g)) {
      try {
        const url = new URL(match[0]);
        if (!url.username && !url.password)
          scopes.add(url.origin + url.pathname);
      } catch {}
    }
    return [...scopes].sort();
  }
  async onboardingSnapshot(runId?:string) {
    const run=runId?this.run(runId):undefined;
    const draft=run?this.onboarding.draft(run.id):undefined;
    const defaults=this.list<{targetId:string;draft:SetupDraft}>("onboarding:defaults:");
    let modelsTested=false,apiTested=false;
    if(run){try{await this.onboarding.verifyModelProfile(run.id);modelsTested=true;}catch{}try{await this.onboarding.verifyAPIProof(run.id,run.target!);apiTested=true;}catch{}}
    return {targets:this.onboarding.targets(),credentials:this.onboarding.credentials(),defaults,definitions:this.list<TargetDefinition>("onboarding:definition:"),checks:this.list("onboarding:target-proof:"),
      sourceImports:this.list<ImportReceipt>("onboarding:source-import:").filter(r=>r.status==="pending").map(({requestId,targetId,revision,repo,url,branch,replaceId})=>({requestId,targetId,revision,repo,url,...(branch?{branch}:{}),...(replaceId?{replaceId}:{})})),
      ...(run ? {run:publicRun(run),draft,definition:run.definition??(run.target?.kind==="api"?this.definitions.current(run.target.id):undefined),discovery:this.jobs(run.id).filter(j=>j.execution).map(this.presentJob),
        apiTested,readiness:{modelsTested,apiTested,discoverySettled:run.phase==="setup"&&this.activeReceipt()?.input.runId!==run.id&&!this.jobs(run.id).some(j=>!terminal(j.status))}} : {})};
  }
  async modelCatalog(route:OpenCodeRoute="go",refresh=false){return this.onboarding.catalog(route,refresh);}
  /** Explicit authenticated application actions, never a raw storage/secret RPC proxy. */
  async onboardingAction(action:string,value:Record<string,unknown>,actor:string):Promise<unknown> {
    const revision=typeof value.revision==="number"?value.revision:null;
    this.assertAdmissionOpen();
    try {
      switch(action){
        case 'bounty.status':return {connections:await this.bountyConnections.list(),email:{cloudflare:{configured:!!this.env.PENTCLOUD_VERIFICATION_EMAIL,address:this.env.PENTCLOUD_VERIFICATION_EMAIL},agentmail:{configured:!!agentMailAddress(this.env),address:agentMailAddress(this.env)}}};
        case 'bounty.check':return this.bountyConnections.check(String(value.platform) as BountyPlatform);
        case 'bounty.email.check':{
          if(value.provider!=='agentmail')throw Error('400: Verify Cloudflare delivery with a forwarding confirmation');
          const now=Date.now();await readAgentMail(this.env,{createdAt:now,expiresAt:now+10000,sender:''});return {connected:true};
        }
        case "scope.names":{
          const ready=(await this.bountyConnections.list()).filter(c=>c.status==='ready').map(c=>c.platform);if(!ready.length)throw Error('409: Connect a platform in Dashboard → Bug bounty first');
          const result=await this.scopeCatalog.names();return {...result,programs:result.programs.filter(p=>ready.includes(p.platform as BountyPlatform))};
        }
        case "scope.search":{
          const ready=(await this.bountyConnections.list()).filter(c=>c.status==='ready').map(c=>c.platform);if(!ready.length)throw Error('409: Connect a platform in Dashboard → Bug bounty first');
          if(value.platform)await this.bountyConnections.require(String(value.platform));
          return this.scopeCatalog.search(String(value.query??""),typeof value.platform==="string"&&value.platform?value.platform:undefined,ready);
        }
        case "scope.preview":await this.bountyConnections.require(String(value.programId).split(':')[0]!);return await this.scopeCatalog.preview(String(value.programId));
        case "scope.import":{
          const id=identifier(value.id),target=this.onboarding.target(id);if(target.revision!==revision||target.archived)throw new Error("409: Target changed or archived; reload");
          await this.bountyConnections.require(String(value.programId).split(':')[0]!);
          const program=await this.scopeCatalog.import(String(value.programId),target.url);this.assertAdmissionOpen();
          await this.bountyConnections.require(program.platform);
          return this.onboarding.saveTargetAccess(id,revision!,target.access??{headers:[]},actor,program);
        }
        case "scope.detach":return this.onboarding.saveTargetAccess(identifier(value.id),Number(value.revision),this.onboarding.target(identifier(value.id)).access??{headers:[]},actor,null);
        case "access.save":return this.onboarding.saveTargetAccess(identifier(value.id),Number(value.revision),value.access,actor);
        case "access.check":return this.onboarding.checkTargetSecret(identifier(value.id),Number(value.revision),String(value.kind),actor);
        case 'scope.check':{
          const target=this.onboarding.target(identifier(value.id));if(target.revision!==revision||target.archived)throw Error('409: Target changed; reload');
          const checked=await this.programAccess(target);const current=this.onboarding.target(target.id);if(current.revision!==revision)throw Error('409: Target changed during program check');
          return {connected:true,platform:checked?.platform,checkedAt:checked?.checkedAt,authenticated:!!checked};
        }
        case 'access.email.address':case 'access.email.setup':case 'access.email.status':{
          const target=this.onboarding.target(identifier(value.id));if(target.revision!==revision||target.archived)throw Error('409: Target changed; reload');
          const saved=target.access?.login?.verification,provider=action==='access.email.address'?(value.provider??(saved?.kind==='email'?saved.provider:undefined)??'cloudflare'):(saved?.kind==='email'?saved.provider??'cloudflare':'cloudflare');
          if(provider!=='cloudflare'&&provider!=='agentmail')throw Error('400: Invalid email verification provider');
          const available={cloudflare:!!this.env.PENTCLOUD_VERIFICATION_EMAIL,agentmail:!!agentMailAddress(this.env)};
          if(!available[provider])return {configured:false,provider,available};
          const address=provider==='agentmail'?agentMailAddress(this.env)!:await verificationAddress(this.env.PENTCLOUD_VERIFICATION_EMAIL!,target.id),key='setup:'+target.id,owner=canonical([target.id,target.revision,provider,address]);
          if(action==='access.email.setup'){
            if(target.access?.login?.verification?.kind!=='email')throw Error('409: Save email verification settings first');
            this.loginChallenges.begin({key,owner,recipient:address,sender:'',targetURL:target.url,purpose:'setup',provider},crypto.randomUUID());
            await this.scheduleVerificationExpiry();
          }
          if(provider==='agentmail'&&action!=='access.email.address')await this.pollAgentMail(key,owner);
          const current=this.onboarding.target(target.id);if(current.revision!==target.revision||current.archived)throw Error('409: Target changed; reload');
          const pending=this.loginChallenges.pending(key,owner),delivery=action==='access.email.status'?this.loginChallenges.peek(key,owner):undefined;
          // Setup confirmation is visible only to the authenticated owner, never an agent tool.
          return {configured:true,provider,available,address,status:delivery?'received':pending?'waiting':action==='access.email.status'?'expired':'idle',...(pending?{expiresAt:pending.expiresAt}:{}),...(action==='access.email.setup'?{ready:true}:{}),...(delivery?{received:true,from:delivery.from,code:delivery.code,excerpt:delivery.excerpt,links:delivery.links.filter(url=>{const h=new URL(url).hostname;return h==='mail.google.com'||h==='accounts.google.com'||h==='outlook.live.com'||h==='account.microsoft.com';})}:{received:false})};
        }
        case "access.clearlogin":{
          const target=this.onboarding.target(identifier(value.id));if(target.revision!==revision)throw new Error("409: Target changed; reload");
          for(const run of this.list<RunRecord>("run:"))if(run.target?.id===target.id)this.browserAuth.clear(run.id);
          const prefix="target-auth:"+target.id+":";this.ctx.storage.sql.exec("DELETE FROM native_records WHERE substr(key,1,?)=?",prefix.length,prefix);return {cleared:true};
        }
        case "source.list":return await this.sources.list(typeof value.cursor==="string"?value.cursor:undefined);
        case "source.attach":return await this.sources.attach(identifier(value.id),Number(value.revision),value.repo,value.branch,actor);
        case "source.refresh":return await this.sources.refresh(identifier(value.id),Number(value.revision),identifier(value.sourceId),actor);
        case "source.detach":return this.sources.detach(identifier(value.id),Number(value.revision),identifier(value.sourceId),actor);
        case "source.import":return await this.sources.importPublic(identifier(value.id),Number(value.revision),value.url,value.branch,identifier(value.requestId),actor,typeof value.replaceId==="string"?value.replaceId:undefined);
        case "target.save":return this.onboarding.saveTarget(value as unknown as Parameters<OnboardingStore["saveTarget"]>[0],revision,actor);
        case "target.archive":case "target.restore":case "target.delete":{
          const id=identifier(value.id);
          if(action==="target.delete"&&this.definitionBusy)throw new Error("409: Wait for definition storage to finish");
          const result=this.onboarding.lifecycleTarget(id,revision! ,action.split(".")[1] as "archive"|"restore"|"delete",actor);
          if(action==="target.delete"){
            for(const key of ["onboarding:defaults:"+id,"onboarding:definition:"+id])this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",key);
            await this.workspace.fs.rm("/target-definitions/"+id,{recursive:true,force:true});
            for(const prefix of ["onboarding:definition-version:"+id+":","material:target-definition:"+id+":"])this.ctx.storage.sql.exec("DELETE FROM native_records WHERE substr(key,1,?)=?",prefix.length,prefix);
            for(const run of this.list<RunRecord>("run:"))if(run.target?.id===id)this.browserAuth.clear(run.id);
            const authPrefix="target-auth:"+id+":";this.ctx.storage.sql.exec("DELETE FROM native_records WHERE substr(key,1,?)=?",authPrefix.length,authPrefix);
            this.collectCredentialVersions();
          }
          return result;
        }
        case "target.check":{await this.programAccess(this.onboarding.target(identifier(value.id)));return await this.onboarding.checkTarget(identifier(value.id),Number(value.revision),identifier(value.requestId),actor);}
        case "credential.save":{const result=this.onboarding.saveCredential(value as unknown as Parameters<OnboardingStore["saveCredential"]>[0],revision,actor);this.collectCredentialVersions();return result;}
        case "credential.revoke":return this.onboarding.revokeCredential(identifier(value.id),Number(value.revision),actor);
        case "discovery.acknowledge":{
          const id=identifier(value.runId),writer=await this.activityWriter(id),run=this.run(id);this.assertMutable(id);
          if(!run.activation||run.phase==="cancelled"||!run.discoveryDrained||this.activeReceipt()?.input.runId===id)throw new Error("409: Wait for discovery execution and remote outcomes to drain");
          this.put("run:"+id,{...run,discoveryAcknowledged:true});this.activity(writer,id,"discovery.acknowledged");await this.publish();await this.wake();return {acknowledged:true};
        }
        case "model.test":return await this.onboarding.testModel(value.choice as Parameters<OnboardingStore["testModel"]>[0],identifier(value.requestId),actor);
        case "setup.save":{
          const id=identifier(value.runId),run=this.run(id);this.assertMutable(id);
          if(!["discovery","setup"].includes(run.phase))throw new Error("409: Analysis configuration is already locked");
          return this.onboarding.saveDraft(id,value.draft as Parameters<OnboardingStore["saveDraft"]>[1],Number(value.revision),actor);
        }
        case "api.test":{
          const run=this.run(identifier(value.runId));this.assertMutable(run.id);
          if(!run.target||!["discovery","setup"].includes(run.phase))throw new Error("409: API setup is unavailable");
          return await this.onboarding.testAPI(run.id,run.target,identifier(value.requestId),actor);
        }
        case "metadata.import":{
          this.assertAdmissionOpen();
          if(this.list<RunRecord>("run:").length)throw new Error("409: Import requires an empty installation");
          return this.ctx.storage.transactionSync(()=>this.onboarding.importData(value.data as Parameters<OnboardingStore["importData"]>[0],actor));
        }
        default:throw new Error("404: Unknown onboarding action");
      }
    } catch(error){throw new Error(this.safe(error instanceof Error?error.message:"400: Invalid onboarding request"));}
  }
  async saveTargetDefinition(id:string,version:number,input:Omit<StageMaterialInput,"runId"|"id">){
    this.assertAdmissionOpen();const target=this.onboarding.target(id);
    if(target.kind!=="api")throw new Error("409: Choose an API target");
    this.definitionBusy++;
    try{
      const staged=await this.definitions.save(id,version,input);
      this.assertAdmissionOpen();this.onboarding.target(id);
      return staged;
    }finally{this.definitionBusy--;}
  }
  async targetDefinition(id:string,version?:number){this.onboarding.target(id);return this.definitions.response(id,version);}
  async creationSnapshot(id:string){
    identifier(id,"run id");
    const receipt=this.get<{input:NewRunInput;target:import("./onboarding").SavedTarget}>("onboarding:creation:"+id),run=this.get<RunRecord>("run:"+id);
    if(this.get("purged:run:"+id))throw new Error("410: This draft/run was deleted");
    const jobs=run?this.jobs(id):[],root=jobs.find(j=>run!.activation?!j.execution&&!j.parentJobId:!!j.execution)??jobs.find(j=>!j.parentJobId);
    return {...(receipt?receipt:{}),...(run&&root?{accepted:{run:publicRun(run),rootJob:publicJob(root)}}:{})};
  }
  async onboardingExport(){return {...this.onboarding.exportData(),definitions:this.list<TargetDefinition>("onboarding:definition:"),runReferences:this.list<RunRecord>("run:").map(r=>({id:r.id,targetId:r.target?.id,repo:r.repo,headCommit:r.headCommit}))};}
  private collectCredentialVersions(){
    const refs=new Set<string>();
    const add=(id:string,version:number)=>refs.add(id+":"+version);
    for(const run of this.list<RunRecord>("run:")){
      for(const m of Object.values(run.modelsByRole??{}))add(m.credentialId,m.credentialVersion);
      if(run.apiAccess)add(run.apiAccess.id,run.apiAccess.version);
      const draft=this.onboarding.draft(run.id);
      for(const choice of [draft.profile?.default,...Object.values(draft.profile?.overrides??{})])if(choice)add(choice.credentialId,choice.credentialVersion);
      if(draft.apiCredential)add(draft.apiCredential.id,draft.apiCredential.version);
    }
    for(const {draft} of this.list<{draft:SetupDraft}>("onboarding:defaults:")){
      for(const choice of [draft.profile?.default,...Object.values(draft.profile?.overrides??{})])if(choice)add(choice.credentialId,choice.credentialVersion);
      if(draft.apiCredential)add(draft.apiCredential.id,draft.apiCredential.version);
    }
    const targetIds=new Set(this.onboarding.targets().map(t=>t.id));
    for(const c of this.onboarding.credentials()){
      const retired=c.purpose==="api"&&!targetIds.has(c.targetId!)&&![...refs].some(ref=>ref.startsWith(c.id+":"));
      for(let v=1;v<=(retired?c.version:c.version-1);v++)if(!refs.has(c.id+":"+v))this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?","onboarding:value:"+c.id+":"+v);
      if(retired)this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?","onboarding:credential:"+c.id);
    }
  }
  /** Called by the active Attempt via service RPC only; never exposed by Worker routes. */
  async assertConversation(id:string):Promise<void> {
    await this.start();const job=this.job(id),run=this.run(job.runId);this.assertMutable(run.id);
    if(this.activeReceipt()?.id===id)return this.assertActive(id);
    const preparation=this.get<ConversationPreparation>("conversation:"+id);
    if(!preparation||job.status!=="created"||job.role!=="primary"||job.execution||!run.activation||run.phase==="cancelled"||
      canonical(job.modelConfig)!==canonical(preparation.input.modelConfig)||canonical(job.settings)!==canonical(preparation.input.settings))
      throw new Error("409: Conversation is not available for this queued primary");
  }
  async readPreparationFile(id:string,path:string):Promise<Response> {
    await this.assertConversation(id);const preparation=this.get<ConversationPreparation>("conversation:"+id);
    const selection=preparation?.input.context.materials as MaterialSelection|undefined;
    const file=selection?.files.find(file=>file.sourcePath===path||file.textPath===path);
    if(!file)throw new Error("404: File is not selected for preparation");
    return new Response(new Uint8Array(await this.materials.readSelectedFile(this.job(id).runId,file.id,path)).buffer);
  }
  async readSourceContext(id:string,sourceId:string,kind:"tree"|"file",path:string,offset:number){
    await this.assertConversation(id);
    if(kind!=="tree"&&kind!=="file")throw new Error("400: Choose a source tree or file");
    const result=await readSource(this.env.ARTIFACTS,this.run(this.job(id).runId).target?.sources??[],identifier(sourceId),kind,path,offset);
    await this.assertConversation(id);return result;
  }
  private readonly preparingConversations=new Map<string,Promise<void>>();
  private async stopConversation(id:string) {
    const plan=this.get<ConversationPreparation>("conversation:"+id);
    if(!plan||plan.status==="stopped")return;
    await this.attempt(id).cancel();
    this.put("conversation:"+id,{...this.get<ConversationPreparation>("conversation:"+id)!,status:"stopped"});
  }
  private async stopConversations(runId:string) {
    await Promise.all(this.jobs(runId).filter(job=>this.get("conversation:"+job.id)).map(job=>this.stopConversation(job.id)));
  }
  private drainUnadmittedDiscovery() {
    for(const run of this.list<RunRecord>("run:")){
      if(run.discoveryDrained||this.activeReceipt()?.input.runId===run.id)continue;
      const discovery=this.jobs(run.id).filter(job=>job.execution);
      // No launch receipt means no scanner ever acquired execution authority.
      if(!discovery.length||discovery.some(job=>!terminal(job.status)||this.get("launch:"+job.id)))continue;
      this.put("run:"+run.id,{...run,discoveryDrained:true,phase:run.phase==="discovery"?"setup":run.phase});
    }
  }
  private ensureConversation(id:string):Promise<void> {
    const prior=this.preparingConversations.get(id);if(prior)return prior;
    const preparation=this.get<ConversationPreparation>("conversation:"+id);
    if(!preparation||preparation.status!=="pending")return Promise.resolve();
    const work=(async()=>{
      await this.assertConversation(id);
      await this.attempt(id).prepareConversation(preparation.input);
      await this.assertConversation(id);
      this.put("conversation:"+id,{...preparation,status:"ready"});
      const job=this.job(id);this.put("job:"+id,{...job,revision:job.revision+1});
    })().finally(()=>{this.preparingConversations.delete(id);});
    this.preparingConversations.set(id,work);return work;
  }
  private assessmentReady(job:AttemptRecord):boolean {
    const run=this.run(job.runId),conversation=this.get<ConversationPreparation>("conversation:"+job.id);
    if(conversation?.status==="pending")return false;
    if(job.role!=="primary"||job.parentJobId||!run.activation)return true;
    const discoveries=this.jobs(run.id).filter(job=>job.execution);
    return !discoveries.length||!!run.discoveryDrained&&(!discoveries.some(job=>job.status!=="completed")||run.discoveryAcknowledged===true);
  }
  async modelCredential(id:string) {
    await this.assertConversation(id);const job=this.job(id);
    if(!job.modelConfig)throw new Error("409: This legacy job uses its deployment binding");
    const key=await this.onboarding.resolveModelCredential(job.modelConfig.credentialId,job.modelConfig.credentialVersion);
    if(job.modelConfig.credentialFingerprint&&await digest(key)!==job.modelConfig.credentialFingerprint)throw new Error("409: Cloudflare model secret changed; test it and start a new run");
    return key;
  }
  async apiCredential(id:string):Promise<import("./api-access").APIAccess> {
    await this.assertActive(id);const run=this.run(this.job(id).runId);
    if(!run.target||run.target.kind!=="api")throw new Error("403: This run has no API target");
    if(run.boundAPIAccess&&run.target.access?.api){const config=run.target.access.api,value=await readTargetSecret(this.env,config.binding);this.targetSecretRedactions.push(value);const credential=config.scheme==="bearer"?"Bearer "+value:value;if(!run.boundAPIFingerprint||await digest(credential)!==run.boundAPIFingerprint)throw new Error("409: Cloudflare API secret changed; test it and start a new run");await this.assertActive(id);return {targetURL:config.url,header:config.header,value:credential};}
    return run.apiAccess?this.onboarding.apiConfig(run.target,run.apiAccess):{targetURL:run.target.url};
  }
  private readonly browserAuth=new RunBrowserAuth({get:key=>this.get(key),put:(key,value)=>this.put(key,value),remove:key=>this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",key)});
  private readonly emailWaiters=new Map<string,Set<()=>void>>();
  private readonly agentMailChecks=new Map<string,Promise<void>>();
  private readonly loginChallenges=new LoginChallenges({get:key=>this.get(key),put:(key,value)=>this.put(key,value),remove:key=>this.ctx.storage.sql.exec('DELETE FROM native_records WHERE key=?',key),list:prefix=>this.ctx.storage.sql.exec<{key:string;value:string}>('SELECT key,value FROM native_records WHERE substr(key,1,?)=?',prefix.length,prefix).toArray().map(row=>({key:row.key,value:JSON.parse(row.value)}))});
  async receiveVerificationEmail(delivery:VerificationDelivery){
    return this.verificationReceived(this.loginChallenges.receive(delivery));
  }
  private async verificationReceived(accepted:boolean){if(accepted){await this.scheduleVerificationExpiry();for(const waiters of this.emailWaiters.values())for(const wake of waiters)wake();}return {accepted};}
  private async scheduleVerificationExpiry(){const expiresAt=this.loginChallenges.nextExpiry();if(expiresAt===undefined)return;await this.start();await this.scheduler.set(new Date(expiresAt+1000),'expireVerification',{expiresAt},{idempotent:true});}
  private async pollAgentMail(key:string,owner:string){
    const pending=this.loginChallenges.pending(key,owner);if(!pending||pending.provider!=='agentmail'||pending.message)return;
    const flightKey=canonical([key,owner,pending.operationId]),existing=this.agentMailChecks.get(flightKey);if(existing)return existing;
    const check=(async()=>{const deliveries=await readAgentMail(this.env,pending);const current=this.loginChallenges.pending(key,owner);if(!current||current.operationId!==pending.operationId||current.createdAt!==pending.createdAt)return;
      let accepted=false;for(const delivery of deliveries.reverse())accepted=this.loginChallenges.receive(delivery,{key,owner,operationId:pending.operationId})||accepted;
      await this.verificationReceived(accepted);
    })();this.agentMailChecks.set(flightKey,check);try{await check;}finally{if(this.agentMailChecks.get(flightKey)===check)this.agentMailChecks.delete(flightKey);}
  }
  private async emailScope(id:string){
    await this.assertActive(id);const run=this.run(this.job(id).runId),target=run.target,verification=target?.access?.login?.verification;
    if(!target||verification?.kind!=='email')throw Error('409: Configure email verification on this target');
    const provider=verification.provider??'cloudflare';let recipient:string,account:string|undefined;
    if(provider==='agentmail'){
      recipient=agentMailAddress(this.env)??'';if(!recipient)throw Error('409: Configure the AgentMail inbox and key binding in Cloudflare');
      account=(await readTargetSecret(this.env,target.access!.login!.usernameBinding)).trim().toLowerCase();this.targetSecretRedactions.push(account);
      if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(account))throw Error('409: AgentMail needs an email address in the target username secret; use Cloudflare receiving for other usernames');
    }else{if(!this.env.PENTCLOUD_VERIFICATION_EMAIL)throw Error('409: Configure Cloudflare email receiving');recipient=await verificationAddress(this.env.PENTCLOUD_VERIFICATION_EMAIL,target.id);}
    await this.assertActive(id);
    return {key:run.id,owner:await digest([run.id,target.id,target.url,target.access?.login,account]),recipient,sender:verification.sender,targetURL:target.url,purpose:'login' as const,provider,...(account?{account}:{})};
  }
  async beginLoginEmail(id:string,operationId:string){const scope=await this.emailScope(id);this.loginChallenges.begin(scope,operationId);await this.scheduleVerificationExpiry();}
  async loginEmail(id:string){
    const scope=await this.emailScope(id);let message=this.loginChallenges.peek(scope.key,scope.owner);
    const deadline=Date.now()+25000;
    while(!message&&Date.now()<deadline){
      if(scope.provider==='agentmail'){await this.pollAgentMail(scope.key,scope.owner);await this.assertActive(id);message=this.loginChallenges.peek(scope.key,scope.owner);if(message)break;}
      let wake!:()=>void;const ready=new Promise<void>(resolve=>{wake=resolve;}),waiters=this.emailWaiters.get(scope.key)??new Set<()=>void>();waiters.add(wake);this.emailWaiters.set(scope.key,waiters);
      const timer=setTimeout(wake,Math.min(deadline-Date.now(),scope.provider==='agentmail'?5000:25000));try{await ready;}finally{clearTimeout(timer);waiters.delete(wake);if(!waiters.size)this.emailWaiters.delete(scope.key);}
      await this.assertActive(id);message=this.loginChallenges.peek(scope.key,scope.owner);
    }
    return message;
  }
  async consumeLoginEmail(id:string,messageId:string){const scope=await this.emailScope(id);this.loginChallenges.consume(scope.key,scope.owner,messageId);}
  private async programAccess(target:SavedTarget){
    const verification=target.access?.login?.verification;
    if(verification?.kind==='email'&&!(verification.provider==='agentmail'?agentMailAddress(this.env):this.env.PENTCLOUD_VERIFICATION_EMAIL))throw Error('409: Configure the selected email receiver in Dashboard → Bug bounty first');
    const id=target.access?.program?.id;if(!id)return undefined;const config=platformBinding(id);if(!config)throw Error('409: Unsupported program identity; refresh its catalog scope');
    await this.bountyConnections.require(config.platform);
    const token=await platformToken(this.env,config.binding);this.targetSecretRedactions.push(token);
    return checkProgramAccess(id,{token,...(config.platform==='hackerone'?{username:this.env.PENTCLOUD_HACKERONE_USERNAME}:{})});
  }
  async browserState(id:string,state?:BrowserAuthState):Promise<BrowserAuthState|undefined>{
    await this.assertActive(id);const run=this.run(this.job(id).runId),target=run.target;if(!target?.access?.login)return;
    if(state){this.browserAuth.write(run.id,target,state);return;}
    return this.browserAuth.read(run.id,target);
  }
  async activateAnalysis(id:string,expectedRevision:number,requestId:string,acknowledgeFailure=false,definitionVersion=0) {
    identifier(requestId,"analysis request id");await this.start();this.assertMutable(id);
    const run=this.run(id);
    if(run.activation){
      if(run.activation.requestId!==requestId||run.activation.draftRevision!==expectedRevision)throw new Error("409: Analysis was already activated");
      const root=this.jobs(id).find(j=>!j.execution&&!j.parentJobId)!;
      await this.ensureConversation(root.id);await this.publish();
      return {run:publicRun(this.run(id)),rootJob:publicJob(this.job(root.id))};
    }
    if(!run.target||!["discovery","setup"].includes(run.phase))throw new Error("409: Finish target setup before opening chat");
    const discoveries=this.jobs(id).filter(j=>j.execution);
    if(!discoveries.length)throw new Error("409: Initial discovery is missing");
    const draft=this.onboarding.draft(id);if(draft.revision!==expectedRevision)throw new Error("409: Setup changed; reload");
    const modelsByRole=await this.onboarding.verifyModelProfile(id),apiProof=await this.onboarding.verifyAPIProof(id,run.target);
    const definition=run.target.kind==="api"?this.definitions.current(run.target.id):undefined;
    if((definition?.version??0)!==definitionVersion)throw new Error("409: API definition changed; reload and review it before analysis");
    const definitionUploads:string[]=[];
    if(definition){this.definitionBusy++;try{definitionUploads.push(await this.definitions.copyIntoRun(definition,id,run.authorization?.actor??"operator"));}finally{this.definitionBusy--;}}
    const next:RunRecord={...run,phase:"primary",status:"created",modelsByRole,
      boundAPIAccess:!draft.publicAPI&&!!run.target.access?.api,
      ...(apiProof?.credentialFingerprint?{boundAPIFingerprint:apiProof.credentialFingerprint}:{}),
      ...(definition?{definition}:{}),
      settingsRevision:await digest({settings:run.settings,modelsByRole,target:run.target,definition,apiAccess:draft.publicAPI?null:draft.apiCredential}),
      ...(!draft.publicAPI&&draft.apiCredential?{apiAccess:draft.apiCredential}:{}),
      ...(acknowledgeFailure&&run.discoveryDrained?{discoveryAcknowledged:true}:{}),
      activation:{requestId,draftRevision:expectedRevision}};
    const acceptedIds=new Set(run.materials?.files.map(file=>file.id)??[]);
    const uploads=normalizeUploadIds([...(run.initialUploadIds??[]),...definitionUploads]).filter(id=>!acceptedIds.has(id));
    const job=await this.makeJob(next,"primary","primary",{task:run.task,instructions:run.task},undefined,undefined,"primary-"+(await digest({run:id,requestId})).slice(0,32),uploads);
    const early=!run.discoveryDrained||discoveries.some(j=>j.status!=="completed")&&!acknowledgeFailure;
    const ids=normalizeUploadIds([...(run.initialUploadIds??[]),...(job.materialUploadIds??[])]);
    const selection=early?await this.materials.selection(id,ids,run.materials):undefined;
    const preparation:ConversationPreparation|undefined=early?{status:"pending",input:{...job,inputCommit:run.headCommit,context:{...this.contextFor(discoveries[0]!.id),enabledTools:supportedOptionalTools(job.role),...(selection?.files.length?{materials:selection}:{})}}}:undefined;
    if(preparation)job.conversation=true;
    const pushes:Promise<unknown>[]=[];
    this.ctx.storage.transactionSync(()=>{
      this.assertAdmissionOpen();this.assertMutable(id);
      if(canonical(this.run(id))!==canonical(run)||this.onboarding.draft(id).revision!==expectedRevision)throw new Error("409: Run or setup changed; reload");
      if(canonical(this.onboarding.pinProfile(id))!==canonical(modelsByRole))throw new Error("409: Model proof changed; reload setup");this.onboarding.requireAPIProof(id,run.target!);
      assertAdmission(this.admissionJobs(),job.id,job.fingerprint);
      if((run.target!.kind==="api"?(this.definitions.current(run.target!.id)?.version??0):0)!==definitionVersion)throw new Error("409: API definition changed during activation");
      this.put("run:"+id,next);this.put("onboarding:defaults:"+run.target!.id,{targetId:run.target!.id,draft});
      if(preparation)this.put("conversation:"+job.id,preparation);
      this.enqueue(job,pushes);
    });
    await Promise.all(pushes);await this.ensureConversation(job.id);await this.publish();await this.wake();return {run:publicRun(this.run(id)),rootJob:publicJob(this.job(job.id))};
  }
  async assertEvidenceOwner(id:string):Promise<void> {
    await this.start();const job=this.job(id);
    if(this.activeReceipt()?.id!==id||(this.run(job.runId).lifecycle??"active")==="purging")throw new Error("409: Evidence no longer owns execution");
  }
  async recordEvidence(id:string,receipt:EvidenceCheckpoint):Promise<void> {
    await this.start();const job=this.job(id),run=this.run(job.runId);
    if(job.evidenceCommits?.includes(receipt.commit))return;
    if(this.activeReceipt()?.id!==id||(run.lifecycle??"active")==="purging")throw new Error("409: Evidence no longer owns execution");
    using repo=await this.env.ARTIFACTS.get(run.repo);
    const manifest=await validateEvidenceCheckpoint(repo,{id,runId:run.id,inputCommit:job.inputCommit,...(job.promptDigest?{promptDigest:job.promptDigest}:{})},receipt,job.evidence);
    this.ctx.storage.transactionSync(()=>{
      const current=this.job(id);
      if(this.activeReceipt()?.id!==id||canonical(current.evidence)!==canonical(job.evidence)||(this.run(run.id).lifecycle??"active")==="purging")throw new Error("409: Evidence ownership changed");
      this.put(`job:${id}`,{...current,promptDigest:manifest.promptDigest,evidence:receipt,evidenceCommits:[...(current.evidenceCommits??[]),receipt.commit],evidenceFiles:manifest.files,...(manifest.unavailable?{evidenceUnavailable:manifest.unavailable}:{}),revision:current.revision+1});
    });
    await this.publish();
  }
  async readEvidence(requesterId:string,sourceId:string,path:string):Promise<Response> {
    await this.assertActive(requesterId);const requester=this.job(requesterId),source=this.job(sourceId);
    if(requester.runId!==source.runId||!source.evidence||!path.startsWith(evidenceRoot(sourceId)+"/")||!source.evidenceFiles?.some(f=>f.path===path))throw new Error("404: Evidence is not in this run");
    return this.file(source.runId,source.evidence.commit,path);
  }
  async readRunWork(requesterId:string,sourceId?:string,offset=0):Promise<RecordedWorkPage> {
    await this.assertActive(requesterId);
    const requester=this.job(requesterId);
    if(requester.role!=="reporter")throw new Error("403: Recorded work requires the active reporter");
    if(!sourceId){
      const catalog={run_id:requester.runId,acceptedCommit:this.run(requester.runId).headCommit,attempts:this.jobs(requester.runId).filter(j=>j.id!==requesterId).map(j=>({job_id:j.id,role:j.role,status:j.status,createdAt:j.createdAt,startedAt:j.startedAt,finishedAt:j.finishedAt,input_commit:j.inputCommit,output_commit:j.outputCommit,error:j.inputError??j.terminal?.error,result_tool:j.terminal?.tool,evidence:j.evidence,files:j.evidenceFiles??[],unavailable:j.evidenceUnavailable??[]}))};
      return recordedWorkPage(redact(catalog,[...knownRuntimeSecrets(this.env),...plainModelSecretValues(this.env),...this.onboarding.secretValues()]),offset);
    }
    const source=this.job(sourceId);
    assertRecordedWorkAccess(requester,source);
    const result=await this.attempt(source.id).recordedWork(requester.runId,offset);
    await this.assertActive(requesterId);
    return result;
  }
  private contextFor(id: string) {
    const job = this.job(id),
      run = this.run(job.runId);
    return {
      objective: run.task,
      head_commit: run.headCommit,
      wave: run.wave,
      attempts: this.jobs(run.id)
        .filter((j) => j.terminal || j.inputError)
        .map((j) => ({
          job_id: j.id,
          role: j.role,
          input_commit: j.inputCommit,
          output_commit: j.outputCommit,
          status: j.status,
          result: j.terminal,
          ...(j.inputError ? {input_error: j.inputError} : {}),
        })),
      evidence: this.jobs(run.id).filter(j=>j.evidence).map(j=>({job_id:j.id,checkpoint:j.evidence,files:j.evidenceFiles??[],unavailable:j.evidenceUnavailable??[]})),
      enabledTools: supportedOptionalTools(job.role),
      browserAllowedURLs: run.target ? [run.target.url] : this.browserScopes(run.task),
      ...(run.target ? {target:{id:run.target.id,name:run.target.name,kind:run.target.kind,url:run.target.url,revision:run.target.revision,objective:run.target.objective,exclusions:run.target.exclusions},networkReach:targetAccessBrief(run.target),...(run.programAccess?{programRules:run.programAccess.policy}:{}),apiAuth:run.apiAccess||run.target.access?.api ? "Use pentcloud_api_request for authenticated API calls. Browser/curl requests can assess anonymous coverage." : "Unauthenticated coverage"} : {}),
      run_id: run.id,
      ...(run.materials ? {materials: run.materials} : {}),
      ...(run.target?.sources?.length?{sourceContexts:run.target.sources}:{}),
    };
  }
  private async claimNext() {
    if (recoveryPending(this.get<RuntimeRecovery>("platform:recovery"))) return;
    // A durable purge owns the shared scanner until scratch cleanup completes.
    if (this.list<PurgeIntent>("purge:").length) return;
    const candidate = this.orderedJobs().find(j => j.status === "created" && this.assessmentReady(j) && this.run(j.runId).phase !== "cancelled" && (this.run(j.runId).lifecycle ?? "active") === "active");
    if (!candidate || this.activeReceipt()) return;
    const writer = await this.activityWriter(candidate.runId);
    let claimed: ActiveReceipt | undefined;
    this.ctx.storage.transactionSync(() => {
      if (this.activeReceipt() || recoveryPending(this.get<RuntimeRecovery>("platform:recovery")) || this.list<PurgeIntent>("purge:").length) return;
      const job = this.orderedJobs().find(
        (j) =>
          j.status === "created" && this.assessmentReady(j) && this.run(j.runId).phase !== "cancelled" && (this.run(j.runId).lifecycle ?? "active")==="active",
      );
      if (!job || job.id !== candidate.id) return;
      const run = this.run(job.runId);
      if (this.get(`publication:${run.id}`)) return;
      if (this.get("input:preparing") || (job.materialUploadIds?.length && !this.get(`input:receipt:${job.id}`))) return;
      const {
        execution,
        modelConfig,
        id,
        runId,
        role,
        tool,
        args,
        task,
        repo,
        remote,
        settingsRevision,
        settings,
        parentJobId,
        depth,
        attempt,
        logicalThreadId,
        revisionOf,
        createdAt,
      } = job;
      const input: AttemptInput = {
        ...(job.targetConfig ? {targetConfig:job.targetConfig} : {}),
        ...(job.findingsVersion ? {findingsVersion:job.findingsVersion} : {}),
        ...(execution ? {execution} : {}),
        ...(modelConfig ? {modelConfig} : {}),
        id,
        runId,
        role,
        tool,
        args,
        task,
        repo,
        remote,
        settingsRevision,
        settings,
        depth,
        attempt,
        logicalThreadId,
        createdAt,
        inputCommit: run.headCommit,
        context: this.contextFor(id),
        ...(parentJobId ? { parentJobId } : {}),
        ...(revisionOf ? { revisionOf } : {}),
      };
      claimed = { id, input };
      this.put("active", claimed);
      this.put(`launch:${id}`, input);
      this.put(`job:${id}`, {
        ...job,
        inputCommit: input.inputCommit,
        context: input.context,
        status: "running",
        startedAt: Date.now(),
        revision: job.revision + 1,
      });
      this.put(`run:${run.id}`, { ...run, status: "running" });
      this.activity(writer, run.id, "phase.started", job.role, id);
    });
    if (claimed) this.launch(claimed);
  }
  private launch(receipt: ActiveReceipt) {
    if (
      this.launched.has(receipt.id) ||
      recoveryPending(this.get<RuntimeRecovery>("platform:recovery")) ||
      recoveryPending(this.job(receipt.id).recovery) ||
      this.activeReceipt()?.id !== receipt.id ||
      terminal(this.job(receipt.id).status)
      || (this.run(receipt.input.runId).lifecycle ?? "active")!=="active"
    )
      return;
    this.launched.add(receipt.id);
    const work = (async () => {
      let completed = false;
      try {
        await this.complete(await this.attempt(receipt.id).run(receipt.input));
        completed = true;
      } catch (error) {
        // RPC loss and eviction do not prove an execution stopped. Keep ownership;
        // the next durable wake inspects/resumes the same immutable attempt.
        this.activity(
          await this.activityWriter(receipt.input.runId),
          receipt.input.runId,
          "attempt.recovery_needed",
          receipt.input.role,
          receipt.id,
          String(error),
        );
      } finally {
        this.launched.delete(receipt.id);
        // Failed RPCs and publication attempts retain ownership and wait for the
        // existing 15-second durable heartbeat; waking here would hot-loop on OOM.
        if (completed) await this.wake();
      }
    })();
    this.track(work);
  }
  private async complete(result: AttemptResult) {
    if(this.get(`purged:job:${result.id}`))return;
    const writer = await this.activityWriter(this.job(result.id).runId);
    const job = this.job(result.id),
      active = this.activeReceipt();
    if (terminal(job.status)) return;
    if (
      active?.id !== job.id ||
      result.runId !== job.runId ||
      result.inputCommit !== active.input.inputCommit ||
      result.settingsRevision !== job.settingsRevision
    )
      throw new Error("409: completion changed immutable input");
    if (job.execution ? result.model !== null || result.executionKind !== "discovery" : result.model !== job.settings.model || result.executionKind !== undefined) {
      // A terminal receipt from the owned attempt can be rejected without
      // accepting its candidate or rerunning work. Keep the original receipt
      // for audit; recovery retains ownership until execution is fully drained.
      this.ctx.storage.transactionSync(() => {
        const latest=this.job(job.id);
        if(terminal(latest.status))return;
        this.put(`job:${job.id}`,{...latest,status:"invalid_result",terminal:{...result,status:"invalid_result",
          error:"Attempt returned a different execution mode or model. Its result was rejected; no work was retried."},
          finishedAt:Date.now(),revision:latest.revision+1});
      });
    } else if (result.outputCommit) {
      try {
        await this.accept(result);
      } catch (error) {
        const latest = this.job(job.id);
        if (terminal(latest.status)) throw error;
        if (!/\b(?:400|403|409):/.test(String(error))) throw error;
        this.ctx.storage.transactionSync(() => {
          const current = this.job(job.id);
          if (terminal(current.status)) return;
          this.put(`job:${job.id}`, {
            ...current,
            status: "invalid_result",
            terminal: {
              ...result,
              status: "invalid_result",
              error: this.safe(String(error)),
            },
            finishedAt: Date.now(),
            revision: current.revision + 1,
          });
        });
      }
    } else {
      if (!["failed", "interrupted", "invalid_result"].includes(result.status))
        throw new Error(
          "400: terminal completion requires committed provenance",
        );
      this.ctx.storage.transactionSync(() => {
        const latest = this.job(job.id);
        if (terminal(latest.status)) return;
        this.put(`job:${job.id}`, {
          ...latest,
          status: result.status,
          terminal: {
            ...result,
            error: result.error ? this.safe(result.error) : undefined,
          },
          finishedAt: result.finishedAt,
          revision: latest.revision + 1,
        });
      });
    }
    const settled = this.job(job.id);
    if(job.execution && this.run(job.runId).phase !== "cancelled") {const current=this.run(job.runId);this.put("run:"+job.runId,{...current,phase:current.activation?current.phase:"setup",status:"waiting"});}
    this.activity(
      writer,
      job.runId,
      settled.status === "failed" || settled.status === "invalid_result"
        ? "phase.failed"
        : "phase.completed",
      job.role,
      job.id,
      settled.terminal?.error,
    );
    await this.publish();
  }
  private activityId(runId: string) { return `activity:v2:${runId}`; }
  /** Open only the touched run. Migration and legacy deletion share one transaction. */
  private async activityWriter(runId: string, creating = false): Promise<StreamWriter> {
    if (this.get(`purged:run:${runId}`)) throw new Error("409: run was permanently purged");
    if (!creating && runId !== "coordinator") this.run(runId);
    const writer = await this.streams.open(this.activityId(runId), { metadata: { protocol: 2, runId } });
    // Native open awaits readiness: purge may have won while it was suspended.
    if (this.get(`purged:run:${runId}`)) {
      writer.close({ discard: true });
      throw new Error("409: run was permanently purged");
    }
    this.ctx.storage.transactionSync(() => {
      for (const row of this.ctx.storage.sql.exec<{value:string}>("SELECT value FROM native_activity WHERE run_id=? ORDER BY id", runId)) {
        const event = JSON.parse(row.value) as Activity;
        writer.append({ ...event, instanceId: runId, eventId: writer.cursor });
      }
      this.ctx.storage.sql.exec("DELETE FROM native_activity WHERE run_id=?", runId);
    });
    return writer;
  }
  private activity(
    writer: StreamWriter,
    runId: string,
    type: string,
    stepName?: string,
    jobId?: string,
    error?: string,
  ) {
    if (writer.streamId !== this.activityId(runId)) throw new Error("409: activity stream owner mismatch");
    if (this.get(`purged:run:${runId}`)) throw new Error("409: run was permanently purged");
    if (this.get<RunRecord>(`run:${runId}`)?.lifecycle === "purging") throw new Error("409: run purge is in progress");
    const value: Activity = {
      instanceId: runId, eventId: writer.cursor, timestamp: Date.now(), type,
      ...(stepName ? { stepName } : {}), ...(jobId ? { jobId } : {}),
      ...(error ? { error: { name: "AttemptError", message: this.safe(error) } } : {}),
    };
    writer.append(value);
  }
  private safe(value: string) {
    let text = value;
    for (const secret of [...knownRuntimeSecrets(this.env), ...plainModelSecretValues(this.env), ...this.onboarding.secretValues(),...this.targetSecretRedactions])
      if (secret) text = text.split(secret).join("[redacted]");
    return text.slice(0, 2000);
  }
  private async publish() {
    const old = this.view.get();
    this.view.set({
      revision: (old?.revision ?? 0) + 1,
      runs: this.list<RunRecord>("run:").map(publicRun),
      jobs: this.jobs().map(this.presentJob),
      purgedRunIds: this.list<{id:string}>("purged:run:").map(row=>row.id),
    });
  }
  async settings() {
    await this.start();
    let current = this.get<{ settings: AgentSettings; revision: number }>(
      "settings:current",
    );
    if (!current) {
      const settings = await defaultAgentSettings(
        "opencode-go:deepseek-v4-pro",
        "default",
      );
      current = this.get("settings:current");
      if (!current) {
        current = { settings, revision: 0 };
        this.put("settings:current", current);
        this.put(`settings:${settings.revision}`, settings);
      }
    }
    const blocking = this.list<RunRecord>("run:")
      .filter((r) => !["completed", "cancelled"].includes(r.phase))
      .map((r) => r.id);
    return {
      settings: current.settings,
      casRevision: current.revision,
      locked: blocking.length > 0,
      blockingRunIds: blocking,
      upstreamRoles: Object.fromEntries(
        ACTIVE_ROLES.map((r) => [r, managedRoleSettings(r)]),
      ),
    };
  }
  async saveSettings(
    roles: AgentSettings["roles"],
    revision: number,
    actor: string,
  ) {
    await this.start();
    const before = await this.settings();
    if (before.locked) throw new Error("409: settings locked by active runs");
    if (before.casRevision !== revision)
      throw new Error("409: settings changed; reload");
    let settings: AgentSettings;
    try {
      if (roles && typeof roles === "object")
        for (const role of ACTIVE_ROLES) {
          const value = roles[role];
          if (
            value &&
            typeof value === "object" &&
            typeof value.promptTemplate !== "string"
          )
            throw new Error(`400: ${role} prompt template must be a string`);
        }
      settings = await createAgentSettings(roles, actor, new Date());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Catalog validation has a finite vocabulary. Crypto/storage/runtime errors
      // must retain their server classification instead of becoming client errors.
      if (
        /^(roles must |settings document is too large|(?:primary|adviser|coder|maintenance|memorist|pentester|searcher) (?:settings are invalid|prompt template |upstream prompt digest |model is invalid|reasoning effort is invalid|OpenCode Go requires ))/.test(
          message,
        )
      )
        throw new Error(`400: ${message}`);
      throw error;
    }
    for (const role of ACTIVE_ROLES) {
      if (!/^(opencode-go|opencode):[A-Za-z0-9][A-Za-z0-9._~/-]{0,180}$/.test(settings.roles[role].model))
        throw new Error("400: choose an OpenCode Console or Go model");
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.get<{ revision: number }>("settings:current");
      if (
        current?.revision !== revision ||
        this.list<RunRecord>("run:").some(
          (r) => !["completed", "cancelled"].includes(r.phase),
        )
      )
        throw new Error("409: settings changed or a run started");
      this.put(`settings:${settings.revision}`, settings);
      this.put("settings:current", { settings, revision: revision + 1 });
    });
    return this.settings();
  }
  async listRuns(view: "active" | "archived" | "trash" | "all" = "active") {
    await this.start();
    return {
      runs: this.list<RunRecord>("run:")
        .filter(run=>view==="all" || (view==="trash" ? ["trashed","purging"].includes(run.lifecycle ?? "active") : (run.lifecycle ?? "active")===view))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicRun),
    };
  }
  async getRun(id: string) {
    await this.start();
    return { run: publicRun(this.run(id)), jobs: this.jobs(id).map(this.presentJob) };
  }
  private assertAdmissionOpen() {
    if(this.get("lifecycle:quiesced"))throw new Error("409: installation is quiesced for uninstall");
  }
  private assertMutable(id:string) {
    this.assertAdmissionOpen();
    const run=this.run(id);
    if((run.lifecycle ?? "active")!=="active")throw new Error("409: restore this run before changing it");
    return run;
  }
  async assertJobAvailable(id:string, mutable=false) {
    const job=this.job(id),run=this.run(job.runId);
    if(run.lifecycle==="purging")throw new Error("409: run purge is in progress");
    if(mutable)this.assertMutable(run.id);
    return {runId:run.id,...(job.execution?{executionKind:job.execution.kind}:{})};
  }
  async lifecycleStatus() { return this.lifecycleSnapshot(); }
  private lifecycleSnapshot() {
    const runs={active:0,archived:0,trashed:0,purging:0,total:0};
    for(const run of this.list<RunRecord>("run:")){runs[run.lifecycle ?? "active"]++;runs.total++;}
    const pendingPublications=this.list<Publication|null>("publication:").filter(Boolean).length;
    const stagedUploads=this.list<unknown>("material:upload:").length+this.list<unknown>("material:target-definition:").length;
    const ownedProjects=this.list<{runId:string;repo:string}>("project:owned:").length;
    const preparingInput=!!this.get("input:preparing") || !!this.preparingMaterials || !!this.preparingConversations.size || !!this.uploads.size || !!this.initializing.size || !!this.creations.size || !!ownedProjects || this.definitionBusy>0;
    const targetCount=this.onboarding.targets().length,credentialCount=this.onboarding.credentials().filter(c=>!c.id.startsWith("bound-")).length;
    const libraryUploads=this.list<unknown>("material:target-definition:").length;
    const activeAttempt=!!this.activeReceipt();
    const pendingPurges=this.list<PurgeIntent>("purge:").length;
    return {runs,activeAttempt,pendingPublications,preparingInput,pendingPurges,stagedUploads,ownedProjects,quiesced:!!this.get("lifecycle:quiesced"),
      ...((targetCount||credentialCount||libraryUploads)?{onboarding:{targets:targetCount,credentials:credentialCount,definitionUploads:libraryUploads},canDeleteOnboarding:runs.total===0&&!this.jobs().length&&stagedUploads===libraryUploads&&!activeAttempt&&!pendingPublications&&!preparingInput&&!pendingPurges}:{}),
      safeToUninstall:!targetCount && !credentialCount && runs.total===0 && this.jobs().length===0 && !stagedUploads && !activeAttempt && !pendingPublications && !preparingInput && !pendingPurges && !this.acceptances.size && !this.projections.size};
  }
  async prepareUninstall(deleteOnboarding=false) {
    const status=this.ctx.storage.transactionSync(()=>{
      const current=this.lifecycleSnapshot();
      if(!current.safeToUninstall&&!(deleteOnboarding&&current.canDeleteOnboarding))throw new Error("409: Purge runs and drain owned work before uninstall; saved targets/keys require explicit deletion");
      this.put("lifecycle:quiesced",true);return current;
    });
    if(deleteOnboarding){
      const virtualIds=new Set(this.list<{receipt:{runId:string}}>("material:target-definition:").map(v=>v.receipt.runId));
      for(const id of virtualIds){
        await this.workspace.fs.rm("/target-definitions/"+id,{recursive:true,force:true});
        const prefix="material:target-definition:"+id+":";this.ctx.storage.sql.exec("DELETE FROM native_records WHERE substr(key,1,?)=?",prefix.length,prefix);
      }
      this.ctx.storage.sql.exec("DELETE FROM native_records WHERE substr(key,1,11)='onboarding:'");
    }
    const after=this.lifecycleSnapshot();
    if(!after.safeToUninstall)throw new Error("409: Onboarding cleanup still needs reconciliation");
    return {...after,quiesced:true,safeToUninstall:true};
  }
  private changeLifecycle(id:string,lifecycle:NonNullable<RunRecord["lifecycle"]>) {
    return this.ctx.storage.transactionSync(()=>{
      const run=this.run(id);
      if(run.lifecycle==="purging")throw new Error("409: permanent purge is in progress");
      const next={...run,lifecycle,lifecycleRevision:(run.lifecycleRevision ?? 0)+1};
      this.put(`run:${id}`,next);return next;
    });
  }
  async archiveRun(id:string) {
    const run=this.run(id);
    if((run.lifecycle ?? "active")!=="active")throw new Error("409: only active runs can be archived");
    if(this.activeReceipt()?.input.runId===id || this.jobs(id).some(job=>!terminal(job.status)) || this.get(`publication:${id}`) || this.get<InputPreparation>("input:preparing")?.runId===id)
      throw new Error("409: stop and drain this run before archiving");
    this.changeLifecycle(id,"archived");await this.stopConversations(id);await this.publish();return this.getRun(id);
  }
  async trashRun(id:string) {
    const writer = await this.activityWriter(id);
    const cancellation = this.ctx.storage.transactionSync(() => {
      const run=this.run(id);
      if(run.lifecycle==="purging")throw new Error("409: permanent purge is in progress");
      this.put(`run:${id}`,{...run,lifecycle:"trashed",lifecycleRevision:(run.lifecycleRevision ?? 0)+1});
      return !["completed","cancelled"].includes(run.phase) || this.jobs(id).some(job=>!terminal(job.status))
        ? this.markRunCancelled(writer,id) : undefined;
    });
    if(cancellation) await this.finishRunCancellation(id,cancellation);
    else {await this.stopConversations(id);await this.publish();}
    return this.getRun(id);
  }
  async restoreRun(id:string) {
    const run=this.run(id);
    if(!["archived","trashed"].includes(run.lifecycle ?? "active"))throw new Error("409: only archived or trashed runs can be restored");
    this.assertAdmissionOpen();
    const restored=this.changeLifecycle(id,"active");
    // A restored cancelled run remains stopped; a new explicit revision may continue it.
    if(restored.phase==="cancelled")this.put(`run:${id}`,{...restored,phase:"completed"});
    await this.publish();return this.getRun(id);
  }
  async discardDraft(id:string) {
    identifier(id);
    if(this.get(`run:${id}`) || this.creations.has(id) || this.initializing.has(id) || this.uploads.get(id))throw new Error("409: draft belongs to a run or upload is still in progress");
    // Fence late uploads/create requests before the first asynchronous deletion.
    this.put(`purged:run:${id}`,{id});
    // A failed admission may have opened an empty stream before creating a run.
    const writer = await this.streams.open(this.activityId(id));
    writer.close({discard:true,commit:()=>this.ctx.storage.sql.exec("DELETE FROM native_activity WHERE run_id=?",id)});
    const owned=this.get<{runId:string;repo:string}>(`project:owned:${id}`);
    if(owned){
      if(owned.runId!==id || owned.repo!==`run-${id}`)throw new Error("409: unexpected draft repository ownership");
      await this.workspace.artifacts.delete(owned.repo);
      for(const root of ["/projects","/accepted"])await this.workspace.fs.rm(`${root}/${id}`,{recursive:true,force:true});
    }
    await this.workspace.fs.rm(`/uploads/${id}`,{recursive:true,force:true});
    this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",`project:owned:${id}`);
    this.ctx.storage.sql.exec("DELETE FROM native_records WHERE substr(key,1,?)=?",`material:upload:${id}:`.length,`material:upload:${id}:`);
    this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?","onboarding:creation:"+id);
    await this.publish();return {runId:id,deleted:true};
  }
  async purgeRun(id:string,confirm:string):Promise<{runId:string;deleted:true}> {
    identifier(id);
    if(confirm!==id)throw new Error("400: permanent deletion requires the exact run id");
    if(this.get(`purged:run:${id}`))return {runId:id,deleted:true};
    const preceding=this.purges.get(id);if(preceding)return preceding;
    const work=this.performPurge(id).finally(()=>this.purges.delete(id));
    this.purges.set(id,work);return work;
  }
  private async performPurge(id:string):Promise<{runId:string;deleted:true}> {
    let run=this.run(id);
    if(run.repo!==`run-${id}`)throw new Error("409: protected or unexpected run repository; purge refused");
    if(!["trashed","purging"].includes(run.lifecycle ?? "active")){
      await this.trashRun(id);run=this.run(id);
    }
    if(!["trashed","purging"].includes(run.lifecycle ?? "active"))throw new Error("409: run was restored during deletion; confirm deletion again");
    const jobs=this.jobs(id), active=this.activeReceipt();
    if(active && active.input.runId!==id)throw new Error("409: another run is active; retry deletion after it finishes so shared scanner scratch can be cleared safely");
    if(this.uploads.get(id) || this.creations.has(id) || this.initializing.has(id) || this.preparingMaterials || this.acceptances.size || this.projections.has(id) || this.get(`publication:${id}`) || this.get<InputPreparation>("input:preparing")?.runId===id || jobs.some(job=>!terminal(job.status)))
      throw new Error("409: run publication or input preparation is still draining");
    for(const job of jobs){const state=await this.attempt(job.id).purgeReadiness(id);if(!state.drained || state.unresolvedRemote || state.sessionCleanupPending)throw new Error("409: attempt is draining or remote outcome is unresolved");}
    const writer = await this.activityWriter(id);
    this.ctx.storage.transactionSync(()=>{
      const latest=this.run(id);
      if(canonical(latest)!==canonical(run) || canonical(this.jobs(id))!==canonical(jobs) || canonical(this.activeReceipt())!==canonical(active) || this.uploads.get(id) || this.creations.has(id) || this.initializing.has(id) || this.preparingMaterials || this.acceptances.size || this.projections.has(id) || this.get(`publication:${id}`) || this.get<InputPreparation>("input:preparing")?.runId===id)
        throw new Error("409: run changed during purge preparation");
      if(active?.input.runId===id)this.put("active",null);
      this.put(`run:${id}`,{...latest,lifecycle:"purging",lifecycleRevision:(latest.lifecycleRevision ?? 0)+1});
      this.put(`purge:${id}`,{runId:id,repo:run.repo,jobIds:jobs.map(job=>job.id)} satisfies PurgeIntent);
    });
    await this.publish();
    if(this.env.TOOLBOX){
      const cleared=await this.env.TOOLBOX.clear();
      if(!("state" in cleared) || cleared.state!=="stopped")throw new Error("503: scanner scratch cleanup is pending; retry deletion");
    }else if(!this.env.TOOL_PACKS)throw new Error("503: scanner backend is unavailable; retry deletion after restoring its binding");
    for(const job of jobs)await this.attempt(job.id).purge(id);
    this.browserAuth.clear(id);
    this.loginChallenges.clear(id);
    await this.workspace.artifacts.delete(run.repo);
    for(const root of ["/projects","/accepted","/uploads"])await this.workspace.fs.rm(`${root}/${id}`,{recursive:true,force:true});
    writer.close({discard:true,commit:()=>{
      for(const job of jobs){
        for(const prefix of ["job:","order:","launch:","input:receipt:","conversation:"])this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",`${prefix}${job.id}`);
        this.put(`purged:job:${job.id}`,{id:job.id});this.launched.delete(job.id);
      }
      this.ctx.storage.sql.exec("DELETE FROM native_records WHERE substr(key,1,?)=?",`material:upload:${id}:`.length,`material:upload:${id}:`);
      for(const key of [`run:${id}`,`publication:${id}`,`purge:${id}`])this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",key);
      this.ctx.storage.sql.exec("DELETE FROM native_activity WHERE run_id=?",id);
      this.put(`purged:run:${id}`,{id});
      for(const key of ["onboarding:setup:"+id,"onboarding:api-proof:"+id,"onboarding:creation:"+id])this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",key);
      this.collectCredentialVersions();
    }});
    await this.publish();return {runId:id,deleted:true};
  }
  async report(id:string,jobId?:string) {
    const run=this.run(id),jobs=this.jobs(id).filter(job=>job.role==="reporter" && job.status==="completed" && job.outputCommit && job.terminal?.tool==="report_result");
    const job=jobId ? jobs.find(job=>job.id===jobId) : jobs.sort((a,b)=>(b.finishedAt ?? 0)-(a.finishedAt ?? 0))[0];
    if(!job)throw new Error("404: accepted report is unavailable");
    using repo=await this.env.ARTIFACTS.get(run.repo);
    const blob=await repo.readFile({ref:job.outputCommit!,path:`.pentagi/jobs/${job.id}/result.json`});
    if(!blob || blob.size>2*1024*1024)throw new Error("409: accepted report record is unavailable");
    const record=JSON.parse(await blob.text()) as Record<string,unknown>;
    if(record.run_id!==id || record.job_id!==job.id || record.role!=="reporter" || record.tool!=="report_result" || canonical(record.arguments)!==canonical(job.terminal?.arguments))throw new Error("409: accepted report provenance mismatch");
    const args=record.arguments as Record<string,unknown>,text=args.report ?? args.result;
    if(typeof text!=="string")throw new Error("409: accepted report has no Markdown body");
    return new Response(text,{headers:{"Content-Type":"text/markdown;charset=utf-8","Content-Disposition":`attachment; filename="${id}-report.md"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","X-Source-Commit":job.outputCommit!}});
  }
  async findings(runId:string,jobId:string){
    await this.start();const run=this.run(runId),job=this.jobs(runId).find(j=>j.id===jobId&&j.role==="reporter"&&j.status==="completed"&&j.outputCommit&&j.terminal?.tool==="report_result");
    if(!job)throw new Error("404: accepted reporter is unavailable");
    using repo=await this.env.ARTIFACTS.get(run.repo);
    const bundle=await readFindings(path=>repo.readFile({ref:job.outputCommit!,path}),job.id,job.findingsVersion===1);
    return {version:1,runId,jobId,commit:job.outputCommit!,...(bundle?{bundle}:{})};
  }
  async queueSnapshot() {
    return {
      concurrency: 1,
      maxOutstanding: 3,
      pending: this.orderedJobs().filter(job => job.status === "created" && this.run(job.runId).phase !== "cancelled" && (this.run(job.runId).lifecycle ?? "active") === "active")
        .map(job => ({ id: job.id, callback: "attempt", payload: { id: job.id }, createdAt: Math.floor(job.createdAt / 1000) })),
      jobs: this.jobs().map(this.presentJob),
    };
  }
  private async hasPath(path: string) {
    try {
      await this.workspace.fs.stat(path);
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    }
  }
  private async gitAuth(repo: string, scope: "read" | "write") {
    using r = await this.env.ARTIFACTS.get(repo);
    const token = await r.createToken(scope, 900);
    return {
      Authorization: `Basic ${btoa(`x:${token.plaintext.split("?expires=", 1)[0]}`)}`,
    };
  }
  async stageUpload(input: StageMaterialInput) {
    await this.start();
    identifier(input.runId, "run id");
    if (input.runId.length > 54) throw new Error("400: run id is too long");
    this.assertAdmissionOpen();
    if(this.get(`purged:run:${input.runId}`))throw new Error("409: run was permanently purged");
    if(this.get(`run:${input.runId}`))this.assertMutable(input.runId);
    if (this.get<RunRecord>(`run:${input.runId}`)?.phase === "cancelled") throw new Error("409: run was cancelled");
    const staged = this.list<{receipt?:{id:string}}>(`material:upload:${input.runId}:`).filter(Boolean);
    if (staged.length >= 32 && !staged.some(row => row.receipt?.id === input.id)) throw new Error("429: staged file limit reached for this run");
    this.uploads.set(input.runId,(this.uploads.get(input.runId) ?? 0)+1);
    try{return await this.materials.stage(input);}finally{const count=this.uploads.get(input.runId)!-1;if(count)this.uploads.set(input.runId,count);else this.uploads.delete(input.runId);}
  }
  private preparingMaterials: Promise<void> | undefined;
  private prepareNextMaterials(): Promise<void> {
    if (this.preparingMaterials) return this.preparingMaterials;
    const work = this.prepareMaterials().catch(async error => {
      const prep=this.get<InputPreparation | null>("input:preparing");
      const job=prep ? this.job(prep.jobId) : this.orderedJobs().find(j=>j.status==="created" && this.assessmentReady(j) && j.materialUploadIds?.length && !this.get(`input:receipt:${j.id}`));
      if(job && (terminal(job.status) || this.run(job.runId).phase==="cancelled")) {
        if(prep)this.put("input:preparing",null);
        throw error;
      }
      const message=error instanceof Error ? error.message : String(error);
      if(message.includes("material input boundary changed")) {
        if(prep)this.put("input:preparing",null);
        throw error;
      }
      if(job && /^(400|409):/.test(message)) {
        const writer = await this.activityWriter(job.runId);
        this.ctx.storage.transactionSync(()=>{
          if(this.job(job.id).status!=="created")return;
          this.put(`job:${job.id}`,{...this.job(job.id),status:"invalid_result",inputError:message,finishedAt:Date.now(),revision:job.revision+1});
          if(prep)this.put("input:preparing",null);
          if(this.activeReceipt()?.input.runId!==job.runId && this.jobs(job.runId).every(j=>terminal(j.status))) {
            const run=this.run(job.runId);
            this.put(`run:${run.id}`,{...run,phase:"completed",status:"failed",finalResponse:`File input rejected: ${message}`});
          }
          this.activity(writer,job.runId,"input.rejected",undefined,job.id,message);
        });
        await this.stopConversation(job.id);
        return;
      }
      throw error;
    }).finally(() => {if(this.preparingMaterials===work)this.preparingMaterials=undefined;});
    this.preparingMaterials=work;
    return work;
  }
  private assertInputPreparation(prep: InputPreparation) {
    if (this.activeReceipt() || this.run(prep.runId).phase === "cancelled" || this.run(prep.runId).headCommit !== prep.baseCommit || this.job(prep.jobId).status !== "created")
      throw new Error("409: material input boundary changed");
  }
  private async prepareMaterials() {
    if (this.activeReceipt()) return;
    let prep=this.get<InputPreparation | null>("input:preparing") ?? undefined;
    if (prep && (this.run(prep.runId).phase === "cancelled" || terminal(this.job(prep.jobId).status))) {this.put("input:preparing",null);prep=undefined;}
    if (!prep) {
      const job=this.orderedJobs().find(j=>j.status==="created" && this.assessmentReady(j) && this.run(j.runId).phase!=="cancelled");
      if (!job?.materialUploadIds?.length || this.get(`input:receipt:${job.id}`)) return;
      const run=this.run(job.runId);
      const selection=await this.materials.selection(run.id,job.materialUploadIds,run.materials);
      const intent:InputPreparation={jobId:job.id,runId:run.id,baseCommit:run.headCommit,selection,uploadIds:job.materialUploadIds,branch:`inputs/${job.id}`};
      this.ctx.storage.transactionSync(()=>{
        if(this.activeReceipt() || this.get("input:preparing") || this.run(run.id).headCommit!==run.headCommit || this.job(job.id).status!=="created" || this.run(run.id).phase==="cancelled")return;
        this.put("input:preparing",intent);prep=intent;
      });
      if(!prep)return;
    }
    const intent=prep;
    this.assertInputPreparation(intent);
    const run=this.run(intent.runId),dir=`/accepted/${run.id}`;
    if(!(await this.hasPath(`${dir}/.git`)))await this.workspace.git.clone({dir,url:run.remote,ref:"main",headers:await this.gitAuth(run.repo,"read")});
    if(!intent.commit){
      await this.workspace.git.fetch({dir,url:run.remote,ref:"main",headers:await this.gitAuth(run.repo,"read")});
      let branchHead:string|undefined;
      try{branchHead=await this.workspace.git.revParse({dir,ref:intent.branch});}catch{}
      if(branchHead && branchHead!==intent.baseCommit){
        const commit=await this.workspace.git.show({dir,ref:branchHead});
        if(commit.parent.length!==1 || commit.parent[0]!==intent.baseCommit)throw new Error("409: material input commit ancestry changed");
        await this.workspace.git.checkout({dir,ref:intent.branch});
        if((await this.workspace.git.status({dir})).length || await this.workspace.fs.readFile(`${dir}/${intent.selection.manifestPath}`,"utf8")!==selectionManifest(intent.selection))throw new Error("409: material input recovery changed the committed manifest");
        intent.commit=branchHead;
      }else{
        if(!branchHead)await this.workspace.git.branch({dir,name:intent.branch,startPoint:intent.baseCommit});
        // branch(checkout:true) moves HEAD only. The cached accepted index can
        // still precede main after publication; restore the pinned input tree.
        await this.workspace.git.checkout({dir,ref:intent.branch,force:true});
        await this.materials.copyInto(run.id,intent.uploadIds,dir);
        await this.workspace.fs.mkdir(`${dir}/.pentagi/materials/selections`,{recursive:true});
        await this.workspace.fs.writeFile(`${dir}/${intent.selection.manifestPath}`,selectionManifest(intent.selection));
        this.assertInputPreparation(intent);
        const paths=[intent.selection.manifestPath,...intent.uploadIds.flatMap(id=>{const f=this.materials.get(run.id,id).file;return[f.sourcePath,f.textPath];})];
        await this.workspace.git.add({dir,paths:[...new Set(paths)]});
        intent.commit=(await this.workspace.git.commit({dir,message:`pentcloud-input: ${intent.jobId} ${intent.selection.digest}`})).oid;
      }
      this.put("input:preparing",intent);
    }
    this.assertInputPreparation(intent);
    const permitted=new Set([intent.selection.manifestPath,...intent.uploadIds.flatMap(id=>{const f=this.materials.get(run.id,id).file;return[f.sourcePath,f.textPath];})]);
    for(const change of await this.workspace.git.diffSummary({dir,ref:intent.baseCommit,to:intent.commit}))if(!permitted.has(change.path))throw new Error("409: material input changed an unrelated file");
    const pushed=await this.workspace.git.push({dir,url:run.remote,ref:intent.branch,remoteRef:intent.branch,headers:await this.gitAuth(run.repo,"write")});
    if(!pushed.ok)throw new Error("503: immutable material input push failed");
    using remote=await this.env.ARTIFACTS.get(run.repo);
    const manifest=await remote.readFile({ref:intent.commit!,path:intent.selection.manifestPath});
    if(!manifest || await manifest.text()!==selectionManifest(intent.selection))throw new Error("503: material input manifest readback failed");
    for(const file of intent.selection.files){
      for(const [path,hash,size] of [[file.sourcePath,file.sha256,file.size],[file.textPath,file.textSha256,file.textSize]] as const){
        const blob=await remote.readFile({ref:intent.commit!,path});
        if(!blob || blob.size!==size || await materialHash(new Uint8Array(await blob.arrayBuffer()))!==hash)throw new Error("503: material input byte readback failed");
      }
    }
    const writer = await this.activityWriter(run.id);
    this.ctx.storage.transactionSync(()=>{
      this.assertInputPreparation(intent);
      const latest=this.run(run.id);
      this.put(`run:${run.id}`,{...latest,headCommit:intent.commit!,materials:intent.selection});
      this.put(`input:receipt:${intent.jobId}`,intent);
      this.put(`publication:${run.id}`,{runId:run.id,commit:intent.commit!,inputRef:intent.branch});
      this.put("input:preparing",null);
      this.activity(writer,run.id,"input.committed",undefined,intent.jobId);
    });
    await this.projectAccepted(run.id);
  }
  private acceptedFileCommit(run: RunRecord,commit:string) {
    if(!/^[a-f0-9]{40}$/.test(commit))throw new Error("400: immutable file commit is required");
    const allowed=new Set([run.inputCommit,run.headCommit,...this.jobs(run.id).flatMap(j=>[j.inputCommit,...(j.outputCommit?[j.outputCommit]:[]),...(j.evidenceCommits??[])]),
      ...this.list<InputPreparation>("input:receipt:").filter(p=>p.runId===run.id && p.commit).map(p=>p.commit!)]);
    if(!allowed.has(commit))throw new Error("404: file commit is not accepted by this run");
  }
  private materialsAt(run:RunRecord,commit:string):MaterialSelection|undefined {
    const receipt=this.list<InputPreparation>("input:receipt:").find(p=>p.runId===run.id && p.commit===commit);
    if(receipt)return receipt.selection;
    const job=this.jobs(run.id).find(j=>j.inputCommit===commit || j.outputCommit===commit);
    if(job?.context.materials)return job.context.materials as MaterialSelection;
    return commit===run.headCommit ? run.materials : undefined;
  }
  private materialBoundary(runId:string) {
    const run=this.run(runId);
    return canonical({head:run.headCommit,digest:run.materials?.digest,jobs:this.orderedJobs().filter(j=>j.runId===runId && j.status==="created").map(j=>({id:j.id,uploads:j.materialUploadIds??[]}))});
  }
  private async validatePendingMaterials(runId:string,uploads:string[]) {
    const boundary=this.materialBoundary(runId);
    let selection=this.run(runId).materials;
    for(const job of this.orderedJobs().filter(j=>j.runId===runId && j.status==="created" && j.materialUploadIds?.length && !this.get(`input:receipt:${j.id}`)))
      selection=await this.materials.selection(runId,job.materialUploadIds!,selection);
    await this.materials.selection(runId,uploads,selection);
    return boundary;
  }
  async files(runId:string,jobId?:string):Promise<RunFiles> {
    await this.start();
    const run=this.run(runId),job=jobId?this.job(jobId):undefined;
    if(job && job.runId!==runId)throw new Error("404: file attempt is not in this run");
    const commit=job?.outputCommit ?? job?.evidence?.commit ?? job?.inputCommit ?? run.headCommit;
    this.acceptedFileCommit(run,commit);
    const materials=(job?.context.materials as MaterialSelection|undefined) ?? this.materialsAt(run,commit);
    using repo=await this.env.ARTIFACTS.get(run.repo);
    const files:RunFile[]=[];
    const byPath=new Map((materials?.files??[]).flatMap(f=>[[f.sourcePath,f],[f.textPath,f]] as const));
    const evidenceByPath=new Map(this.jobs(runId).flatMap(j=>(j.evidenceFiles??[]).map(f=>[f.path,f] as const)));
    const metadata=await repo.readCommit(commit);
    const walk=async(tree:string,prefix:string):Promise<void>=>{
      const entries=await repo.readTree(tree);
      if(!entries)throw new Error("404: accepted file tree is unavailable");
      for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
        if(files.length>=128)return;
        const path=prefix?`${prefix}/${entry.name}`:entry.name;
        if([".git","node_modules","vendor","dist","build"].includes(entry.name) || path.startsWith(".pentagi/native") || path.startsWith(".pentagi/jobs") || path.startsWith(".pentagi/materials/selections"))continue;
        if(entry.type==="tree")await walk(entry.hash,path);
        else if(entry.type==="blob" || entry.type==="exec"){
          const blob=await repo.readFile({ref:commit,path});if(!blob)continue;
          const material=byPath.get(path),derived=!!material && material.textPath===path && material.sourcePath!==path;
          let previewable=!!material && (material.kind==="text" || derived);
          if(!material && blob.size<=2*1024*1024){try{const text=new TextDecoder("utf-8",{fatal:true}).decode(await blob.arrayBuffer());previewable=!text.includes("\0");}catch{}}
          files.push({path,name:material?(derived?`${material.name}.md`:material.name):path.split("/").at(-1)!,size:blob.size,mediaType:material?(derived?"text/markdown":material.mediaType):(previewable?"text/plain":"application/octet-stream"),kind:material?(derived?"derived":"input"):"output",commit,previewable,
            ...(material?{sha256:derived?material.textSha256:material.sha256,...(derived?{sourceSha256:material.sha256}:{})}:evidenceByPath.has(path)?{sha256:evidenceByPath.get(path)!.sha256,...(evidenceByPath.get(path)!.sourceSha256?{sourceSha256:evidenceByPath.get(path)!.sourceSha256}:{})}:{})});
        }
      }
    };
    if(!metadata)throw new Error("404: accepted file commit is unavailable");
    await walk(metadata.treeHash,"");
    return {runId,commit,files,...(materials?{materialsDigest:materials.digest}:{})};
  }
  async file(runId:string,commit:string,requested:string,preview=false):Promise<Response> {
    await this.start();
    const run=this.run(runId);this.acceptedFileCommit(run,commit);
    const path=confinedFilePath(requested);
    using repo=await this.env.ARTIFACTS.get(run.repo);
    const blob=await repo.readFile({ref:commit,path});
    if(!blob)throw new Error("404: accepted file is unavailable");
    const material=this.materialsAt(run,commit)?.files.find(f=>f.sourcePath===path || f.textPath===path);
    const name=material?(material.sourcePath===path?material.name:`${material.name}.md`):path.split("/").at(-1)!;
    const hash=material?(material.sourcePath===path?material.sha256:material.textSha256):undefined;
    const headers:Record<string,string>={"ETag":`"${commit}:${hash??encodeURIComponent(path)}"`,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox","Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};
    if(preview){
      if(blob.size>2*1024*1024 || (material?.kind==="document" && material.sourcePath===path))throw new Error("400: use download for this file");
      const bytes=new Uint8Array(await blob.arrayBuffer());
      let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error("400: binary file is download-only");}
      if(text.includes("\0"))throw new Error("400: binary file is download-only");
      headers["Content-Type"]="text/plain;charset=utf-8";headers["X-Content-Truncated"]=String(bytes.byteLength>65536);
      return new Response(new TextDecoder().decode(bytes.slice(0,65536)),{headers});
    }
    headers["Content-Type"]=material?.sourcePath===path?material.mediaType:"application/octet-stream";
    headers["Content-Disposition"]=`attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g,"%27")}`;
    return new Response(blob,{headers});
  }
  private project(runId: string) {
    const prior = this.initializing.get(runId);
    if (prior) return prior;
    const work = this.initializeProject(runId).finally(() => {
      if (this.initializing.get(runId) === work)
        this.initializing.delete(runId);
    });
    this.initializing.set(runId, work);
    return work;
  }
  private async initializeProject(runId: string) {
    const repo = `run-${runId}`;
    // Retain ownership across failed/uncertain initialization until admission or
    // explicit draft cleanup. A slower duplicate may reach here after admission;
    // its repository is already owned even if its objective later conflicts.
    const admitted=this.get<RunRecord>(`run:${runId}`);
    if(admitted && admitted.repo!==repo)throw new Error("409: run repository changed during initialization");
    if(!admitted)this.put(`project:owned:${runId}`,{runId,repo});
    let info;
    try {
      info = await this.workspace.artifacts.get(repo);
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "NOT_FOUND")
        throw e;
      await this.workspace.artifacts.create(repo, {
        description: "PentCloud immutable run evidence",
        setDefaultBranch: "main",
      });
      info = await this.workspace.artifacts.get(repo);
    }
    using remote = await this.env.ARTIFACTS.get(repo);
    const history = await remote.log({ ref: "main", limit: 1 });
    if (!history.length) {
      const dir = `/projects/${runId}`;
      if (!(await this.hasPath(`${dir}/.git`))) {
        await this.workspace.fs.mkdir(dir, { recursive: true });
        await this.workspace.git.init({ dir, defaultBranch: "main" });
      }
      let head: string | undefined;
      try {
        head = await this.workspace.git.revParse({ dir, ref: "main" });
      } catch {}
      if (!head) {
        await this.workspace.fs.writeFile(
          `${dir}/README.md`,
          "# PentCloud run\n\nAccepted work and findings are committed here.\n",
        );
        await this.workspace.git.add({ dir, paths: ["README.md"] });
        await this.workspace.git.commit({
          dir,
          message: "pentcloud: initialize run",
        });
      }
      const pushed = await this.workspace.git.push({
        dir,
        url: info.remote,
        ref: "main",
        headers: await this.gitAuth(repo, "write"),
      });
      if (!pushed.ok)
        throw new Error(
          "503: run initialization publication failed; retry same run identity",
        );
    }
    using r = await this.env.ARTIFACTS.get(repo);
    const head = (await r.log({ ref: "main", limit: 1 }))[0];
    if (!head) throw new Error("Run initialization produced no commit");
    return { repo, remote: info.remote, head: head.hash };
  }
  async createRun(input: NewRunInput) {
    const id=identifier(input.run_id,"run id");
    this.creations.set(id,(this.creations.get(id) ?? 0)+1);
    try { return await this.prepareRun(input); }
    finally {
      const remaining=this.creations.get(id)!-1;
      if(remaining)this.creations.set(id,remaining);else this.creations.delete(id);
    }
  }
  private async prepareRun(input: NewRunInput) {
    await this.start();
    const id = identifier(input.run_id, "run id");
    this.assertAdmissionOpen();
    if(this.get(`purged:run:${id}`))throw new Error("409: run was permanently purged");
    const uploadIds = normalizeUploadIds(input.upload_ids);
    if (id.length > 54)
      throw new Error("400: run id must contain at most 54 characters");
    if (
      typeof input.task !== "string" ||
      !input.task.trim() ||
      input.task.length > 32000
    )
      throw new Error("400: objective must contain 1 to 32000 characters");
    const prior = this.get<RunRecord>(`run:${id}`);
    if (prior) {
      this.assertMutable(id);
      if (prior.task !== input.task || prior.target?.id !== input.target_id || prior.target?.revision !== input.target_revision || canonical(prior.initialUploadIds ?? []) !== canonical(uploadIds))
        throw new Error("409: run identity reused with changed objective");
      return {
        run: publicRun(prior),
        rootJob: publicJob(
          this.orderedJobs().find(
            (j) => j.runId === id && (prior.activation ? j.role==="primary"&&!j.parentJobId&&!j.execution : j.tool === "native_discovery") && !j.revisionOf,
          )!,
        ),
      };
    }
    if (!input.target_id || !Number.isInteger(input.target_revision) || input.authorized !== true) throw new Error("400: Select a saved target, verify its address and confirm authorization");
    const addressProof=this.onboarding.requireTargetProof(input.target_id,input.target_revision!);
    const target=this.onboarding.target(input.target_id);
    const programAccess=await this.programAccess(target);
    if(this.onboarding.target(target.id).revision!==target.revision)throw Error('409: Target changed during program verification');
    if (outstanding(this.admissionJobs()) >= 3)
      throw new Error("429: queue full");
    const current = await this.settings();
    if (ACTIVE_ROLES.some(role => current.settings.roles[role].promptFormat !== "markdown"))
      throw new Error("400: Legacy prompt template execution is retired; reset legacy roles to Markdown instructions in settings before starting a new run");
    if (uploadIds.length) await this.materials.selection(id, uploadIds);
    const creationInput:NewRunInput={run_id:id,task:input.task,target_id:input.target_id,target_revision:input.target_revision!,authorized:true,...(input.launch_time?{launch_time:input.launch_time}:{}),...(uploadIds.length?{upload_ids:uploadIds}:{})};
    const intent=this.get<{input:NewRunInput}>("onboarding:creation:"+id);
    if(intent&&canonical(intent.input)!==canonical(creationInput))throw new Error("409: Run creation identity reused with changed input");
    if(!intent)this.put("onboarding:creation:"+id,{input:creationInput,target});
    const project = await this.project(id);
    const run: RunRecord = {
      id,
      task: input.task,
      status: "created",
      repo: project.repo,
      remote: project.remote,
      inputCommit: project.head,
      headCommit: project.head,
      settingsRevision: current.settings.revision,
      settings: current.settings,
      createdAt: Date.now(),
      wave: 0,
      phase: "discovery",
      target,
      ...(programAccess?{programAccess}:{}),
      authorization:{actor:input.actor??"operator",at:Date.now(),disclosureVersion:"2026-11-01"},
      maxDepth: 4,
      maxJobs: 48,
      ...(uploadIds.length ? {initialUploadIds:uploadIds} : {}),
    };
    const job = await this.makeJob(
      run,
      "pentester",
      "native_discovery",
      { task: run.task, target:target.url, profile:"whatweb-stealthy-v2" },
      undefined,
      undefined,
      `primary-${(await digest({ run: id, initial: true })).slice(0, 32)}`,
      uploadIds,
    );
    job.execution={kind:"discovery",url:target.url,profile:"whatweb-stealthy-v2"};
    const writer = await this.activityWriter(id, true);
    const pushes: Promise<unknown>[] = [];
    this.ctx.storage.transactionSync(() => {
      this.assertAdmissionOpen();
      if(this.get(`purged:run:${id}`))throw new Error("409: run was permanently purged");
      const existing = this.get<RunRecord>(`run:${id}`);
      if (existing) {
        if (existing.task !== input.task || existing.target?.id !== input.target_id || existing.target?.revision !== input.target_revision || canonical(existing.initialUploadIds ?? []) !== canonical(uploadIds))
          throw new Error("409: run identity reused with changed objective");
        // A slower duplicate may have initialized after the first admission.
        // Its repository is already owned by that run, not an orphaned draft.
        const owned=this.get<{runId:string;repo:string}>(`project:owned:${id}`);
        if(owned?.runId===id && owned.repo===existing.repo)
          this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?",`project:owned:${id}`);
        return;
      }
      if (
        this.get<{ settings: AgentSettings }>("settings:current")?.settings
          .revision !== run.settingsRevision
      )
        throw new Error(
          "409: settings changed during run initialization; retry",
        );
      this.onboarding.requireTargetProof(input.target_id!,input.target_revision!);
      assertAdmission(this.admissionJobs(), job.id, job.fingerprint);
      this.put("run:"+id, run);
      const defaults=this.get<{draft:SetupDraft}>("onboarding:defaults:"+target.id);
      this.put("onboarding:setup:"+id,defaults?{...defaults.draft,revision:0,updatedBy:"target defaults"}:{revision:0,publicAPI:target.kind!=="api"||!target.access?.api&&addressProof.classification!=="needs-auth",updatedBy:"system"});
      this.ctx.storage.sql.exec("DELETE FROM native_records WHERE key=?","project:owned:"+id);
      this.enqueue(job, pushes);
      this.activity(writer, id, "run.started");
    });
    await Promise.all(pushes);
    await this.publish();
    return {
      run: publicRun(this.run(id)),
      rootJob: publicJob(this.job(job.id)),
    };
  }
  private async makeJob(
    run: RunRecord,
    role: Role,
    tool: string,
    args: Record<string, unknown>,
    parent?: AttemptRecord,
    revisionOf?: AttemptRecord,
    stableId?: string,
    materialUploadIds: string[] = [],
  ): Promise<AttemptRecord> {
    const id = stableId ?? `${role}-${crypto.randomUUID()}`;
    identifier(id);
    const settings: RoleSettings =
      role === "reporter"
        ? { ...run.settings.roles.primary, promptTemplate: run.settings.roles.primary.promptFormat === "markdown" ? specialistSources.reporter : run.settings.roles.primary.promptTemplate }
        : run.settings.roles[role];
    const input: AttemptInput = {
      id,
      runId: run.id,
      role,
      tool,
      args,
      task: String(args.task ?? args.question ?? args.instructions ?? run.task),
      inputCommit: run.headCommit,
      repo: run.repo,
      remote: run.remote,
      settingsRevision: run.settingsRevision,
      ...(run.target?.access?{targetConfig:run.target}:{}),
      settings: run.modelsByRole ? {...settings,model:run.modelsByRole[role].id,reasoningEffort:"default"} : settings,
      ...(run.modelsByRole ? {modelConfig:run.modelsByRole[role]} : {}),
      ...(revisionOf?.parentJobId
        ? { parentJobId: revisionOf.parentJobId }
        : parent
          ? { parentJobId: parent.id }
          : {}),
      depth: revisionOf?.depth ?? (parent ? parent.depth + 1 : 0),
      attempt: revisionOf ? revisionOf.attempt + 1 : 1,
      logicalThreadId: revisionOf?.logicalThreadId ?? id,
      ...(revisionOf ? { revisionOf: revisionOf.id } : {}),
      ...(role==="reporter" ? {findingsVersion:1 as const} : {}),
      context: {},
      createdAt: Date.now(),
    };
    return {
      ...input,
      status: "created",
      revision: 0,
      fingerprint: await digest({
        runId: run.id,
        role,
        tool,
        args,
        settingsRevision: run.settingsRevision,
        ...(revisionOf ? { revisionOf: revisionOf.id } : {}),
        ...(materialUploadIds.length ? {materialUploadIds} : {}),
      }),
      ...(materialUploadIds.length ? {materialUploadIds} : {}),
    };
  }
  async delegate(
    parentId: string,
    tool: string,
    args: Record<string, unknown>,
  ) {
    await this.assertActive(parentId);
    const parent = this.job(parentId),
      run = this.run(parent.runId);
    if (!catalogForRole(parent.role).some((t) => t.name === tool))
      throw new Error("403: delegation tool forbidden for parent role");
    validateToolInput(tool, args);
    if (tool === "revise_attempt") {
      if (parent.role !== "primary")
        throw new Error("403: revisions require primary authority");
      const target = this.job(String(args.job_id));
      if (
        target.runId !== run.id ||
        ["primary", "reporter"].includes(target.role)
      )
        throw new Error("403: revision target must be a same-run specialist");
      const receipt = await this.revise(
        target.id,
        String(args.instructions),
        await digest({ parentId, tool, args }),
        parentId,
      );
      return { job_id: receipt.job.id, status: "dispatched", queued: true };
    }
    const role = delegateRoles[tool];
    if (!role) throw new Error("400: invalid delegation role");
    const fingerprint = await digest({ parentId, tool, args }),
      id = `${role}-${fingerprint.slice(0, 32)}`;
    const job = await this.makeJob(
        run,
        role,
        tool,
        args,
        parent,
        undefined,
        id,
      ),
      pushes: Promise<unknown>[] = [];
    this.ctx.storage.transactionSync(() => {
      const current = this.job(parentId),
        currentRun = this.run(run.id);
      if (
        current.status !== "running" ||
        this.activeReceipt()?.id !== parentId ||
        currentRun.phase === "cancelled"
      )
        throw new Error("409: parent stopped");
      if (!assertAdmission(this.admissionJobs(), id, job.fingerprint)) return;
      if (
        current.depth >= currentRun.maxDepth ||
        this.jobs(run.id).length >= currentRun.maxJobs - 1
      )
        throw new Error("429: run delegation limit reached");
      this.enqueue(job, pushes);
    });
    await Promise.all(pushes);
    await this.publish();
    return { job_id: id, status: "dispatched", queued: true };
  }
  async assertActive(id: string) {
    await this.start();
    const job = this.job(id);
    this.assertMutable(job.runId);
    if (
      this.activeReceipt()?.id !== id ||
      job.status !== "running" ||
      this.run(job.runId).phase === "cancelled"
    )
      throw new Error("409: attempt is no longer active");
  }
  async getContext(id: string) {
    await this.start();
    return this.contextFor(id);
  }
  async accept(
    result: AttemptResult,
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    await this.start();
    const value = canonical(result),
      prior = this.acceptances.get(result.id);
    if (prior) {
      if (prior.value !== value)
        throw new Error("409: completion changed during acceptance");
      return prior.promise;
    }
    const promise = this.acceptCandidate(result).finally(() => {
      if (this.acceptances.get(result.id)?.promise === promise)
        this.acceptances.delete(result.id);
    });
    this.acceptances.set(result.id, { value, promise });
    return promise;
  }
  private async acceptCandidate(
    result: AttemptResult,
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    let job = this.job(result.id),
      run = this.run(job.runId);
    this.assertMutable(run.id);
    if (job.terminal) {
      if (canonical(job.terminal) !== canonical(result))
        throw new Error("409: attempt already settled differently");
      await this.projectAccepted(run.id);
      return { accepted: true, duplicate: true };
    }
    assertCompletion(job, result, run);
    if (this.activeReceipt()?.id !== job.id)
      throw new Error("409: attempt does not own execution");
    this.validateTerminal(job, result);
    using repo = await this.env.ARTIFACTS.get(run.repo);
    const file = await repo.readFile({
      ref: result.outputCommit!,
      path: `.pentagi/jobs/${job.id}/result.json`,
    });
    if (!file || file.size > 2 * 1024 * 1024)
      throw new Error("400: candidate result absent or too large");
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(await file.text()) as Record<string, unknown>;
    } catch {
      throw new Error("400: malformed committed terminal record");
    }
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error("400: committed terminal record must be an object");
    if (
      record.findings_version !== job.findingsVersion ||
      record.version !== 1 ||
      record.job_id !== job.id ||
      record.run_id !== run.id ||
      record.role !== job.role ||
      record.status !== result.status ||
      record.finished_at !== result.finishedAt ||
      record.input_commit !== job.inputCommit ||
      record.prompt_digest !== result.promptDigest ||
      record.settings_revision !== job.settingsRevision ||
      record.model !== (job.execution ? null : job.settings.model)
      || record.execution_kind !== (job.execution ? "discovery" : undefined)
      || canonical(record.model_config) !== canonical(job.modelConfig)
      || canonical(record.execution) !== canonical(job.execution) ||
      record.tool !== result.tool ||
      canonical(record.arguments) !== canonical(result.arguments)
      || canonical(record.runtime_provenance) !== canonical(result.runtime)
      || record.materials_digest !== (job.context.materials as MaterialSelection|undefined)?.digest
      || result.materialsDigest !== (job.context.materials as MaterialSelection|undefined)?.digest
    )
      throw new Error("400: candidate result provenance mismatch");
    if(job.role==="reporter" && result.status==="completed")await readFindings(path=>repo.readFile({ref:result.outputCommit!,path}),job.id,job.findingsVersion===1);
    if(job.evidence)await assertEvidencePreserved(repo,result.outputCommit!,job.evidence,job.evidenceFiles??[]);
    await this.assertActive(job.id);
    const dir = `/accepted/${run.id}`;
    if (!(await this.hasPath(`${dir}/.git`)))
      await this.workspace.git.clone({
        dir,
        url: run.remote,
        ref: "main",
        headers: await this.gitAuth(run.repo, "read"),
      });
    await this.workspace.git.fetch({
      dir,
      url: run.remote,
      ref: `attempts/${job.id}`,
      headers: await this.gitAuth(run.repo, "read"),
    });
    const seen = new Set<string>();
    let pending = [result.outputCommit!],
      found = false;
    for (let depth = 0; pending.length && depth < 1000 && !found; depth++) {
      const refs = pending.filter((ref) => !seen.has(ref));
      if (refs.length > 1024 || seen.size + refs.length > 4096)
        throw new Error("400: candidate history exceeds bound");
      refs.forEach((ref) => seen.add(ref));
      const commits = await Promise.all(
        refs.map((ref) => this.workspace.git.show({ dir, ref })),
      );
      found = commits.some((commit) => commit.parent.includes(job.inputCommit));
      pending = commits
        .flatMap((commit) => commit.parent)
        .filter((ref) => !seen.has(ref));
    }
    if (!found)
      throw new Error("400: candidate does not descend from accepted input");
    for (const change of await this.workspace.git.diffSummary({
      dir,
      ref: job.inputCommit,
      to: result.outputCommit!,
    })) {
      if (change.path !== `.pentagi/jobs/${job.id}/result.json` && !(job.evidence&&(change.path===job.evidence.manifestPath||job.evidenceFiles?.some(f=>f.path===change.path)))) {
        try {
          assertRoleWrite(job.role, job.id, change.path);
        } catch (error) {
          throw new Error(`400: candidate role write policy: ${String(error)}`);
        }
      }
    }
    // Immutable evidence exists before this transaction. This is the only local
    // acceptance point; main is a repairable projection of its durable receipt.
    this.ctx.storage.transactionSync(() => {
      job = this.job(job.id);
      run = this.run(run.id);
      assertCompletion(job, result, run);
      if (this.activeReceipt()?.id !== job.id)
        throw new Error("409: execution ownership changed");
      this.put(`job:${job.id}`, {
        ...job,
        status: result.status,
        outputCommit: result.outputCommit,
        promptDigest: result.promptDigest,
        terminal: result,
        finishedAt: result.finishedAt,
        revision: job.revision + 1,
      });
      this.put(`run:${run.id}`, {
        ...run,
        headCommit: result.outputCommit!,
        phase:
          job.execution ? run.activation?run.phase:"setup" : job.role === "primary"
            ? result.tool === "done"
              ? "reporting"
              : "specialists"
            : run.phase,
      });
      this.put(`publication:${run.id}`, {
        runId: run.id,
        commit: result.outputCommit!,
        attempt: job.id,
      });
    });
    await this.projectAccepted(run.id);
    await this.publish();
    await this.wake();
    return { accepted: true };
  }
  private validateTerminal(job: AttemptRecord, result: AttemptResult) {
    if(job.execution) {
      if(result.tool!=="native_discovery" || result.executionKind!=="discovery" || result.model!==null || result.arguments?.profile!==job.execution.profile || result.arguments?.target!==job.execution.url)
        throw new Error("400: Invalid discovery provenance");
      const outcome=discoveryOutcome(result.arguments.result);
      if(result.arguments.success!==outcome.success||result.status!==(outcome.success?"completed":"failed")||!Number.isSafeInteger(result.finishedAt))throw new Error("400: Discovery status does not match its recorded outcome");
      return;
    }
    const tools: Record<Role, string[]> = {
      primary: ["done", "yield", "ask"],
      adviser: ["advice"],
      coder: ["code_result"],
      maintenance: ["maintenance_result"],
      memorist: ["memorist_result"],
      pentester: ["hack_result"],
      searcher: ["search_result"],
      reporter: ["report_result"],
    };
    if (
      !result.tool ||
      !tools[job.role].includes(result.tool) ||
      !result.arguments ||
      typeof result.arguments !== "object" ||
      Array.isArray(result.arguments) ||
      !Number.isSafeInteger(result.finishedAt) ||
      result.finishedAt < 0
    )
      throw new Error("400: invalid role terminal result");
    if (
      job.role !== "adviser" &&
      !catalogForRole(
        job.role,
        Array.isArray(job.context.enabledTools)
          ? job.context.enabledTools.filter(
              (tool): tool is string => typeof tool === "string",
            )
          : [],
      ).some((tool) => tool.name === result.tool)
    )
      throw new Error("403: terminal tool is not enabled for this attempt");
    if (job.role === "adviser") {
      if (
        typeof result.arguments.result !== "string" ||
        !result.arguments.result.trim()
      )
        throw new Error("400: adviser result requires text");
    } else {
      try {
        validateToolInput(result.tool, result.arguments);
      } catch (error) {
        throw new Error(`400: invalid terminal arguments: ${String(error)}`);
      }
    }
    const expected = ["ask", "yield"].includes(result.tool)
      ? "waiting"
      : result.arguments.success === false
        ? "failed"
        : "completed";
    if (result.status !== expected)
      throw new Error("400: status does not match terminal tool");
  }
  private projectAccepted(runId: string): Promise<void> {
    const prior = this.projections.get(runId);
    if (prior) return prior;
    const work = this.projectReceipts(runId).finally(() => {
      if (this.projections.get(runId) === work) this.projections.delete(runId);
    });
    this.projections.set(runId, work);
    return work;
  }
  private async projectReceipts(runId: string) {
    for (;;) {
      const receipt = this.get<Publication | null>(`publication:${runId}`);
      if (!receipt) return;
      const run = this.run(runId);
      if (run.headCommit !== receipt.commit)
        throw new Error(
          "409: publication receipt does not match accepted head",
        );
      const dir = `/accepted/${runId}`;
      if (!(await this.hasPath(`${dir}/.git`)))
        await this.workspace.git.clone({
          dir,
          url: run.remote,
          ref: "main",
          headers: await this.gitAuth(run.repo, "read"),
        });
      await this.workspace.git.fetch({
        dir,
        url: run.remote,
        ref: receipt.inputRef ?? `attempts/${receipt.attempt}`,
        headers: await this.gitAuth(run.repo, "read"),
      });
      await this.workspace.git.updateRef({
        dir,
        ref: "refs/heads/main",
        value: receipt.commit,
        force: true,
      });
      const pushed = await this.workspace.git.push({
        dir,
        url: run.remote,
        ref: "main",
        headers: await this.gitAuth(run.repo, "write"),
      });
      if (!pushed.ok)
        throw new Error("503: accepted main projection could not be published");
      this.ctx.storage.transactionSync(() => {
        if (canonical(this.get(`publication:${runId}`)) === canonical(receipt))
          this.put(`publication:${runId}`, null);
      });
    }
  }
  async reconcile(repoName: string, ref: string, commit: string) {
    await this.start();
    const match = ref.match(/^refs\/heads\/attempts\/([A-Za-z0-9._-]+)$/);
    if (!match || !/^[a-f0-9]{40}$/.test(commit)) return { ignored: true };
    const job = this.get<AttemptRecord>(`job:${match[1]}`);
    if (!job || this.run(job.runId).repo !== repoName) return { ignored: true };
    if (job.outputCommit === commit && job.terminal) {
      await this.projectAccepted(job.runId);
      return { accepted: true, duplicate: true };
    }
    if (
      job.status !== "running" ||
      this.activeReceipt()?.id !== job.id ||
      this.run(job.runId).phase === "cancelled"
    )
      return { ignored: true };
    // A push may arrive before Attempt.publish has durably settled locally. Do
    // not revoke its active fence in the middle of publication. Recovery resumes
    // the pinned attempt after eviction and obtains its exact durable result.
    const execution = await this.attempt(job.id).execution();
    if (!execution.result) {
      await this.wake();
      return { pending: true };
    }
    if (execution.result.outputCommit !== commit) return { ignored: true };
    return this.accept(execution.result);
  }
  private async advance() {
    for (const expected of this.list<RunRecord>("run:").sort(
      (a, b) => a.createdAt - b.createdAt,
    )) {
      if (
        ["completed", "cancelled", "discovery", "setup"].includes(expected.phase) ||
        (expected.lifecycle ?? "active")!=="active" ||
        this.get(`publication:${expected.id}`) ||
        this.activeReceipt()?.input.runId === expected.id ||
        this.jobs(expected.id).some((j) => !terminal(j.status))
      )
        continue;
      const jobs = this.jobs(expected.id),
        last = [...jobs].sort(
          (a, b) =>
            (b.finishedAt ?? 0) - (a.finishedAt ?? 0) ||
            (this.get<number>(`order:${b.id}`) ?? 0) -
              (this.get<number>(`order:${a.id}`) ?? 0),
        )[0];
      if (!last) continue;
      if (last.role === "reporter") {
        const writer = await this.activityWriter(expected.id);
        this.ctx.storage.transactionSync(() => {
          const run = this.run(expected.id);
          if (
            canonical(run) !== canonical(expected) ||
            this.jobs(run.id).some((j) => !terminal(j.status))
          )
            return;
          const success =
            last.status === "completed" &&
            last.terminal?.tool === "report_result" &&
            last.terminal.arguments?.success !== false;
          this.put(`run:${run.id}`, {
            ...run,
            phase: "completed",
            status: success ? "completed" : "failed",
            finalResponse: String(
              last.terminal?.arguments?.report ??
                last.terminal?.arguments?.result ??
                last.terminal?.arguments?.message ??
                last.terminal?.error ??
                "Reporter did not produce a valid terminal result",
            ),
          });
          this.activity(writer, run.id, success ? "run.completed" : "run.failed");
        });
        continue;
      }
      if (outstanding(this.admissionJobs()) >= 3) continue;
      const role: Role =
        expected.phase === "reporting" ||
        expected.wave >= 8 ||
        jobs.length >= expected.maxJobs - 1
          ? "reporter"
          : "primary";
      const context = jobs
        .filter((j) => j.terminal || j.inputError)
        .map((j) => ({
          id: j.id,
          role: j.role,
          status: j.status,
          commit: j.outputCommit,
          result: j.terminal,
          ...(j.inputError ? {input_error: j.inputError} : {}),
        }));
      const args = {
        task: expected.task,
        instructions:
          role === "reporter"
            ? "Synthesize accepted findings and evidence; call report_result."
            : "Review the accepted work and findings. Delegate only necessary remaining work, then yield. Call done when the objective is complete.",
        results: context,
      };
      const next = await this.makeJob(
          expected,
          role,
          role,
          args,
          undefined,
          undefined,
          `${role}-${(await digest({ run: expected.id, wave: expected.wave + 1 })).slice(0, 32)}`,
        ),
        pushes: Promise<unknown>[] = [];
      this.ctx.storage.transactionSync(() => {
        const run = this.run(expected.id);
        if (
          canonical(run) !== canonical(expected) ||
          this.activeReceipt()?.input.runId === run.id ||
          this.get(`publication:${run.id}`) ||
          this.jobs(run.id).some((j) => !terminal(j.status))
        )
          return;
        if (!assertAdmission(this.admissionJobs(), next.id, next.fingerprint))
          return;
        this.put(`run:${run.id}`, {
          ...run,
          phase: role === "reporter" ? "reporting" : "review",
          wave: run.wave + 1,
        });
        this.enqueue(next, pushes);
      });
      await Promise.all(pushes);
    }
  }
  // Called inside the same synchronous transaction as a lifecycle fence.
  private markRunCancelled(writer: StreamWriter, id: string) {
    let owner: string | undefined;
    const run = this.run(id);
    this.put(`run:${id}`, { ...run, phase: "cancelled", status: "interrupted" });
    for (const job of this.jobs(id)) {
      if (terminal(job.status)) continue;
      this.put(`job:${job.id}`, { ...job, status: "interrupted", finishedAt: Date.now(), revision: job.revision + 1 });
    }
    const active = this.activeReceipt();
    if (active?.input.runId === id && this.job(active.id).status === "interrupted") owner = active.id;
    this.activity(writer, id, "run.interrupted");
    return { owner };
  }
  private async finishRunCancellation(id: string, capture: {owner:string|undefined}) {
    await this.start();
    const hosts=new Set([...(capture.owner?[capture.owner]:[]),...this.jobs(id).filter(job=>this.get("conversation:"+job.id)).map(job=>job.id)]);
    await Promise.all([...hosts].map(id=>this.get("conversation:"+id)?this.stopConversation(id):this.attempt(id).cancel()));
    await this.wake();
    await this.publish();
    return { cancelled: true, draining: !!capture.owner };
  }
  async cancelRun(id: string) {
    await this.start();
    const writer = await this.activityWriter(id);
    const capture = this.ctx.storage.transactionSync(() => this.markRunCancelled(writer,id));
    return this.finishRunCancellation(id, capture);
  }
  async interrupt(id: string) {
    await this.start();
    let owner = false;
    this.ctx.storage.transactionSync(() => {
      const job = this.job(id);
      if (terminal(job.status))
        throw new Error("409: attempt already finished");
      this.put(`job:${id}`, {
        ...job,
        status: "interrupted",
        finishedAt: Date.now(),
        revision: job.revision + 1,
      });
      owner = this.activeReceipt()?.id === id;
    });
    if (owner||this.get("conversation:"+id)) await this.attempt(id).cancel();
    await this.wake();
    await this.publish();
    return { interrupted: true, draining: owner };
  }
  async reconcileToolOutcome(id: string) {
    await this.start();
    const job = this.job(id);
    if (this.activeReceipt()?.id === id) {
      await this.wake();
      return { reconciling: true, alreadyDrained: false };
    }
    if (terminal(job.status)) {
      await this.wake();
      return { reconciling: true, alreadyDrained: true };
    }
    throw new Error("409: attempt does not hold the global execution slot");
  }
  async steer(id: string, message: string) {
    if(!this.run(this.job(id).runId).target)throw new Error("409: Select a target and start a new run");
    if(this.job(id).execution)throw new Error("409: Discovery does not accept chat steering");
    await this.assertConversation(id);
    if (!message.trim() || message.length > 32000)
      throw new Error("400: invalid steering message");
    await (
      this.env.ATTEMPTS.getByName(id) as unknown as {
        steer(message: string): Promise<void>;
      }
    ).steer(message);
    return { steered: true };
  }
  async revise(
    id: string,
    instructions: string,
    requestId: string,
    parentId?: string,
    uploadIdsInput?: string[],
  ) {
    await this.start();
    const old = this.job(id);
    if(!parentId && !this.run(old.runId).target)throw new Error("409: Select a target and start a new run");
    if(old.execution)throw new Error("409: Start a new run to repeat discovery");
    this.assertMutable(old.runId);
    const uploadIds = normalizeUploadIds(uploadIdsInput);
    if (!terminal(old.status) && !uploadIds.length)
      throw new Error("409: stop the attempt before revising");
    if (
      !instructions.trim() ||
      instructions.length > 32000 ||
      !requestId ||
      requestId.length > 200
    )
      throw new Error("400: invalid revision instructions or request identity");
    const expected = this.run(old.runId),
      nextId = `revision-${(await digest({ id, requestId })).slice(0, 32)}`;
    const job = await this.makeJob(
        expected,
        old.role,
        old.tool,
        { ...old.args, instructions },
        undefined,
        old,
        nextId,
        uploadIds,
      ),
      pushes: Promise<unknown>[] = [];
    const prior=this.get<AttemptRecord>(`job:${job.id}`);
    if(prior) {
      if(prior.fingerprint!==job.fingerprint)throw new Error("409: attempt identity reused with changed input");
      return {job:publicJob(prior)};
    }
    const materialBoundary=uploadIds.length ? await this.validatePendingMaterials(old.runId,uploadIds) : undefined;
    const writer = await this.activityWriter(old.runId);
    this.ctx.storage.transactionSync(() => {
      const run = this.run(old.runId);
      this.assertMutable(run.id);
      if(materialBoundary && materialBoundary!==this.materialBoundary(run.id))throw new Error("409: pending material selection changed; retry submission");
      if (run.phase === "cancelled") throw new Error("409: run was cancelled");
      if (parentId) {
        const parent = this.job(parentId);
        if (
          parent.role !== "primary" ||
          parent.runId !== run.id ||
          parent.status !== "running" ||
          this.activeReceipt()?.id !== parentId
        )
          throw new Error("403: revision requires active same-run primary");
      }
      if (!terminal(this.job(id).status) && !uploadIds.length)
        throw new Error("409: revision target is active");
      if (!assertAdmission(this.admissionJobs(), job.id, job.fingerprint))
        return;
      if (this.jobs(run.id).length >= run.maxJobs - 1)
        throw new Error("429: run job limit reached");
      this.put(`run:${run.id}`, {
        ...run,
        status: "running",
        phase: old.role === "reporter" ? "reporting" : "specialists",
      });
      if (run.phase === "completed") this.activity(writer, run.id, "run.started");
      this.enqueue(job, pushes);
    });
    await Promise.all(pushes);
    await this.publish();
    return { job: publicJob(this.job(job.id)) };
  }
  async stream(runId: string, request: Request) {
    await this.start();
    this.run(runId);
    // Legacy global activity IDs must never become native per-run sequence IDs.
    if (new URL(request.url).searchParams.get("protocol") !== "2")
      return new Response("Activity protocol changed; reload to use protocol=2", {status:410});
    await this.activityWriter(runId);
    this.run(runId);
    return sseResponse(this.streams, this.activityId(runId), { request });
  }
}
function confinedFilePath(requested:string):string {
  let path:string;
  try {path=confinedRelative(requested);}catch{throw new Error("400: invalid file path");}
  if(path==="." || /[\x00-\x1f\x7f]/.test(path) || path.split("/").includes(".git") || path.startsWith(".pentagi/native") || path.startsWith(".pentagi/jobs"))throw new Error("400: file path is not available");
  return path;
}
