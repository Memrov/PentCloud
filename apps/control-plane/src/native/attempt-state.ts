import type { EvidenceCheckpoint } from "./evidence";
import type { MetasploitOwnership } from "./remote-control";

import type { PinnedToolSkill } from "./skills";
import type { RuntimeRecovery, RuntimeVersion } from "./runtime-diagnostics";
import type { AttemptInput, AttemptResult, Status } from "./types";
export interface Proposal {
  tool: string;
  arguments: Record<string, unknown>;
  status: Status;
  finishedAt: number;
  runtimeVersion?: RuntimeVersion | undefined;
}
export interface AttemptState {
  toolPacks?: boolean;
  preparation?: true;
  promotionPending?: true;
  evidence?: EvidenceCheckpoint;
  evidenceRegistered?: string;
  evidenceFilesDigest?: string;
  evidencePending?:
    | { text: string; parentCommit: string; fileDigest: string }
    | undefined;
  finalizing?: boolean;
  input: AttemptInput;
  fingerprint: string;
  prompt: string;
  promptDigest: string;
  toolSkill?: PinnedToolSkill;
  status: "running" | "publishing" | "settled";
  prepared?: boolean;
  startedAt: number;
  proposal?: Proposal;
  outputCommit?: string;
  result?: AttemptResult;
  runtimeVersion?: RuntimeVersion | undefined;
}
export interface RemoteIdentityEvidence {
  source: "captured-response" | "host-observation";
  reference: string;
  confirmedExactOperation: true;
}
export interface RemoteCall {
  state: "started" | "running" | "completed" | "unknown" | "reconciled";
  name: string;
  fingerprint: string;
  arguments?: Record<string, unknown>;
  startedAt?: number;
  result?: unknown;
  remoteId?: string;
  owned?: MetasploitOwnership;
  resolution?: {
    inspectionTool: string;
    scanId: string;
    evidenceDigest: string;
    observedAt: number;
    outcome: string;
    source?: "operator-inspection" | "known-operation-inspection";
    identityEvidence?: RemoteIdentityEvidence;
  };
}
export function profileName(input: AttemptInput): string {
  return input.settings.promptFormat === "markdown"
    ? `pentcloud-${input.role}`
    : "build";
}
export function enabledTools(input: AttemptInput): string[] {
  if (input.context.enabledTools === undefined) return [];
  if (
    !Array.isArray(input.context.enabledTools) ||
    input.context.enabledTools.some((v) => typeof v !== "string")
  )
    throw new Error("Pinned enabledTools must be strings");
  return input.context.enabledTools as string[];
}
export function publicJob(state: AttemptState) {
  return {
    nativeSession: true,
    id: state.input.id,
    run_id: state.input.runId,
    role: state.input.role,
    status:
      state.result?.status ??
      (state.preparation
        ? "created"
        : state.prepared
          ? "running"
          : "provisioning"),
    ...(state.preparation ? { preparingConversation: true } : {}),
    input_commit: state.input.inputCommit,
    output_commit: state.result?.outputCommit,
    prompt_digest: state.promptDigest,
    settings_revision: state.input.settingsRevision,
    model: state.input.settings.model,
    created_at: new Date(state.input.createdAt).toISOString(),
    started_at: new Date(state.startedAt).toISOString(),
    ...(state.result
      ? {
          finished_at: new Date(state.result.finishedAt).toISOString(),
          error: state.result.error
        }
      : {})
  };
}
export function immutableInput(input: AttemptInput): AttemptInput {
  return {
    ...(input.targetConfig ? { targetConfig: input.targetConfig } : {}),
    ...(input.findingsVersion
      ? { findingsVersion: input.findingsVersion }
      : {}),
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}),
    id: input.id,
    runId: input.runId,
    role: input.role,
    tool: input.tool,
    args: input.args,
    task: input.task,
    inputCommit: input.inputCommit,
    repo: input.repo,
    remote: input.remote,
    settingsRevision: input.settingsRevision,
    settings: input.settings,
    ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
    depth: input.depth,
    attempt: input.attempt,
    logicalThreadId: input.logicalThreadId,
    ...(input.revisionOf ? { revisionOf: input.revisionOf } : {}),
    context: input.context,
    createdAt: input.createdAt
  };
}
export interface ExecutionSnapshot {
  state: "absent" | "running" | "settled" | "cancelled";
  evidence?: EvidenceCheckpoint;
  result?: AttemptResult;
  drained: boolean;
  unresolvedRemote: number;
  sessionCleanupPending: boolean;
  startup?: { stage: string; at: number };
  recovery?: RuntimeRecovery;
  runtimeVersion?: RuntimeVersion;
}
export function executionSnapshot(
  state: AttemptState | undefined,
  status: {
    cancelled: boolean;
    unresolvedRemote: number;
    sessionCleanupPending: boolean;
    startup: ExecutionSnapshot["startup"];
    recovery: ExecutionSnapshot["recovery"];
    preparingConversation: boolean;
    admittingConversation: boolean;
    running: boolean;
    publishing: boolean;
    checkpointing: boolean;
    evidencePending: boolean;
    inFlightTools: number;
    retiringToolbox: boolean;
  }
): ExecutionSnapshot {
  return {
    state: status.cancelled
      ? "cancelled"
      : !state
        ? "absent"
        : state.result
          ? "settled"
          : "running",
    ...(state?.result ? { result: state.result } : {}),
    ...(state?.evidence ? { evidence: state.evidence } : {}),
    drained:
      !status.preparingConversation &&
      !status.admittingConversation &&
      !status.running &&
      !status.publishing &&
      !status.checkpointing &&
      !status.evidencePending &&
      status.inFlightTools === 0 &&
      status.unresolvedRemote === 0 &&
      !status.sessionCleanupPending &&
      !status.retiringToolbox,
    unresolvedRemote: status.unresolvedRemote,
    sessionCleanupPending: status.sessionCleanupPending,
    ...(status.startup ? { startup: status.startup } : {}),
    ...(status.recovery ? { recovery: status.recovery } : {}),
    ...(state?.runtimeVersion ? { runtimeVersion: state.runtimeVersion } : {})
  };
}
