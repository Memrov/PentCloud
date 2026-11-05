/** Only platform identity and numeric/enum metadata may cross diagnostic boundaries. */
export interface RuntimeVersion {
  id: string;
  tag?: string;
  timestamp?: string;
}
export interface RuntimeProvenance {
  initialized?: RuntimeVersion;
  terminal?: RuntimeVersion;
}
export interface RuntimeRecovery {
  reason: "alarm_memory_limit";
  sealed: boolean;
  observedAt: number;
  purgedJobs: number;
  nextTime?: number;
  version?: RuntimeVersion;
}
export function recoveryPending(recovery: RuntimeRecovery | undefined, now = Date.now()): boolean {
  return !!recovery && (recovery.sealed || (recovery.nextTime ?? 0) > now);
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const identity = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value) ? value : undefined;

export function runtimeVersion(env: unknown): RuntimeVersion | undefined {
  const metadata = record(record(env).CF_VERSION_METADATA), id = identity(metadata.id);
  if (!id) return;
  const tag = identity(metadata.tag);
  const timestamp = typeof metadata.timestamp === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(metadata.timestamp)
    ? metadata.timestamp : undefined;
  return { id, ...(tag ? { tag } : {}), ...(timestamp ? { timestamp } : {}) };
}

/** A later notification cannot silently clear a sealed operator recovery fence. */
export function memoryRecovery(
  context: { sealed: boolean; nextTime?: number; purgedRecoveryLoopJobs?: readonly unknown[]; executing?: unknown },
  previous?: RuntimeRecovery,
  now = Date.now(),
  version?: RuntimeVersion,
): RuntimeRecovery {
  const sealed = !!context.sealed || !!previous?.sealed;
  const nextTime = numeric(context.nextTime);
  return {
    reason: "alarm_memory_limit", sealed, observedAt: Math.max(now, (previous?.observedAt ?? -1) + 1),
    purgedJobs: Math.max(previous?.purgedJobs ?? 0, context.purgedRecoveryLoopJobs?.length ?? 0),
    ...(!sealed && nextTime !== undefined ? { nextTime } : {}),
    ...(version ? { version } : {}),
  };
}

export function lifecycleDiagnostic(value: unknown): Record<string, string | number | boolean> | undefined {
  const event = record(value), payload = record(event.payload);
  if (event.type === "job:backlog_warning") {
    const count = numeric(payload.count);
    return count === undefined ? undefined : { type: event.type, count };
  }
  if (event.type === "job:slow_dispatch") {
    const thresholdMs = numeric(payload.thresholdMs);
    return thresholdMs === undefined ? undefined : { type: event.type, thresholdMs };
  }
  if (event.type === "alarm:memory_limit_reset") {
    const strikes = numeric(payload.strikes), limit = numeric(payload.limit);
    if (strikes === undefined || limit === undefined || typeof payload.sealed !== "boolean") return;
    return { type: event.type, strikes, limit, sealed: payload.sealed };
  }
}

/** Tail events contain prompts, console output, headers and URLs. Never forward them. */
export function dynamicWorkerFailure(value: unknown): Record<string, string | number> | undefined {
  const event = record(value);
  if (event.outcome === "ok") return;
  const outcome = typeof event.outcome === "string" && [
    "exception", "exceededCpu", "exceededMemory", "canceled", "unknown", "exceededSubrequests",
  ].includes(event.outcome) ? event.outcome : "other";
  const cpuMs = numeric(event.cpuTime), wallMs = numeric(event.wallTime);
  return {
    outcome, ...(cpuMs === undefined ? {} : { cpuMs }), ...(wallMs === undefined ? {} : { wallMs }),
    exceptions: Array.isArray(event.exceptions) ? event.exceptions.length : 0,
  };
}
