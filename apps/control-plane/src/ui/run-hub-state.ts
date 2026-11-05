import type { RunHubState } from "./presentation";
import type { UIJob } from "./api";

export function mergeRunHubJobs(current: UIJob[], state: RunHubState): UIJob[] {
  if (!state.runId || state.jobs.length === 0) return current;
  const live = new Map(state.jobs.map((summary) => [summary.id, summary]));
  const merged = current.map((job) => {
    const summary = live.get(job.id);
    if (!summary) return job;
    live.delete(job.id);
    return mergeSummary(job, summary);
  });
  for (const summary of live.values()) merged.push(mergeSummary(undefined, summary));
  return merged.sort((left, right) => (left.depth ?? 0) - (right.depth ?? 0) || left.id.localeCompare(right.id));
}

export function deriveMergedRunStatus(jobs: UIJob[], fallback: UIRunStatus): UIRunStatus {
  if (jobs.some((job) => ["failed", "invalid_result", "integration_failed"].includes(job.status))) return "failed";
  if (jobs.some((job) => job.status === "interrupted")) return "interrupted";
  if (jobs.some((job) => ["created", "provisioning", "running"].includes(job.status))) return "running";
  if (jobs.length > 0 && jobs.every((job) => job.status === "completed")) return "completed";
  if (jobs.some((job) => job.status === "waiting")) return "waiting";
  return fallback;
}

export function mergeSpecialistJob(current: UIJob[], summary: RunHubState["jobs"][number]): UIJob[] {
  return current.map((job) => job.id === summary.id ? mergeSummary(job, summary) : job);
}

type UIRunStatus = UIJob["status"];

function mergeSummary(current: UIJob | undefined, summary: RunHubState["jobs"][number]): UIJob {
  if (current && current.revision > summary.revision) return current;
  if (summary.nativeSession === true) {
    const { recovery: _previousRecovery, ...retained } = current ?? {};
    return { ...retained, ...summary };
  }
  return { ...current, ...summary };
}
