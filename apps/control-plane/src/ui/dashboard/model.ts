import type { UIActivityEvent } from "../presentation";
import type { UIJob } from "../api";

export type DashboardLocation =
  | { kind: "home" }
  | { kind: "run"; runId: string }
  | { kind: "job"; runId: string; jobId: string }
  | { kind: "not-found" };

export type WorkflowTimelineStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "terminated" | "retrying";

export interface WorkflowTimelineRow {
  id: string;
  label: string;
  depth: number;
  status: WorkflowTimelineStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  leftPercent: number;
  widthPercent: number;
  retryDelayMs?: number;
  error?: { name: string; message: string };
}

export interface WorkflowTimeline {
  events: UIActivityEvent[];
  rows: WorkflowTimelineRow[];
  startedAt?: number;
  endedAt?: number;
  durationMs: number;
  status: WorkflowTimelineStatus;
}

const identifier = "[A-Za-z0-9._-]+";

export function parseDashboardLocation(pathname: string): DashboardLocation {
  if (pathname === "/dashboard" || pathname === "/dashboard/") return { kind: "home" };
  const job = pathname.match(new RegExp(`^/dashboard/runs/(${identifier})/jobs/(${identifier})/?$`));
  if (job) return { kind: "job", runId: job[1]!, jobId: job[2]! };
  const run = pathname.match(new RegExp(`^/dashboard/runs/(${identifier})/?$`));
  if (run) return { kind: "run", runId: run[1]! };
  return { kind: "not-found" };
}

export function dashboardPath(runId?: string, jobId?: string): string {
  if (!runId) return "/dashboard";
  const run = `/dashboard/runs/${encodeURIComponent(runId)}`;
  return jobId ? `${run}/jobs/${encodeURIComponent(jobId)}` : run;
}

export function chatPath(runId?: string, jobId?: string): string {
  const params = new URLSearchParams();
  if (runId) params.set("run", runId);
  if (jobId) params.set("job", jobId);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function parseChatSelection(search: string): { runId?: string; jobId?: string } {
  const params = new URLSearchParams(search);
  const runId = params.get("run");
  const jobId = params.get("job");
  if (!runId || !new RegExp(`^${identifier}$`).test(runId)) return {};
  if (jobId && !new RegExp(`^${identifier}$`).test(jobId)) return {};
  return { runId, ...(jobId ? { jobId } : {}) };
}

export function jobActivityLabel(job: UIJob): string {
  if (job.cleanupStatus === "pending") return "Cleanup retrying";
  if (["failed", "invalid_result", "integration_failed"].includes(job.status)) return "Failed";
  if (job.status === "interrupted") return "Interrupted";
  if (job.status === "provisioning") return "Forking workspace";
  if (job.status === "created") return "Queued";
  if (job.status === "running") return "Model working";
  if (job.status === "waiting") return "Waiting";
  if (job.status === "completed") return "Complete";
  if (job.archiveStatus === "failed") return "Archive retrying";
  if ((job.archiveStatus === "complete" || job.archiveStatus === "compacted") && job.cleanupStatus === "stopped") return "Complete";
  return "Finalizing";
}

export function reduceWorkflowEvents(input: UIActivityEvent[], now: number): WorkflowTimeline {
  const byId = new Map<number, UIActivityEvent>();
  for (const event of input) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  const ordered = [...byId.values()].sort((left, right) => left.eventId - right.eventId);
  const latestStart = ordered.findLastIndex(event => event.type === "run.started");
  const events = latestStart < 0 ? ordered : ordered.slice(latestStart);
  if (events.length === 0) return { events, rows: [], durationMs: 0, status: "queued" };
  const startedAt = Math.min(...events.map((event) => event.timestamp));
  const terminal = [...events].reverse().find((event) => terminalActivityTypes.has(event.type));
  const endedAt = terminal?.timestamp;
  const timelineEnd = endedAt ?? Math.max(now, startedAt);
  const durationMs = Math.max(0, timelineEnd - startedAt);
  const status = terminal?.type === "run.completed" ? "completed" : terminal?.type === "run.failed" ? "failed" : terminal?.type === "run.interrupted" ? "terminated" : "running";
  const rows: WorkflowTimelineRow[] = [timelineRow("run", "Native run", 0, status, startedAt, timelineEnd, startedAt, durationMs, undefined, terminal?.error)];
  const phases = new Map<string, MutableTimelineRow>();
  for (const event of events) {
    if (!event.type.startsWith("phase.") || !event.stepName) continue;
    const key = `${event.jobId ?? "run"}:${event.stepName}`;
    const current = phases.get(key) ?? { id: key, label: event.stepName, depth: 1, status: "running", startedAt: event.timestamp };
    // A later start of the same phase is a distinct activity row.
    if (event.type === "phase.started" && phases.has(key) && current.endedAt !== undefined) {
      phases.set(`${key}:${current.startedAt}`, current);
      phases.set(key, { id: `${key}:${event.eventId}`, label: event.stepName, depth: 1, status: "running", startedAt: event.timestamp });
      continue;
    }
    if (event.type === "phase.completed" || event.type === "phase.failed") {
      current.status = event.type === "phase.completed" ? "completed" : "failed";
      current.endedAt = event.timestamp;
      if (event.error) current.error = event.error;
    }
    phases.set(key, current);
  }
  for (const phase of [...phases.values()].sort((a, b) => a.startedAt - b.startedAt)) {
    const phaseStatus = phase.endedAt === undefined && terminal ? status : phase.status;
    rows.push(timelineRow(phase.id, phase.label, phase.depth, phaseStatus, phase.startedAt, phase.endedAt ?? timelineEnd, startedAt, durationMs, undefined, phase.error));
  }
  return { events, rows, startedAt, ...(endedAt === undefined ? {} : { endedAt }), durationMs, status };
}

interface MutableTimelineRow {
  id: string;
  label: string;
  depth: number;
  status: WorkflowTimelineStatus;
  startedAt: number;
  endedAt?: number;
  retryDelayMs?: number;
  error?: { name: string; message: string };
}

function timelineRow(
  id: string,
  label: string,
  depth: number,
  status: WorkflowTimelineStatus,
  rowStart: number,
  rowEnd: number,
  timelineStart: number,
  timelineDuration: number,
  retryDelayMs?: number,
  error?: { name: string; message: string },
): WorkflowTimelineRow {
  const scale = Math.max(1, timelineDuration);
  return {
    id,
    label,
    depth,
    status,
    startedAt: rowStart,
    endedAt: rowEnd,
    durationMs: Math.max(0, rowEnd - rowStart),
    leftPercent: ((rowStart - timelineStart) / scale) * 100,
    widthPercent: (Math.max(0, rowEnd - rowStart) / scale) * 100,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    ...(error ? { error } : {}),
  };
}

const terminalActivityTypes = new Set<UIActivityEvent["type"]>(["run.completed", "run.failed", "run.interrupted"]);

export function dashboardHomePath(runId?:string,jobId?:string,targetId?:string):string {
  const query=new URLSearchParams(chatPath(runId,jobId).slice(2));
  if(targetId)query.set('target','target:'+targetId);
  return query.size?`/dashboard?${query}`:'/dashboard';
}
