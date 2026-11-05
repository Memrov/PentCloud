import type {EvidenceCheckpoint,EvidenceFile} from "./evidence";
import type { AgentSettings, RoleSettings } from "../settings/catalog";
import type { RuntimeProvenance, RuntimeRecovery } from "./runtime-diagnostics";
import type { ToolboxService } from "../../../../shared/toolbox-rpc";
import type { MaterialSelection } from "./materials";
import type {TargetDefinition} from "./target-definitions";
import type { SavedTarget, ModelRole } from "./onboarding";
import type { PinnedModel } from "./opencode-models";
export type NativeExecution = {kind:"discovery";url:string;profile:"whatweb-polite-v1"|"whatweb-stealthy-v2"};
export interface NewRunInput {run_id:string;task:string;launch_time?:string;upload_ids?:string[];target_id?:string;target_revision?:number;authorized?:boolean;actor?:string;}

export type Role =
  | "primary"
  | "adviser"
  | "coder"
  | "maintenance"
  | "memorist"
  | "pentester"
  | "searcher"
  | "reporter";
export type Status =
  | "created"
  | "provisioning"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "invalid_result"
  | "integration_failed"
  | "interrupted";
export interface AttemptInput {
  targetConfig?:SavedTarget;
  findingsVersion?: 1;
  execution?: NativeExecution;
  modelConfig?: PinnedModel;
  id: string;
  runId: string;
  role: Role;
  tool: string;
  args: Record<string, unknown>;
  task: string;
  inputCommit: string;
  repo: string;
  remote: string;
  settingsRevision: string;
  settings: RoleSettings;
  parentJobId?: string;
  depth: number;
  attempt: number;
  logicalThreadId: string;
  revisionOf?: string;
  context: Record<string, unknown>;
  createdAt: number;
}
export interface AttemptResult {
  evidence?:EvidenceCheckpoint;
  id: string;
  runId: string;
  status: Status;
  inputCommit: string;
  outputCommit?: string;
  promptDigest: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  error?: string;
  finishedAt: number;
  model: string | null;
  executionKind?: "discovery";
  settingsRevision: string;
  runtime?: RuntimeProvenance;
  materialsDigest?: string;
}
export interface AttemptRecord extends AttemptInput {
  conversation?:boolean;
  evidence?:EvidenceCheckpoint;
  evidenceCommits?:string[];
  evidenceFiles?:EvidenceFile[];
  evidenceUnavailable?:Array<{tool:string;receiptId:string;reason:string}>;
  inputError?: string;
  materialUploadIds?: string[];
  status: Status;
  revision: number;
  outputCommit?: string;
  promptDigest?: string;
  terminal?: AttemptResult;
  startedAt?: number;
  finishedAt?: number;
  fingerprint: string;
  recovery?: RuntimeRecovery;
}
export interface RunRecord {
  programAccess?:import('./bounty-platform').ProgramAccess;
  boundAPIAccess?:boolean;
  boundAPIFingerprint?:string;
  discoveryAcknowledged?:boolean;
  discoveryDrained?:boolean;
  definition?:TargetDefinition;
  target?: SavedTarget;
  authorization?: {actor:string;at:number;disclosureVersion:string};
  modelsByRole?: Record<ModelRole,PinnedModel>;
  apiAccess?: {id:string;version:number};
  activation?: {requestId:string;draftRevision:number};
  lifecycle?: "active" | "archived" | "trashed" | "purging";
  lifecycleRevision?: number;
  initialUploadIds?: string[];
  materials?: MaterialSelection;
  id: string;
  task: string;
  status: Status;
  repo: string;
  remote: string;
  inputCommit: string;
  headCommit: string;
  settingsRevision: string;
  settings: AgentSettings;
  createdAt: number;
  wave: number;
  phase:
    | "discovery"
    | "setup"
    | "primary"
    | "specialists"
    | "review"
    | "reporting"
    | "completed"
    | "cancelled";
  maxDepth: number;
  maxJobs: number;
  finalResponse?: string;
}
export interface CoordinatorAPI {
  beginLoginEmail(id:string,operationId:string):Promise<void>;
  loginEmail(id:string):Promise<import('./login-challenge').VerificationDelivery|undefined>;
  consumeLoginEmail(id:string,messageId:string):Promise<void>;
  browserState(id:string,state?:import("./browser-target-access").BrowserAuthState):Promise<import("./browser-target-access").BrowserAuthState|undefined>;
  readRunWork(requesterId:string,sourceId?:string,offset?:number):Promise<import("./recorded-work").RecordedWorkPage>;
  readSourceContext(id:string,sourceId:string,kind:"tree"|"file",path:string,offset:number):Promise<unknown>;
  assertConversation(id:string):Promise<void>;
  readPreparationFile(id:string,path:string):Promise<Response>;
  modelCredential(id:string):Promise<string>;
  recordEvidence(id:string,receipt:EvidenceCheckpoint):Promise<void>;
  assertEvidenceOwner(id:string):Promise<void>;
  readEvidence(requesterId:string,sourceId:string,path:string):Promise<Response>;
  apiCredential(id:string):Promise<{targetURL:string;header?:string;value?:string}>;
  delegate(
    parentId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  assertActive(id: string): Promise<void>;
  getContext(id: string): Promise<Record<string, unknown>>;
}
/** Bindings and required secret names are generated from Wrangler. */
export type NativeEnv = Omit<Cloudflare.Env, "TOOLBOX"|"OPENCODE_BYOK_PROVIDERS"> & { TOOLBOX: ToolboxService; ARTIFACTS_NAMESPACE?: string; LEGACY_STATE_COMMIT?: string; OPENCODE_BYOK_PROVIDERS?:string; PENTCLOUD_VERIFICATION_EMAIL?:string; PENTCLOUD_HACKERONE_USERNAME?:string; PENTCLOUD_HACKERONE_API_TOKEN?:string|{get():Promise<string>}; PENTCLOUD_INTIGRITI_API_TOKEN?:string|{get():Promise<string>} };
