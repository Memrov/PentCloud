import { describe, expect, it } from "vitest";
import type { UIJob, UIRun } from "../src/ui/api";
import {
  emptyRunProjection,
  purgeRunProjection,
  mergeRunLifecycle,
  mergeCoordinatorProjection,
  mergeJobProjection,
  mergeRunList,
  mergeRunSnapshot,
  parseCoordinatorProjection,
} from "../src/ui/coordinator-projection";

const run: UIRun = { id: "run-current", baselineRepo: "main", inputCommit: "abc", maxDepth: 4, maxJobs: 32, status: "running" };
const job: UIJob = { id: "job-current", runId: run.id, nativeSession: true, revision: 3, status: "running", task: "Inspect" };
const archive: UIRun = { ...run, id: "run-archive", status: "completed" };

describe("Coordinator run projection", () => {
  it("keeps a purged run and all its jobs absent across late REST, State and session projections", () => {
    const initial = mergeCoordinatorProjection(emptyRunProjection(), {revision: 4, runs: [run], jobs: [job]});
    const deleted = purgeRunProjection(initial, run.id);
    expect(deleted.runs).toEqual([]);
    expect(deleted.jobs).toEqual([]);
    let late = mergeRunList(deleted, [run]);
    late = mergeRunSnapshot(late, {run, jobs: [job]});
    late = mergeCoordinatorProjection(late, {revision: 5, runs: [run], jobs: [job]});
    late = mergeJobProjection(late, {...job, revision: 9});
    expect(late.runs).toEqual([]);
    expect(late.jobs).toEqual([]);
  });
  it("applies lifecycle action responses even without changed execution revisions", () => {
    const initial = mergeCoordinatorProjection(emptyRunProjection(), {revision: 4, runs: [run], jobs: [job]});
    const archived = mergeRunLifecycle(initial, {run: {...run, lifecycle: "archived", lifecycleRevision: 1}});
    expect(archived.runs[0]?.lifecycle).toBe("archived");
    expect(archived.jobs).toEqual([job]);
    expect(mergeRunSnapshot(archived, {run, jobs: [job]}).runs[0]?.lifecycle).toBe("archived");
  });
  it("keeps newer lifecycle revisions when delayed State and REST carry an older lifecycle", () => {
    const initial = mergeCoordinatorProjection(emptyRunProjection(), {revision: 4, runs: [run], jobs: [job]});
    const archived = mergeRunLifecycle(initial, {run: {...run, lifecycle: "archived", lifecycleRevision: 3}});
    const staleState = mergeCoordinatorProjection(archived, {revision: 5, runs: [{...run, lifecycle: "active", lifecycleRevision: 2}], jobs: [job]});
    expect(staleState.runs[0]).toMatchObject({lifecycle: "archived", lifecycleRevision: 3});
    const staleRest = mergeRunSnapshot(staleState, {run: {...run, lifecycle: "active", lifecycleRevision: 2}, jobs: [{...job, revision: 8}]});
    expect(staleRest.runs[0]).toMatchObject({lifecycle: "archived", lifecycleRevision: 3});
    const restored = mergeCoordinatorProjection(staleRest, {revision: 6, runs: [{...run, lifecycle: "active", lifecycleRevision: 4}], jobs: [{...job, revision: 8}]});
    expect(restored.runs[0]).toMatchObject({lifecycle: "active", lifecycleRevision: 4});
  });
  it("updates lifecycle from REST independently of unchanged execution revisions", () => {
    const initial = mergeCoordinatorProjection(emptyRunProjection(), {revision: 4, runs: [run], jobs: [job]});
    const response = {...run, status: "completed" as const, lifecycle: "archived" as const, lifecycleRevision: 2};
    for (const next of [mergeRunList(initial, [response]), mergeRunSnapshot(initial, {run: response, jobs: [job]})]) {
      expect(next.runs[0]).toMatchObject({status: "running", lifecycle: "archived", lifecycleRevision: 2});
    }
  });
  it("applies remote purge tombstones monotonically and rejects malformed IDs", () => {
    const initial = mergeCoordinatorProjection(emptyRunProjection(), {revision: 8, runs: [run], jobs: [job]});
    const parsed = parseCoordinatorProjection({revision: 9, runs: [], jobs: [], purgedRunIds: [run.id]});
    const purged = mergeCoordinatorProjection(initial, parsed);
    expect(purged.runs).toEqual([]);
    expect(purged.jobs).toEqual([]);
    expect(purged.purgedRunIds).toContain(run.id);
    expect(mergeCoordinatorProjection(purged, {revision: 10, runs: [run], jobs: [job], purgedRunIds: []}).runs).toEqual([]);
    expect(() => parseCoordinatorProjection({revision: 9, runs: [], jobs: [], purgedRunIds: [4]})).toThrow("invalid Coordinator projection");
  });
  it("adds current runs without deleting REST history or jobs absent from State", () => {
    const { nativeSession: _nativeSession, ...historical } = job;
    const legacy = { ...historical, id: "job-archive", runId: archive.id, archiveStatus: "complete" as const };
    const initial = mergeRunSnapshot(emptyRunProjection(), { run: archive, jobs: [legacy] });
    const state = mergeCoordinatorProjection(initial, { revision: 8, runs: [run], jobs: [job] });
    expect(state.runs.map(value => value.id).sort()).toEqual(["run-archive", "run-current"]);
    expect(state.jobs).toEqual(expect.arrayContaining([legacy, job]));
    const empty = mergeCoordinatorProjection(state, { revision: 9, runs: [], jobs: [] });
    expect(empty.runs).toEqual(state.runs);
    expect(empty.jobs).toEqual(state.jobs);
  });

  it("ignores stale and duplicate global revisions after reconnect", () => {
    const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 12, runs: [{ ...run, status: "completed" }], jobs: [{ ...job, revision: 5, status: "completed" }] });
    for (const revision of [0, 11, 12]) {
      expect(mergeCoordinatorProjection(state, { revision, runs: [run], jobs: [job] })).toBe(state);
    }
  });

  it("keeps newer specialist revisions when a later State contains an older job", () => {
    const initial = mergeRunSnapshot(emptyRunProjection(), { run: { ...run, status: "completed" }, jobs: [{ ...job, revision: 7, status: "completed", outputCommit: "accepted", archiveStatus: "complete" }] });
    const state = mergeCoordinatorProjection(initial, { revision: 20, runs: [run], jobs: [{ ...job, revision: 6 }] });
    expect(state.jobs).toEqual(initial.jobs);
    expect(state.runs[0]?.status).toBe("completed");
  });

  it("does not let a late REST response roll back current native state or newly observed runs", () => {
    const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 20, runs: [{ ...run, status: "completed" }], jobs: [{ ...job, status: "completed", revision: 5, outputCommit: "accepted" }] });
    const listed = mergeRunList(state, [archive, run]);
    const snapshot = mergeRunSnapshot(listed, { run, jobs: [job] });
    expect(snapshot.runs.find(value => value.id === run.id)?.status).toBe("completed");
    expect(snapshot.runs).toContainEqual(archive);
    expect(snapshot.jobs[0]).toMatchObject({ status: "completed", revision: 5, outputCommit: "accepted" });
    expect(mergeRunList(snapshot, [archive]).runs).toEqual(snapshot.runs);
  });

  it("applies SQLite run settlement when REST carries strictly newer job revisions", () => {
    const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 8, runs: [run], jobs: [job] });
    const snapshot = mergeRunSnapshot(state, { run: { ...run, status: "completed" }, jobs: [{ ...job, revision: 4, status: "completed" }] });
    expect(snapshot.runs[0]?.status).toBe("completed");
    expect(snapshot.jobs[0]).toMatchObject({ revision: 4, status: "completed" });
    expect(snapshot.revision).toBe(8);
  });

  it("preserves a review gap and a reporter's business failure when newer REST jobs are completed", () => {
    const reporter = { ...job, role: "reporter" };
    const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 8, runs: [run], jobs: [reporter] });
    for (const status of ["running", "failed"] as const) {
      const snapshot = mergeRunSnapshot(state, { run: { ...run, status }, jobs: [{ ...reporter, revision: 4, status: "completed" }] });
      expect(snapshot.runs[0]?.status).toBe(status);
    }
  });

  it("preserves business run status when partial session summaries settle jobs", () => {
    for (const status of ["running", "failed"] as const) {
      const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 8, runs: [{ ...run, status }], jobs: [job] });
      const snapshot = mergeJobProjection(state, { ...job, revision: 4, status: "completed" });
      expect(snapshot.runs[0]?.status).toBe(status);
      expect(snapshot.jobs[0]?.status).toBe("completed");
    }
  });

  it("reopens a fresh active revision while retaining failed attempt history and rejecting stale State", () => {
    const prior = { ...job, status: "failed" as const, logicalThreadId: job.id, attempt: 1 };
    const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 8, runs: [{ ...run, status: "failed" }], jobs: [prior] });
    const next = { ...job, id: "job-revision", revision: 0, status: "created" as const, revisionOf: job.id, logicalThreadId: job.id, attempt: 2 };
    const snapshot = mergeJobProjection(state, next);
    expect(snapshot.runs[0]?.status).toBe("running");
    expect(snapshot.jobs).toContainEqual(prior);
    const stale = mergeCoordinatorProjection(snapshot, { revision: 9, runs: [{ ...run, status: "failed" }], jobs: [prior] });
    expect(stale.runs[0]?.status).toBe("running");
    expect(mergeJobProjection(stale, { ...prior, status: "running", revision: 2 }).runs[0]?.status).toBe("running");
  });

  it("keeps native run authority when REST job revisions are unchanged or older", () => {
    const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 8, runs: [run], jobs: [job] });
    for (const revision of [2, 3]) {
      const snapshot = mergeRunSnapshot(state, { run: { ...run, status: "completed" }, jobs: [{ ...job, revision, status: "completed" }] });
      expect(snapshot.runs[0]?.status).toBe("running");
    }
    expect(mergeRunSnapshot(state, { run: { ...run, status: "completed" }, jobs: [] }).runs[0]?.status).toBe("running");
  });

  it("does not reopen a settled run from an older partial session summary", () => {
    const state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 8, runs: [{ ...run, status: "completed" }], jobs: [{ ...job, revision: 4, status: "completed" }] });
    const snapshot = mergeJobProjection(state, job);
    expect(snapshot.runs[0]?.status).toBe("completed");
    expect(snapshot.jobs[0]).toMatchObject({ revision: 4, status: "completed" });
  });

  it("fences an older full snapshot when another job is newer or a fresh revision is absent", () => {
    const prior = { ...job, id: "job-prior", revision: 3 };
    const fresh = { ...job, id: "job-revision", revision: 0, status: "created" as const, revisionOf: job.id };
    let state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 8, runs: [run], jobs: [job, prior] });
    state = mergeJobProjection(state, fresh);
    const snapshot = mergeRunSnapshot(state, { run: { ...run, status: "completed" }, jobs: [{ ...job, revision: 4, status: "completed" }, prior] });
    expect(snapshot.runs[0]?.status).toBe("running");
    expect(snapshot.jobs).toContainEqual(fresh);
    const newerPrior = mergeJobProjection(state, { ...prior, revision: 5 });
    const mixed = mergeRunSnapshot(newerPrior, { run: { ...run, status: "completed" }, jobs: [{ ...job, revision: 4, status: "completed" }, { ...prior, revision: 4 }, fresh] });
    expect(mixed.runs[0]?.status).toBe("running");
  });

  it("retains a newly created revision absent from a delayed State publication", () => {
    const settled = { ...job, status: "completed" as const, revision: 5 };
    let state = mergeCoordinatorProjection(emptyRunProjection(), { revision: 20, runs: [{ ...run, status: "completed" }], jobs: [settled] });
    const fresh = { ...job, id: "job-revision", status: "created" as const, revision: 0, revisionOf: job.id };
    state = mergeRunSnapshot(state, { run: { ...run, status: "running" }, jobs: [settled, fresh] });
    expect(state.runs[0]?.status).toBe("running");
    state = mergeCoordinatorProjection(state, { revision: 21, runs: [{ ...run, status: "completed" }], jobs: [settled] });
    expect(state.jobs).toContainEqual(fresh);
    expect(state.runs[0]?.status).toBe("running");
  });

  it("merges newer State and clears recovered native notices while retaining archive metadata", () => {
    const initial = mergeRunSnapshot(emptyRunProjection(), { run, jobs: [{ ...job, archiveStatus: "complete", recovery: { reason: "alarm_memory_limit", sealed: true, observedAt: 100, purgedJobs: 1 } }] });
    const state = mergeCoordinatorProjection(initial, { revision: 4, runs: [run], jobs: [{ ...job, revision: 4, status: "completed" }] });
    expect(state.jobs[0]).toEqual({ ...job, revision: 4, status: "completed", archiveStatus: "complete" });
    expect(state.revision).toBe(4);
  });

  it("validates State through public DTOs and rejects malformed revisions and orphan jobs", () => {
    const parsed = parseCoordinatorProjection({ revision: 1, runs: [{ ...run, secret: "ignored" }], jobs: [{ ...job, secret: "ignored" }] });
    expect(parsed).toEqual({ revision: 1, runs: [run], jobs: [job] });
    for (const revision of [-1, 1.5, NaN, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseCoordinatorProjection({ revision, runs: [run], jobs: [job] })).toThrow("invalid Coordinator projection");
    }
    expect(() => parseCoordinatorProjection({ revision: 2, runs: [run], jobs: [{ ...job, runId: "unrelated" }] })).toThrow("invalid Coordinator projection");
  });
});
