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
  for (const summary of live.values())
    merged.push(mergeSummary(undefined, summary));
  return merged.sort(
    (left, right) =>
      (left.depth ?? 0) - (right.depth ?? 0) || left.id.localeCompare(right.id)
  );
}

function mergeSummary(
  current: UIJob | undefined,
  summary: RunHubState["jobs"][number]
): UIJob {
  if (current && current.revision > summary.revision) return current;
  if (summary.nativeSession === true) {
    const { recovery: _previousRecovery, ...retained } = current ?? {};
    return { ...retained, ...summary };
  }
  return { ...current, ...summary };
}
