/** Stock Metasploit results describe resource creation separately from RPC success. */
export interface MetasploitOwnership {
  jobIds: string[];
  sessionIds: string[];
  executionUuid?: string;
  uncertain: boolean;
  /** A stopped job can have created a session since the previous session inventory. */
  needsSessionInspection: boolean;
}
export interface MetasploitOutcome {
  state: "running" | "unknown" | "completed";
  owned: MetasploitOwnership;
}
export interface MetasploitOwnedReceipt {
  id: string;
  owned: MetasploitOwnership;
}
export interface MetasploitControl {
  receiptIds: string[];
  kind: "job" | "session";
  resourceId: string;
}
const launchers = new Set([
  "metasploit_start_listener",
  "metasploit_run_exploit",
  "metasploit_run_post_module",
  "metasploit_run_auxiliary_module",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function id(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*)$/.test(value) &&
    Number.isSafeInteger(Number(value))
  )
    return value;
  return undefined;
}
const unique = (values: Array<string | undefined>) => [
  ...new Set(values.filter((value): value is string => value !== undefined)),
];
function copy(owned: MetasploitOwnership): MetasploitOwnership {
  return {
    ...owned,
    jobIds: [...owned.jobIds],
    sessionIds: [...owned.sessionIds],
  };
}
export function metasploitOwnershipState(
  owned: MetasploitOwnership,
): MetasploitOutcome["state"] {
  if (owned.uncertain) return "unknown";
  return owned.jobIds.length ||
    owned.sessionIds.length ||
    owned.needsSessionInspection
    ? "running"
    : "completed";
}
export function isMetasploitInspection(tool: string): boolean {
  return (
    tool === "metasploit_list_listeners" ||
    tool === "metasploit_list_active_sessions"
  );
}
export function isMetasploitControl(tool: string): boolean {
  return (
    tool === "metasploit_stop_job" || tool === "metasploit_terminate_session"
  );
}

/** Pass the parsed stock tool result, not the MCP framing envelope. */
export function metasploitOutcome(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): MetasploitOutcome | undefined {
  if (!launchers.has(tool)) return undefined;
  const data = record(result) ? result : {};
  const jobIds = unique([id(data.job_id)]);
  const sessionIds = unique([
    id(data.session_id),
    id(data.session_id_detected),
  ]);
  const rawUuid =
    data.uuid ?? (record(data.result) ? data.result.uuid : undefined);
  const executionUuid =
    typeof rawUuid === "string" && rawUuid.trim() && rawUuid.length <= 256
      ? rawUuid
      : undefined;
  const asynchronous =
    tool === "metasploit_start_listener" ||
    args.run_as_job === true ||
    jobIds.length > 0;
  const successful = data.status === "success" || data.status === "warning";
  const invalidIdentity = ["job_id", "session_id", "session_id_detected"].some(
    (key) =>
      data[key] !== undefined &&
      data[key] !== null &&
      id(data[key]) === undefined,
  );
  const abortedBeforeExecution =
    data.status === "aborted" && !jobIds.length && !sessionIds.length;
  // Missing IDs after an asynchronous launch cannot establish that nothing started.
  // Missing UUID prevents attributing future sessions to a known background job.
  const uncertain =
    !abortedBeforeExecution &&
    (invalidIdentity ||
      !successful ||
      (asynchronous && !jobIds.length) ||
      (jobIds.length > 0 && !executionUuid) ||
      (data.status === "warning" && !jobIds.length && !sessionIds.length));
  const owned: MetasploitOwnership = {
    jobIds,
    sessionIds,
    ...(executionUuid ? { executionUuid } : {}),
    uncertain,
    needsSessionInspection: jobIds.length > 0,
  };
  return { state: metasploitOwnershipState(owned), owned };
}

/** A hold permits stopping an already owned resource, never launching another mutation. */
export function authorizeMetasploitControl(
  tool: string,
  args: Record<string, unknown>,
  receipts: readonly MetasploitOwnedReceipt[],
): MetasploitControl {
  if (!isMetasploitControl(tool))
    throw new Error(
      "Only owned Metasploit stop/terminate controls are permitted during a remote hold",
    );
  const kind = tool === "metasploit_stop_job" ? "job" : "session";
  const field = kind === "job" ? "job_id" : "session_id";
  const supplied = args[field];
  if (
    Object.keys(args).length !== 1 ||
    typeof supplied !== "number" ||
    !Number.isSafeInteger(supplied) ||
    supplied < 0
  )
    throw new Error(
      `Metasploit control requires only the original integer ${field}`,
    );
  const resourceId = String(supplied);
  const receiptIds = [
    ...new Set(
      receipts
        .filter((receipt) =>
          (kind === "job"
            ? receipt.owned.jobIds
            : receipt.owned.sessionIds
          ).includes(resourceId),
        )
        .map((receipt) => receipt.id),
    ),
  ];
  if (!receiptIds.length)
    throw new Error(
      `Metasploit ${kind} ${resourceId} is not owned by this attempt`,
    );
  return { receiptIds, kind, resourceId };
}

function inventory(
  value: unknown,
  label: string,
): Record<string, Record<string, unknown>> {
  if (
    !record(value) ||
    Object.entries(value).some(
      ([key, entry]) => id(key) !== key || !record(entry),
    )
  )
    throw new Error(`Malformed successful Metasploit ${label} inventory`);
  return value as Record<string, Record<string, unknown>>;
}
function count(value: unknown, expected: number, label: string): void {
  if (!Number.isSafeInteger(value) || value !== expected)
    throw new Error(`Incomplete successful Metasploit ${label} inventory`);
}
/** Errors and incomplete inventories never establish absence or clear uncertainty.
 * Poll listeners first, then sessions: the latter can discover a newly opened
 * session after the job has stopped. Neither successful inventory clears an
 * uncertain result whose operation identity was never established.
 */
export function applyMetasploitInspection(
  owned: MetasploitOwnership,
  tool: string,
  result: unknown,
): MetasploitOwnership {
  if (!isMetasploitInspection(tool))
    throw new Error("Not a Metasploit resource inspection");
  const next = copy(owned);
  if (!record(result) || result.status !== "success") return next;
  if (tool === "metasploit_list_listeners") {
    const handlers = inventory(result.handlers, "handler");
    const jobs = inventory(result.other_jobs, "job");
    const names = [...Object.keys(handlers), ...Object.keys(jobs)];
    if (new Set(names).size !== names.length)
      throw new Error("Duplicate Metasploit job identity across inventories");
    count(result.handler_count, Object.keys(handlers).length, "handler");
    count(result.other_job_count, Object.keys(jobs).length, "job");
    count(result.total_job_count, names.length, "total job");
    next.jobIds = next.jobIds.filter(
      (job) => Object.hasOwn(handlers, job) || Object.hasOwn(jobs, job),
    );
    if (owned.jobIds.length > 0) next.needsSessionInspection = true;
    return next;
  }
  const sessions = inventory(result.sessions, "session");
  count(result.count, Object.keys(sessions).length, "session");
  next.sessionIds = next.sessionIds.filter((session) =>
    Object.hasOwn(sessions, session),
  );
  if (next.executionUuid)
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (
        typeof session.exploit_uuid === "string" &&
        session.exploit_uuid === next.executionUuid
      )
        next.sessionIds.push(sessionId);
    }
  next.sessionIds = unique(next.sessionIds);
  // A still-live job may create another session after this inventory.
  next.needsSessionInspection = next.jobIds.length > 0;
  return next;
}
