import { describe, expect, it } from "vitest";

import {
  chatPath,
  dashboardPath,
  jobActivityLabel,
  parseChatSelection,
  parseDashboardLocation,
  reduceWorkflowEvents,
} from "../src/ui/dashboard/model";
import type { UIJob } from "../src/ui/api";
import type { UIActivityEvent } from "../src/ui/presentation";

const job = (id: string, overrides: Partial<UIJob> = {}): UIJob => ({
  id,
  runId: "run-1",
  status: "running",
  revision: 1,
  ...overrides,
});

describe("dashboard model", () => {
  it("round-trips dashboard routes and exact chat deep links", () => {
    expect(parseDashboardLocation("/dashboard")).toEqual({ kind: "home" });
    expect(parseDashboardLocation("/dashboard/runs/run-1")).toEqual({ kind: "run", runId: "run-1" });
    expect(parseDashboardLocation("/dashboard/runs/run-1/jobs/job-2")).toEqual({ kind: "job", runId: "run-1", jobId: "job-2" });
    expect(parseDashboardLocation("/dashboard/runs/%2F/jobs/job-2")).toEqual({ kind: "not-found" });
    expect(parseDashboardLocation("/other")).toEqual({ kind: "not-found" });
    expect(dashboardPath()).toBe("/dashboard");
    expect(dashboardPath("run-1")).toBe("/dashboard/runs/run-1");
    expect(dashboardPath("run-1", "job-2")).toBe("/dashboard/runs/run-1/jobs/job-2");
    expect(chatPath("run-1", "job-2")).toBe("/?run=run-1&job=job-2");
    expect(parseChatSelection("?run=run-1&job=job-2")).toEqual({ runId: "run-1", jobId: "job-2" });
    expect(parseChatSelection("?run=%2F&job=job-2")).toEqual({});
    expect(parseChatSelection("?job=job-2")).toEqual({});
  });

  it("derives concise activity labels from durable job, archive, and cleanup state", () => {
    expect(jobActivityLabel(job("a", { status: "provisioning" }))).toBe("Forking workspace");
    expect(jobActivityLabel(job("a", { status: "running" }))).toBe("Model working");
    expect(jobActivityLabel(job("a", { status: "completed", cleanupStatus: "pending" }))).toBe("Cleanup retrying");
    expect(jobActivityLabel(job("a", { status: "completed", archiveStatus: "complete", cleanupStatus: "stopped" }))).toBe("Complete");
    expect(jobActivityLabel(job("a", { status: "failed" }))).toBe("Failed");
  });

  it("deduplicates native phases and closes run timing on a terminal event", () => {
    const events: UIActivityEvent[] = [
      { instanceId: "run-1", eventId: 1, timestamp: 1_000, type: "run.started" },
      { instanceId: "run-1", eventId: 2, timestamp: 1_200, type: "phase.started", stepName: "run specialist" },
      { instanceId: "run-1", eventId: 3, timestamp: 2_700, type: "phase.completed", stepName: "run specialist" },
      { instanceId: "run-1", eventId: 3, timestamp: 99_999, type: "phase.completed", stepName: "duplicate" },
      { instanceId: "run-1", eventId: 4, timestamp: 2_800, type: "run.completed" },
    ];
    const timeline = reduceWorkflowEvents(events, 3_000);
    expect(timeline.events).toHaveLength(4);
    expect(timeline.durationMs).toBe(1_800);
    expect(timeline.status).toBe("completed");
    expect(timeline.rows.map(row => [row.label, row.status, row.durationMs])).toEqual([
      ["Native run", "completed", 1_800], ["run specialist", "completed", 1_500],
    ]);
    expect(timeline.rows[1]?.leftPercent).toBeCloseTo(11.111, 2);
    expect(timeline.rows[1]?.widthPercent).toBeCloseTo(83.333, 2);
  });

  it("reopens activity for a new revision after the previous terminal event", () => {
    const timeline = reduceWorkflowEvents([
      { instanceId: "run-1", eventId: 1, timestamp: 1_000, type: "run.started" },
      { instanceId: "run-1", eventId: 2, timestamp: 1_500, type: "run.completed" },
      { instanceId: "run-1", eventId: 3, timestamp: 2_000, type: "run.started" },
      { instanceId: "run-1", eventId: 4, timestamp: 2_100, type: "phase.started", stepName: "revision" },
    ], 3_000);
    expect(timeline.status).toBe("running");
    expect(timeline.startedAt).toBe(2_000);
    expect(timeline.endedAt).toBeUndefined();
    expect(timeline.rows.map(row => row.label)).toEqual(["Native run", "revision"]);
  });

  it("shows a run-level terminal error when no step or attempt carries it", () => {
    const timeline = reduceWorkflowEvents([
      { instanceId: "job-1", eventId: 1, timestamp: 1_000, type: "run.started" },
      { instanceId: "job-1", eventId: 2, timestamp: 1_500, type: "run.failed", error: { name: "Error", message: "attempt failed" } },
    ], 2_000);

    expect(timeline.rows[0]).toMatchObject({
      label: "Native run",
      status: "failed",
      error: { name: "Error", message: "attempt failed" },
    });
  });
});
