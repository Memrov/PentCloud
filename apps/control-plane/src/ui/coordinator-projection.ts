import { parseJob, parseRun, type UIJob, type UIRun, type UIRunJobs, type RunLifecycleResult } from "./api";
import { mergeRunHubJobs } from "./run-hub-state";

export type CoordinatorProjection = { revision: number; runs: UIRun[]; jobs: UIJob[]; purgedRunIds?: string[] };
export type RunProjection = CoordinatorProjection & { nativeRunIds: string[]; purgedRunIds: string[] };

export function emptyRunProjection(): RunProjection {
  return { revision: -1, runs: [], jobs: [], nativeRunIds: [], purgedRunIds: [] };
}

/** State is a projection of current SQLite records; missing entries never delete history. */
export function mergeCoordinatorProjection(current: RunProjection, value: CoordinatorProjection): RunProjection {
  for (const runId of value.purgedRunIds ?? []) if (!current.purgedRunIds.includes(runId)) current = purgeRunProjection(current, runId);
  if (value.revision <= current.revision) return current;
  let jobs = current.jobs;
  const runs = new Map(current.runs.map(run => [run.id, run]));
  for (const raw of value.runs) {
    if (current.purgedRunIds.includes(raw.id)) continue;
    const run = retainNewerLifecycle(runs.get(raw.id), raw);
    const incoming = value.jobs.filter(job => job.runId === run.id);
    const newerJob = hasNewerJobs(current.jobs, incoming, run.id);
    jobs = mergeJobs(jobs, run, incoming);
    runs.set(run.id, newerJob ? { ...run, status: runs.get(run.id)?.status ?? run.status } : run);
  }
  return {
    ...current,
    revision: value.revision,
    runs: sortRuns([...runs.values()]),
    jobs,
    nativeRunIds: [...new Set([...current.nativeRunIds, ...value.runs.filter(run => !current.purgedRunIds.includes(run.id)).map(run => run.id)])],
  };
}

/** REST also supplies immutable legacy archives, which do not appear in native State. */
export function mergeRunList(current: RunProjection, incoming: UIRun[]): RunProjection {
  const runs = new Map(current.runs.map(run => [run.id, run]));
  for (const run of incoming) {
    if (current.purgedRunIds.includes(run.id)) continue;
    const existing = runs.get(run.id);
    if (!current.nativeRunIds.includes(run.id) || !existing) runs.set(run.id, retainNewerLifecycle(existing, run));
    else if ((run.lifecycleRevision ?? 0) > (existing.lifecycleRevision ?? 0)) {
      const {lifecycle: _lifecycle, lifecycleRevision: _revision, ...retained} = existing;
      runs.set(run.id, {...retained, ...(run.lifecycle ? {lifecycle: run.lifecycle} : {}), lifecycleRevision: run.lifecycleRevision!});
    }
  }
  return { ...current, runs: sortRuns([...runs.values()]) };
}

export function mergeRunSnapshot(current: RunProjection, value: UIRunJobs): RunProjection {
  if (current.purgedRunIds.includes(value.run.id)) return current;
  const projection = mergeRunList(current, [value.run]);
  const existing = new Map(current.jobs.map(job => [job.id, job]));
  // getRun() reads the run and jobs together. Only proven newer job data may
  // supersede a native run status; job completion alone is not business success.
  const fresh = value.jobs.some(job => newerJob(existing.get(job.id), job)) &&
    !hasNewerJobs(current.jobs, value.jobs, value.run.id);
  return {
    ...projection,
    runs: fresh ? projection.runs.map(run => run.id === value.run.id ? retainNewerLifecycle(run, value.run) : run) : projection.runs,
    jobs: mergeJobs(current.jobs, value.run, value.jobs),
  };
}

/** Lifecycle mutations are authoritative even when execution revisions do not change. */
export function mergeRunLifecycle(current: RunProjection, value: RunLifecycleResult): RunProjection {
  if (current.purgedRunIds.includes(value.run.id)) return current;
  const runs = new Map(current.runs.map(run => [run.id, run]));
  runs.set(value.run.id, retainNewerLifecycle(runs.get(value.run.id), value.run));
  return {...current, runs: sortRuns([...runs.values()]),
    jobs: value.jobs ? mergeJobs(current.jobs, value.run, value.jobs) : current.jobs};
}
export function purgeRunProjection(current: RunProjection, runId: string): RunProjection {
  return {...current, runs: current.runs.filter(run => run.id !== runId), jobs: current.jobs.filter(job => job.runId !== runId),
    purgedRunIds: [...new Set([...current.purgedRunIds, runId])]};
}

/** Session summaries are partial and carry no authoritative business run status. */
export function mergeJobProjection(current: RunProjection, job: UIJob): RunProjection {
  if (current.purgedRunIds.includes(job.runId)) return current;
  const run = current.runs.find(run => run.id === job.runId);
  if (!run) return current;
  const reopen = newerJob(current.jobs.find(existing => existing.id === job.id), job) &&
    ["created", "provisioning", "running"].includes(job.status);
  return {
    ...current,
    runs: reopen ? current.runs.map(run => run.id === job.runId ? { ...run, status: "running" } : run) : current.runs,
    jobs: mergeJobs(current.jobs, run, [job]),
  };
}

export function parseCoordinatorProjection(value: unknown): CoordinatorProjection {
  if (!value || typeof value !== "object" || !("revision" in value) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !("runs" in value) || !Array.isArray(value.runs) || !("jobs" in value) || !Array.isArray(value.jobs))
    throw new Error("invalid Coordinator projection");
  const runs = value.runs.map(parseRun), jobs = value.jobs.map(parseJob);
  if (jobs.some(job => !Number.isSafeInteger(job.revision) || job.revision < 0 || !runs.some(run => run.id === job.runId)))
    throw new Error("invalid Coordinator projection");
  const purgedRunIds = "purgedRunIds" in value ? value.purgedRunIds : undefined;
  if (purgedRunIds !== undefined && (!Array.isArray(purgedRunIds) || purgedRunIds.some(id => typeof id !== "string" || !id))) throw new Error("invalid Coordinator projection");
  return { revision: value.revision as number, runs, jobs, ...(purgedRunIds !== undefined ? {purgedRunIds: purgedRunIds as string[]} : {}) };
}

function retainNewerLifecycle(current: UIRun | undefined, incoming: UIRun): UIRun {
  if (!current || (incoming.lifecycleRevision ?? 0) >= (current.lifecycleRevision ?? 0)) return incoming;
  const {lifecycle: _lifecycle, lifecycleRevision: _revision, ...rest} = incoming;
  return {...rest, ...(current.lifecycle ? {lifecycle: current.lifecycle} : {}), ...(current.lifecycleRevision !== undefined ? {lifecycleRevision: current.lifecycleRevision} : {})};
}

function mergeJobs(current: UIJob[], run: UIRun, jobs: UIJob[]): UIJob[] {
  return mergeRunHubJobs(current, { runId: run.id, baselineRepo: run.baselineRepo, inputCommit: run.inputCommit, status: run.status, jobs });
}

function newerJob(current: UIJob | undefined, incoming: UIJob): boolean {
  return current ? incoming.revision > current.revision : incoming.nativeSession === true;
}

function hasNewerJobs(current: UIJob[], incoming: UIJob[], runId: string): boolean {
  const jobs = new Map(incoming.map(job => [job.id, job]));
  return current.some(job => job.runId === runId &&
    (jobs.has(job.id) ? job.revision > jobs.get(job.id)!.revision : job.nativeSession === true));
}

function sortRuns(runs: UIRun[]): UIRun[] {
  return runs.sort((left, right) => (right.createdAt??0)-(left.createdAt??0)||right.id.localeCompare(left.id));
}
