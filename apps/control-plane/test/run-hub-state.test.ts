import { describe, expect, it } from "vitest";

import type { RunHubState } from "../src/ui/presentation";
import { deriveMergedRunStatus, mergeRunHubJobs, mergeSpecialistJob } from "../src/ui/run-hub-state";

describe("run hub UI state", () => {
  it("clears a resumed native recovery notice while preserving fields omitted by partial summaries", () => {
    const job = {id: "job-1", runId: "run-1", nativeSession: true as const, status: "running" as const, revision: 1, task: "Inspect", recovery: {reason: "alarm_memory_limit" as const, sealed: true, observedAt: 100, purgedJobs: 1}};
    expect(mergeSpecialistJob([job], {id: job.id, runId: job.runId, nativeSession: true, status: "running", revision: 2})).toEqual([{id: job.id, runId: job.runId, nativeSession: true, status: "running", revision: 2, task: "Inspect"}]);
  });
  it("preserves the REST snapshot when a predeployment RunHub starts empty", () => {
    const jobs = [{ id: "job-1", runId: "run-1", status: "running" as const, revision: 3, task: "Inspect" }];
    expect(mergeRunHubJobs(jobs, {
      runId: "run-1",
      baselineRepo: "baseline",
      inputCommit: "input",
      status: "created",
      jobs: [],
    })).toEqual(jobs);
  });

  it("merges live updates without deleting jobs absent from an incremental hub snapshot", () => {
    const jobs = [
      { id: "job-1", runId: "run-1", status: "running" as const, revision: 1, task: "Inspect" },
      { id: "job-2", runId: "run-1", status: "completed" as const, revision: 4 },
    ];
    expect(mergeRunHubJobs(jobs, {
      runId: "run-1",
      baselineRepo: "baseline",
      inputCommit: "input",
      status: "failed",
      jobs: [{ id: "job-1", runId: "run-1", status: "failed", revision: 2 }],
    })).toEqual([
      { id: "job-1", runId: "run-1", status: "failed", revision: 2, task: "Inspect" },
      jobs[1],
    ]);
  });

  it("ignores a delayed hub summary older than the REST snapshot", () => {
    const jobs = [{ id: "job-1", runId: "run-1", status: "completed" as const, revision: 8 }];
    const state: RunHubState = {
      runId: "run-1",
      baselineRepo: "baseline",
      inputCommit: "input",
      status: "running",
      jobs: [{ id: "job-1", runId: "run-1", status: "running", revision: 7 }],
    };
    const merged = mergeRunHubJobs(jobs, state);
    expect(merged).toEqual(jobs);
    expect(deriveMergedRunStatus(merged, state.status)).toBe("completed");
  });

  it("keeps a synchronous specialist update when an older hub snapshot arrives next", () => {
    const jobs = [{ id: "job-1", runId: "run-1", status: "running" as const, revision: 7 }];
    const specialist = mergeSpecialistJob(jobs, {
      id: "job-1", runId: "run-1", status: "completed", revision: 9, archiveStatus: "complete",
    });
    const hub = mergeRunHubJobs(specialist, {
      runId: "run-1",
      baselineRepo: "baseline",
      inputCommit: "input",
      status: "running",
      jobs: [{ id: "job-1", runId: "run-1", status: "running", revision: 8 }],
    });
    expect(hub).toEqual([{
      id: "job-1", runId: "run-1", status: "completed", revision: 9, archiveStatus: "complete",
    }]);
  });
});
