import type { UIActivityEvent } from "./presentation";
import type { FormAnswer, PendingForm, PendingPermission, SessionControls } from "../native/managed-session";
import type { BrowserLiveViewResult } from "../native/browser-live-view";
import {
  SETTINGS_ROLES,
  UI_REASONING_EFFORTS,
  type SettingsRoleId,
  type SettingsRoles,
  type UIAgentSettings,
  type UIReasoningEffort,
  type UISettingsModel,
  type UISettingsModelCatalog,
  type UISettingsResponse,
  type UpstreamRoles,
} from "./settings/model";

export type JobStatus =
  | "created"
  | "provisioning"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "invalid_result"
  | "integration_failed"
  | "interrupted";

export type RunLifecycle = "active" | "archived" | "trashed" | "purging";
export type RunView = "active" | "archived" | "trash" | "all";

export interface UIRun {
  createdAt?: number;
  phase?:string;
  discoveryDrained?:boolean;
  discoveryAcknowledged?:boolean;
  target?:{id:string;name:string;url:string;kind:"website"|"api";revision:number;sources?:{id:string;repo:string;branch:string;commit:string;origin?:string}[]};
  lifecycle?: RunLifecycle;
  lifecycleRevision?: number;
  id: string;
  status: JobStatus;
  baselineRepo: string;
  inputCommit: string;
  maxDepth: number;
  maxJobs: number;
  settingsRevision?: string;
}

export interface UIJob {
  id: string;
  runId: string;
  /** Present only on live native job projections, never inferred for archives. */
  nativeSession?: true;
  preparingConversation?:true;
  /** Material admission failed before an OpenCode session was started. */
  inputError?: string;
  parentJobId?: string;
  role?: string;
  tool?: string;
  depth?: number;
  status: JobStatus;
  revision: number;
  /** Existing Coordinator admission order of the first attempt in this conversation. */
  conversationOrder?: number;
  task?: string;
  model?: string;
  cost?: number;
  archiveStatus?: "complete" | "compacted" | "failed";
  cleanupStatus?: "pending" | "stopped";
  settingsRevision?: string;
  configurationSource?: "settings" | "operator";
  reasoningEffort?: string;
  logicalThreadId?: string;
  attempt?: number;
  revisionOf?: string;
  inputCommit?: string;
  outputCommit?: string;
  failureClass?: string;
  recovery?: { reason: "alarm_memory_limit"; sealed: boolean; observedAt: number; purgedJobs: number; nextTime?: number };
}

export interface UIRunJobs {
  run: UIRun;
  jobs: UIJob[];
}
export type UIPlatformRecovery = NonNullable<UIJob["recovery"]>;
export interface UIRuntimeDiagnostics {
  coordinator: { recovery?: UIPlatformRecovery; version?: { id: string } };
  backlog: { waiting: number; oldestWaitingMs: number };
  active?: { id: string; state: string; drained: boolean; unresolvedRemote: number; sessionCleanupPending: boolean; recovery?: UIPlatformRecovery };
}

function parseRecovery(value: unknown): UIPlatformRecovery | undefined {
  if (!isRecord(value) || value.reason !== "alarm_memory_limit" || typeof value.sealed !== "boolean" ||
    typeof value.observedAt !== "number" || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 ||
    typeof value.purgedJobs !== "number" || !Number.isSafeInteger(value.purgedJobs) || value.purgedJobs < 0) return;
  return { reason: "alarm_memory_limit", sealed: value.sealed, observedAt: value.observedAt, purgedJobs: value.purgedJobs,
    ...(typeof value.nextTime === "number" && Number.isSafeInteger(value.nextTime) && value.nextTime >= 0 ? { nextTime: value.nextTime } : {}),
  };
}

export async function getRuntimeDiagnostics(fetcher: typeof fetch = globalThis.fetch): Promise<UIRuntimeDiagnostics> {
  const value = await request("/v1/ui/runtime-diagnostics", {}, fetcher);
  if (!isRecord(value) || !isRecord(value.coordinator) || !isRecord(value.backlog) ||
    typeof value.backlog.waiting !== "number" || !countValue(value.backlog.waiting) ||
    typeof value.backlog.oldestWaitingMs !== "number" || !nonnegative(value.backlog.oldestWaitingMs))
    throw new Error("invalid runtime diagnostics");
  const recovery = parseRecovery(value.coordinator.recovery), active = value.active;
  const activeRecovery = isRecord(active) ? parseRecovery(active.recovery) : undefined;
  if (active !== undefined && (!isRecord(active) || typeof active.id !== "string" || typeof active.state !== "string" ||
    !["absent", "running", "settled", "cancelled"].includes(active.state) || typeof active.drained !== "boolean" ||
    typeof active.unresolvedRemote !== "number" || !countValue(active.unresolvedRemote) || typeof active.sessionCleanupPending !== "boolean"))
    throw new Error("invalid runtime diagnostics");
  const version = value.coordinator.version;
  return {
    coordinator: { ...(recovery ? { recovery } : {}), ...(isRecord(version) && typeof version.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(version.id) ? { version: { id: version.id } } : {}) },
    backlog: { waiting: value.backlog.waiting, oldestWaitingMs: value.backlog.oldestWaitingMs },
    ...(isRecord(active) ? { active: {
      id: active.id as string, state: active.state as string, drained: active.drained as boolean,
      unresolvedRemote: active.unresolvedRemote as number, sessionCleanupPending: active.sessionCleanupPending as boolean,
      ...(activeRecovery ? { recovery: activeRecovery } : {}),
    } } : {}),
  };
}

export async function rearmRuntimeRecovery(expected: { scope: "coordinator" | "attempt"; observedAt: number; attemptId?: string }, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await request("/v1/ui/runtime-recovery", { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(expected) }, fetcher);
}

export class APIError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "APIError";
  }
}

export async function listRuns(fetcher: typeof fetch = globalThis.fetch, view: RunView = "active"): Promise<UIRun[]> {
  const value = await request(`/v1/ui/runs${view === "active" ? "" : `?view=${view}`}`, {}, fetcher);
  if (!isRecord(value) || !Array.isArray(value.runs)) throw new Error("invalid runs response");
  return value.runs.map(parseRun);
}

export type RunLifecycleResult = {run: UIRun; jobs?: UIJob[]};
async function changeRunLifecycle(runId: string, action: "archive" | "trash" | "restore", fetcher: typeof fetch): Promise<RunLifecycleResult> {
  const value = await request(`/v1/ui/runs/${encodeURIComponent(runId)}/${action}`, {method: "POST"}, fetcher);
  if (!isRecord(value) || (value.jobs !== undefined && !Array.isArray(value.jobs))) throw new Error("invalid run lifecycle response");
  return {run: parseRun(value.run), ...(Array.isArray(value.jobs) ? {jobs: value.jobs.map(parseJob)} : {})};
}
export const archiveRun = (runId: string, fetcher: typeof fetch = globalThis.fetch) => changeRunLifecycle(runId, "archive", fetcher);
export const trashRun = (runId: string, fetcher: typeof fetch = globalThis.fetch) => changeRunLifecycle(runId, "trash", fetcher);
export const restoreRun = (runId: string, fetcher: typeof fetch = globalThis.fetch) => changeRunLifecycle(runId, "restore", fetcher);
export async function permanentlyDeleteRun(runId: string, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  const value = await request(`/v1/ui/runs/${encodeURIComponent(runId)}`, {method: "DELETE", headers: {"content-type": "application/json"}, body: JSON.stringify({confirm: runId})}, fetcher);
  if (!isRecord(value) || value.runId !== runId || value.deleted !== true) throw new Error("invalid run deletion response");
}
export function reportDownloadUrl(runId: string, jobId: string): string {
  return `/v1/ui/runs/${encodeURIComponent(runId)}/report?job=${encodeURIComponent(jobId)}`;
}
/** Native phase distinguishes a paused unfinished run from an accepted terminal run. */
export function runHasFinished(run:UIRun):boolean {
  return run.phase ? ["completed","cancelled"].includes(run.phase)
    : ["completed","failed","invalid_result","integration_failed","interrupted"].includes(run.status);
}

export function runMatchesView(run: UIRun, view: RunView): boolean {
  const lifecycle = run.lifecycle ?? "active";
  return view === "all" || (view === "trash" ? lifecycle === "trashed" || lifecycle === "purging" : lifecycle === view);
}

export async function getRunJobs(runId: string, fetcher: typeof fetch = globalThis.fetch): Promise<UIRunJobs> {
  const value = await request(`/v1/ui/runs/${encodeURIComponent(runId)}/jobs`, {}, fetcher);
  if (!isRecord(value) || !Array.isArray(value.jobs)) throw new Error("invalid run jobs response");
  return { run: parseRun(value.run), jobs: value.jobs.map(parseJob) };
}

export async function createRun(
  input: { runId: string; task: string; launchTime: string; uploadIds?: readonly string[];targetId?:string;targetRevision?:number;authorized?:boolean },
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ run: UIRun; rootJob: UIJob }> {
  const value = await request("/v1/ui/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: input.runId, task: input.task, launch_time: input.launchTime, ...(input.targetId?{target_id:input.targetId,target_revision:input.targetRevision,authorized:input.authorized}:{}), ...(input.uploadIds?.length ? {upload_ids: input.uploadIds} : {}) }),
  }, fetcher);
  if (!isRecord(value)) throw new Error("invalid create run response");
  return { run: parseRun(value.run), rootJob: parseJob(value.rootJob) };
}

export async function steerJob(jobId: string, message: string, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  }, fetcher);
}

export async function reviseJob(jobId: string, message: string, fetcher: typeof fetch = globalThis.fetch, options?: {requestId: string; uploadIds?: readonly string[]}): Promise<UIJob | undefined> {
  const value = await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/revisions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions: message, request_id: options?.requestId ?? crypto.randomUUID(), ...(options?.uploadIds?.length ? {upload_ids: options.uploadIds} : {}) }),
  }, fetcher);
  return isRecord(value) && value.job ? parseJob(value.job) : undefined;
}
export async function cancelRun(runId: string, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await request(`/v1/ui/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }, fetcher);
}

export async function interruptJob(jobId: string, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/interrupt`, { method: "POST" }, fetcher);
}

/** Ephemeral operator credential; never merge this result into run/session State. */
export async function createBrowserLiveView(jobId: string, fetcher: typeof fetch = globalThis.fetch): Promise<BrowserLiveViewResult> {
  const value = await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/browser-live-view`, {
    method: "POST", cache: "no-store", referrerPolicy: "no-referrer",
  }, fetcher);
  if (isRecord(value) && value.available === false) return {available: false};
  if (!isRecord(value) || value.available !== true || value.readOnly !== true || typeof value.url !== "string" ||
      typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 65_000)
    throw new Error("Invalid browser view");
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error("Invalid browser view"); }
  if (url.origin !== "https://live.browser.run" || !url.pathname.startsWith("/ui/") || url.username || url.password)
    throw new Error("Invalid browser view");
  return {available: true, readOnly: true, url: url.href, expiresAt: value.expiresAt};
}

/** Keep only the native statistics and allowance fields actually displayed. */
export interface UISessionControls {
  session: string;
  canReply: boolean;
  forms: PendingForm[];
  permissions: PendingPermission[];
  usage: {
    stats: {steps: number; tokens: {input: number; output: number}; cost: number; tools: {mode: "summary"; totals: {calls: number; failed: number}}};
    limits: {go?: {rolling: {percent: number}; weekly: {percent: number}; monthly: {percent: number}}; budgets: Array<{id: string; spent: number; limit: number}>} | null;
    limitsStatus: SessionControls["usage"]["limitsStatus"];
  };
}
export async function getSessionControls(jobId: string, fetcher: typeof fetch = globalThis.fetch): Promise<UISessionControls> {
  const value = await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/session-controls`, {}, fetcher);
  return parseSessionControls(value);
}

export function parseSessionControls(value: unknown): UISessionControls {
  const invalid = () => new Error("invalid native session controls");
  if (!isRecord(value) || typeof value.session !== "string" || typeof value.canReply !== "boolean" || !Array.isArray(value.forms) || !Array.isArray(value.permissions) || !isRecord(value.usage)) throw invalid();
  const session = value.session;
  const forms: PendingForm[] = value.forms.map(raw => {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.sessionID !== session || typeof raw.title !== "string" || !Array.isArray(raw.fields)) throw invalid();
    const fields = raw.fields.map((field: unknown) => { if (!isNativeField(field)) throw invalid(); return field; });
    const [first, ...rest] = fields;
    if (!first) throw invalid();
    return {id: raw.id, sessionID: session, title: raw.title, fields: [first, ...rest]};
  });
  const permissions: PendingPermission[] = value.permissions.map(raw => {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.sessionID !== session || typeof raw.action !== "string" || !stringArray(raw.resources) || !optional(raw.message, textValue)) throw invalid();
    return {id: raw.id, sessionID: session, action: raw.action, resources: raw.resources, ...(typeof raw.message === "string" ? {message: raw.message} : {})};
  });
  const rawStats = value.usage.stats;
  if (!isRecord(rawStats) || !nonnegative(rawStats.steps) || !isRecord(rawStats.tokens) || !nonnegative(rawStats.tokens.input) || !nonnegative(rawStats.tokens.output) || !nonnegative(rawStats.cost) || !isRecord(rawStats.tools) || rawStats.tools.mode !== "summary" || !isRecord(rawStats.tools.totals) || !nonnegative(rawStats.tools.totals.calls) || !nonnegative(rawStats.tools.totals.failed)) throw invalid();
  const stats = {steps: rawStats.steps, tokens: {input: rawStats.tokens.input, output: rawStats.tokens.output}, cost: rawStats.cost, tools: {mode: "summary" as const, totals: {calls: rawStats.tools.totals.calls, failed: rawStats.tools.totals.failed}}};
  const status = value.usage.limitsStatus;
  if (status !== "available" && status !== "not-connected" && status !== "unavailable") throw invalid();
  let limits: UISessionControls["usage"]["limits"] = null;
  const rawLimits = value.usage.limits;
  if (rawLimits !== null) {
    if (!isRecord(rawLimits) || !Array.isArray(rawLimits.budgets)) throw invalid();
    const budgets = rawLimits.budgets.map(raw => {
      if (!isRecord(raw) || typeof raw.id !== "string" || !nonnegative(raw.spent) || !nonnegative(raw.limit)) throw invalid();
      return {id: raw.id, spent: raw.spent, limit: raw.limit};
    });
    if (rawLimits.go === undefined) limits = {budgets};
    else {
      const go = rawLimits.go;
      const meter = (raw: unknown) => { if (!isRecord(raw) || !nonnegative(raw.percent)) throw invalid(); return {percent: raw.percent}; };
      if (!isRecord(go)) throw invalid();
      limits = {budgets, go: {rolling: meter(go.rolling), weekly: meter(go.weekly), monthly: meter(go.monthly)}};
    }
  }
  return {session, canReply: value.canReply, forms, permissions, usage: {stats, limits, limitsStatus: status}};
}

const textValue = (value: unknown): value is string => typeof value === "string";
const boolValue = (value: unknown): value is boolean => typeof value === "boolean";
const numberValue = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => numberValue(value) && value >= 0;
const countValue = (value: unknown) => nonnegative(value) && Number.isSafeInteger(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
function isNativeField(raw: unknown): raw is PendingForm["fields"][number] {
  if (!isRecord(raw) || !textValue(raw.key) || !optional(raw.title, textValue) || !optional(raw.description, textValue)) return false;
  if (raw.type === "external") return textValue(raw.url);
  const scalar = (value: unknown) => textValue(value) || numberValue(value) || boolValue(value);
  const conditions = (value: unknown) => Array.isArray(value) && value.every(condition => isRecord(condition) && textValue(condition.key) && (condition.op === "eq" || condition.op === "neq") && scalar(condition.value));
  if (!optional(raw.required, boolValue) || !optional(raw.hidden, boolValue) || !optional(raw.when, conditions)) return false;
  const options = (value: unknown) => Array.isArray(value) && value.every(option => isRecord(option) && textValue(option.value) && textValue(option.label) && optional(option.description, textValue));
  const numeric = (value: unknown) => numberValue(value) || value === "Infinity" || value === "-Infinity" || value === "NaN";
  if (raw.type === "string") return optional(raw.default, textValue) && optional(raw.format, value => ["email", "uri", "date", "date-time"].includes(String(value))) && optional(raw.minLength, countValue) && optional(raw.maxLength, countValue) && optional(raw.pattern, textValue) && optional(raw.placeholder, textValue) && optional(raw.options, options) && optional(raw.custom, boolValue);
  if (raw.type === "number" || raw.type === "integer") return optional(raw.minimum, numeric) && optional(raw.maximum, numeric) && optional(raw.default, numeric);
  if (raw.type === "boolean") return optional(raw.default, boolValue);
  if (raw.type === "multiselect") return options(raw.options) && optional(raw.minItems, countValue) && optional(raw.maxItems, countValue) && optional(raw.default, stringArray) && optional(raw.custom, boolValue);
  return false;
}

export async function answerNativeForm(jobId: string, session: string, formId: string, answer: FormAnswer, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/forms/${encodeURIComponent(formId)}/reply`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({session, answer}),
  }, fetcher);
}
export async function cancelNativeForm(jobId: string, session: string, formId: string, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/forms/${encodeURIComponent(formId)}/cancel`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({session}),
  }, fetcher);
}
export async function replyNativePermission(jobId: string, session: string, permissionId: string, decision: "once" | "reject", fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await request(`/v1/ui/jobs/${encodeURIComponent(jobId)}/permissions/${encodeURIComponent(permissionId)}/reply`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({session, decision}),
  }, fetcher);
}

export async function getSettings(fetcher: typeof fetch = globalThis.fetch): Promise<UISettingsResponse> {
  return parseSettingsResponse(await request("/v1/ui/settings", {}, fetcher));
}

export async function listSettingsModels(refresh = false, fetcher: typeof fetch = globalThis.fetch): Promise<UISettingsModelCatalog> {
  const suffix = refresh ? "?refresh=1" : "";
  return parseModelCatalog(await request(`/v1/ui/settings/models${suffix}`, {}, fetcher));
}

export async function saveSettings(
  roles: SettingsRoles,
  casRevision: number,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<UISettingsResponse> {
  return parseSettingsResponse(await request("/v1/ui/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", "if-match": String(casRevision) },
    body: JSON.stringify({ roles }),
  }, fetcher));
}

export function parseActivityEvent(value: unknown): UIActivityEvent {
  if (!isRecord(value)
    || typeof value.instanceId !== "string"
    || !Number.isSafeInteger(value.eventId)
    || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)
    || !["run.started", "run.completed", "run.failed", "run.interrupted", "phase.started", "phase.completed", "phase.failed", "platform.memory_recovery_sealed", "platform.memory_recovery_backoff"].includes(String(value.type))
    || (value.stepName !== undefined && typeof value.stepName !== "string")
    || (value.jobId !== undefined && typeof value.jobId !== "string")
    || (value.error !== undefined && (!isRecord(value.error) || typeof value.error.name !== "string" || typeof value.error.message !== "string"))) throw new Error("invalid activity event");
  return {
    instanceId: value.instanceId, eventId: value.eventId as number, timestamp: value.timestamp, type: value.type as UIActivityEvent["type"],
    ...(typeof value.stepName === "string" ? { stepName: value.stepName } : {}),
    ...(typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
    ...(isRecord(value.error) ? { error: { name: value.error.name as string, message: value.error.message as string } } : {}),
  };
}

async function request(path: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(path, init);
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = isRecord(value) && typeof value.error === "string" ? value.error : `Request failed with HTTP ${response.status}`;
    throw new APIError(response.status, message);
  }
  return value;
}

export function parseRun(value: unknown): UIRun {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !isStatus(value.status)
    || typeof value.baselineRepo !== "string"
    || typeof value.inputCommit !== "string"
    || typeof value.maxDepth !== "number"
    || typeof value.maxJobs !== "number"
    || (value.createdAt !== undefined && (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.createdAt > 8.64e15))
    || (value.lifecycleRevision !== undefined && (!Number.isSafeInteger(value.lifecycleRevision) || (value.lifecycleRevision as number) < 0))
    || (value.lifecycle !== undefined && !["active", "archived", "trashed", "purging"].includes(String(value.lifecycle)))) {
    throw new Error("invalid run projection");
  }
  return {
    id: value.id,
    ...(typeof value.createdAt === "number" ? {createdAt:value.createdAt} : {}),
    ...(typeof value.phase==="string"?{phase:value.phase}:{}),
    ...(value.discoveryDrained===true?{discoveryDrained:true}:{}),
    ...(value.discoveryAcknowledged===true?{discoveryAcknowledged:true}:{}),
    ...(isRecord(value.target)&&typeof value.target.id==="string"&&typeof value.target.name==="string"&&typeof value.target.url==="string"&&["website","api"].includes(String(value.target.kind))&&typeof value.target.revision==="number"?{target:value.target as unknown as NonNullable<UIRun["target"]>}:{}),
    ...(value.lifecycle !== undefined ? {lifecycle: value.lifecycle as RunLifecycle} : {}),
    ...(typeof value.lifecycleRevision === "number" ? {lifecycleRevision: value.lifecycleRevision} : {}),
    status: value.status,
    baselineRepo: value.baselineRepo,
    inputCommit: value.inputCommit,
    maxDepth: value.maxDepth,
    maxJobs: value.maxJobs,
    ...(typeof value.settingsRevision === "string" ? { settingsRevision: value.settingsRevision } : {}),
  };
}

export function parseJob(value: unknown): UIJob {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.runId !== "string"
    || !isStatus(value.status)
    || typeof value.revision !== "number") {
    throw new Error("invalid job projection");
  }
  const recovery = parseRecovery(value.recovery);
  return {
    id: value.id,
    runId: value.runId,
    ...(value.nativeSession === true ? { nativeSession: true as const } : {}),
    ...(value.preparingConversation===true?{preparingConversation:true as const}:{}),
    ...(typeof value.inputError === "string" ? { inputError: value.inputError } : {}),
    status: value.status,
    revision: value.revision,
    ...(typeof value.conversationOrder === "number" && Number.isSafeInteger(value.conversationOrder) && value.conversationOrder >= 0 ? {conversationOrder: value.conversationOrder} : {}),
    ...(typeof value.parentJobId === "string" ? { parentJobId: value.parentJobId } : {}),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof value.tool === "string" ? { tool: value.tool } : {}),
    ...(typeof value.depth === "number" ? { depth: value.depth } : {}),
    ...(typeof value.task === "string" ? { task: value.task } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.cost === "number" ? { cost: value.cost } : {}),
    ...(value.archiveStatus === "complete" || value.archiveStatus === "compacted" || value.archiveStatus === "failed"
      ? { archiveStatus: value.archiveStatus } : {}),
    ...(value.cleanupStatus === "pending" || value.cleanupStatus === "stopped" ? { cleanupStatus: value.cleanupStatus } : {}),
    ...(typeof value.settingsRevision === "string" ? { settingsRevision: value.settingsRevision } : {}),
    ...(value.configurationSource === "settings" || value.configurationSource === "operator"
      ? { configurationSource: value.configurationSource } : {}),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(typeof value.logicalThreadId === "string" ? { logicalThreadId: value.logicalThreadId } : {}),
    ...(typeof value.attempt === "number" ? { attempt: value.attempt } : {}),
    ...(typeof value.revisionOf === "string" ? { revisionOf: value.revisionOf } : {}),
    ...(typeof value.inputCommit === "string" ? { inputCommit: value.inputCommit } : {}),
    ...(typeof value.outputCommit === "string" ? { outputCommit: value.outputCommit } : {}),
    ...(typeof value.failureClass === "string" ? { failureClass: value.failureClass } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function parseSettingsResponse(value: unknown): UISettingsResponse {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.casRevision)
    || typeof value.locked !== "boolean"
    || !Array.isArray(value.blockingRunIds)
    || value.blockingRunIds.some((id) => typeof id !== "string")) {
    throw new Error("invalid settings response");
  }
  return {
    settings: parseAgentSettings(value.settings),
    casRevision: value.casRevision as number,
    locked: value.locked,
    blockingRunIds: value.blockingRunIds as string[],
    upstreamRoles: parseUpstreamRoles(value.upstreamRoles),
  };
}

function parseAgentSettings(value: unknown): UIAgentSettings {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !digest(value.revision)
    || !digest(value.upstreamManifestDigest)
    || typeof value.savedAt !== "string"
    || Number.isNaN(Date.parse(value.savedAt))
    || typeof value.savedBy !== "string") {
    throw new Error("invalid settings response");
  }
  return {
    schemaVersion: 1,
    revision: value.revision,
    upstreamManifestDigest: value.upstreamManifestDigest,
    savedAt: value.savedAt,
    savedBy: value.savedBy,
    roles: parseRoles(value.roles),
  };
}

function parseRoles(value: unknown): SettingsRoles {
  if (!isRecord(value) || !exactRoleKeys(value)) throw new Error("invalid settings roles");
  return Object.fromEntries(SETTINGS_ROLES.map(({ id }) => {
    const role = value[id];
    if (!isRecord(role)
      || typeof role.promptTemplate !== "string"
      || (role.promptFormat !== undefined && role.promptFormat !== "markdown" && role.promptFormat !== "pentagi-template")
      || !digest(role.upstreamPromptDigest)
      || typeof role.model !== "string"
      || !UI_REASONING_EFFORTS.includes(role.reasoningEffort as UIReasoningEffort)) {
      throw new Error(`invalid ${id} settings`);
    }
    return [id, {
      promptTemplate: role.promptTemplate,
      ...(role.promptFormat === undefined ? {} : { promptFormat: role.promptFormat }),
      upstreamPromptDigest: role.upstreamPromptDigest,
      model: role.model,
      reasoningEffort: role.reasoningEffort,
    }];
  })) as SettingsRoles;
}

function parseUpstreamRoles(value: unknown): UpstreamRoles {
  if (!isRecord(value) || !exactRoleKeys(value)) throw new Error("invalid upstream roles");
  return Object.fromEntries(SETTINGS_ROLES.map(({ id }) => {
    const role = value[id];
    if (!isRecord(role) || typeof role.promptTemplate !== "string" || !digest(role.upstreamPromptDigest)
      || (role.promptFormat !== undefined && role.promptFormat !== "markdown" && role.promptFormat !== "pentagi-template")) {
      throw new Error(`invalid ${id} upstream settings`);
    }
    return [id, { promptTemplate: role.promptTemplate, upstreamPromptDigest: role.upstreamPromptDigest,
      ...(role.promptFormat === undefined ? {} : { promptFormat: role.promptFormat }) }];
  })) as UpstreamRoles;
}

function parseModelCatalog(value: unknown): UISettingsModelCatalog {
  if (!isRecord(value) || !Array.isArray(value.models) || typeof value.fetchedAt !== "string" || typeof value.stale !== "boolean") {
    throw new Error("invalid model catalog");
  }
  return { models: value.models.map(parseSettingsModel), fetchedAt: value.fetchedAt, stale: value.stale };
}

function parseSettingsModel(value: unknown): UISettingsModel {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.provider !== "string"
    || !stringArray(value.inputModalities)
    || !stringArray(value.outputModalities)
    || !stringArray(value.supportedParameters)
    || !Array.isArray(value.reasoningEfforts)
    || value.reasoningEfforts.some((effort) => !UI_REASONING_EFFORTS.includes(effort as UIReasoningEffort))) {
    throw new Error("invalid model catalog");
  }
  return {
    id: value.id,
    name: value.name,
    provider: value.provider,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.contextLength === "number" ? { contextLength: value.contextLength } : {}),
    inputModalities: value.inputModalities,
    outputModalities: value.outputModalities,
    supportedParameters: value.supportedParameters,
    reasoningEfforts: value.reasoningEfforts as UIReasoningEffort[],
  };
}

function exactRoleKeys(value: Record<string, unknown>): boolean {
  const expected = SETTINGS_ROLES.map(({ id }) => id).sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const statuses = new Set<JobStatus>([
  "created", "provisioning", "running", "waiting", "completed", "failed", "invalid_result", "integration_failed", "interrupted",
]);

function isStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && statuses.has(value as JobStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
