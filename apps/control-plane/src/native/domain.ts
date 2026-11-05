import type { AttemptRecord, AttemptResult, RunRecord, Status } from "./types";

export const terminal = (status: Status | string) =>
  !["created", "provisioning", "running"].includes(status);
export const outstanding = (jobs: AttemptRecord[]) =>
  jobs.filter((j) => !terminal(j.status)).length;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function digest(value: unknown): Promise<string> {
  const sum = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      typeof value === "string" ? value : canonical(value),
    ),
  );
  return [...new Uint8Array(sum)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function assertAdmission(
  jobs: AttemptRecord[],
  id: string,
  fingerprint: string,
): boolean {
  const prior = jobs.find((j) => j.id === id);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new Error("409: attempt identity reused with changed input");
    return false;
  }
  if (outstanding(jobs) >= 3)
    throw new Error("429: queue full: one active attempt and two waiting");
  return true;
}
export function assertCompletion(
  job: AttemptRecord,
  result: AttemptResult,
  run: RunRecord,
): void {
  if (job.status !== "running" || run.phase === "cancelled")
    throw new Error("409: attempt is no longer active");
  if (
    job.id !== result.id ||
    job.runId !== result.runId ||
    job.inputCommit !== result.inputCommit ||
    run.headCommit !== result.inputCommit
  )
    throw new Error("409: completion does not match the accepted input");
  if (
    job.settingsRevision !== result.settingsRevision ||
    (job.execution?.kind === "discovery" ? result.model !== null || result.executionKind !== "discovery" : job.settings.model !== result.model)
  )
    throw new Error("409: completion changed immutable configuration");
  if (
    !/^[a-f0-9]{64}$/.test(result.promptDigest) ||
    !result.outputCommit ||
    !/^[a-f0-9]{40}$/.test(result.outputCommit)
  )
    throw new Error("400: completion has no durable result provenance");
}
export function identifier(value: unknown, label = "id"): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value)
  )
    throw new Error(`400: invalid ${label}`);
  return value;
}
export function publicJob(j: AttemptRecord) {
  return {
    ...((!j.inputError || j.conversation) && !j.execution ? {nativeSession: true} : {}),
    ...(j.conversation && j.status==="created" ? {preparingConversation:true} : {}),
    ...(j.execution ? {executionKind: j.execution.kind} : {}),
    id: j.id,
    runId: j.runId,
    role: j.role,
    tool: j.tool,
    depth: j.depth,
    status: j.status,
    revision: j.revision,
    task: j.task,
    model: j.execution ? "none" : j.settings.model,
    reasoningEffort: j.settings.reasoningEffort,
    settingsRevision: j.settingsRevision,
    configurationSource: "settings",
    logicalThreadId: j.logicalThreadId,
    attempt: j.attempt,
    inputCommit: j.inputCommit,
    ...(j.parentJobId ? { parentJobId: j.parentJobId } : {}),
    ...(j.revisionOf ? { revisionOf: j.revisionOf } : {}),
    ...(j.outputCommit ? { outputCommit: j.outputCommit } : {}),
    ...(j.evidence ? {evidenceCommit:j.evidence.commit} : {}),
    ...(j.inputError ? {inputError: j.inputError, failureClass: "material_input"} : {}),
    ...(j.terminal?.error ? { failureClass: j.status } : {}),
    ...(j.terminal?.runtime ? { runtime: j.terminal.runtime } : {}),
    ...(j.recovery ? { recovery: j.recovery } : {}),
  };
}
export function publicRun(r: RunRecord) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    phase: r.phase,
    ...(r.discoveryDrained ? {discoveryDrained:true} : {}),
    ...(r.discoveryAcknowledged ? {discoveryAcknowledged:true} : {}),
    ...(r.target ? {target: {id:r.target.id,name:r.target.name,url:r.target.url,kind:r.target.kind,revision:r.target.revision,
      ...(r.target.access?{access:{managed:true,loginConfigured:!!r.target.access.login,apiConfigured:!!r.target.access.api,program:r.target.access.program?.name}}:{}),
      ...(r.target.sources?.length?{sources:r.target.sources.map(({id,repo,branch,commit,origin})=>({id,repo,branch,commit,...(origin?{origin}:{})}))}:{})}} : {}),
    status: r.status,
    baselineRepo: r.repo,
    inputCommit: r.inputCommit,
    maxDepth: r.maxDepth,
    maxJobs: r.maxJobs,
    settingsRevision: r.settingsRevision,
    lifecycle: r.lifecycle ?? "active",
    lifecycleRevision: r.lifecycleRevision ?? 0,
  };
}
