import { describe, expect, it } from "vitest";
import {
  dynamicWorkerFailure,
  lifecycleDiagnostic,
  memoryRecovery,
  recoveryPending,
  runtimeVersion,
} from "../src/native/runtime-diagnostics";

describe("native runtime diagnostic privacy and recovery", () => {
  it("honors a native backoff wake without creating an attempt lifetime deadline", () => {
    const recovery = { reason: "alarm_memory_limit" as const, sealed: false, observedAt: 100, nextTime: 250, purgedJobs: 0 };
    expect(recoveryPending(recovery, 249)).toBe(true);
    expect(recoveryPending(recovery, 250)).toBe(false);
    expect(recoveryPending({ ...recovery, sealed: true }, 1000000)).toBe(true);
    expect(recoveryPending(undefined, 0)).toBe(false);
  });
  it("projects only native version identity and rejects payload-shaped metadata", () => {
    expect(runtimeVersion({ CF_VERSION_METADATA: {
      id: "40f0e003-8fb0-407c-a363-68153e701a01", tag: "release-1",
      timestamp: "2026-10-31T18:00:00.000Z", secret: "operator-token",
    } })).toEqual({ id: "40f0e003-8fb0-407c-a363-68153e701a01", tag: "release-1", timestamp: "2026-10-31T18:00:00.000Z" });
    expect(runtimeVersion({ CF_VERSION_METADATA: { id: "https://secret.invalid/?token=secret" } })).toBeUndefined();
    expect(runtimeVersion({})).toBeUndefined();
  });

  it("retains a sealed memory fence across later notifications and drops job payloads", () => {
    const sealed = memoryRecovery({
      sealed: true, nextTime: 123,
      executing: { payload: { token: "secret" } },
      purgedRecoveryLoopJobs: [{ payload: "secret" }, { payload: "secret" }],
    }, undefined, 100);
    expect(sealed).toEqual({ reason: "alarm_memory_limit", sealed: true, observedAt: 100, purgedJobs: 2 });
    expect(memoryRecovery({ sealed: false, nextTime: 250 }, sealed, 200)).toEqual({ reason: "alarm_memory_limit", sealed: true, observedAt: 200, purgedJobs: 2 });
    expect(memoryRecovery({ sealed: true }, sealed, 100).observedAt).toBe(101);
    expect(memoryRecovery({ sealed: false, nextTime: 250 }, undefined, 200)).toEqual({ reason: "alarm_memory_limit", sealed: false, observedAt: 200, purgedJobs: 0, nextTime: 250 });
  });

  it("exports only allowlisted native operational events and numeric metadata", () => {
    expect(lifecycleDiagnostic({ type: "job:backlog_warning", name: "private task", payload: { capability: "private", count: 120, source: "secret" } })).toEqual({ type: "job:backlog_warning", count: 120 });
    expect(lifecycleDiagnostic({ type: "job:slow_dispatch", payload: { id: "secret", thresholdMs: 30000, fn: "secret" } })).toEqual({ type: "job:slow_dispatch", thresholdMs: 30000 });
    expect(lifecycleDiagnostic({ type: "alarm:memory_limit_reset", payload: { strikes: 3, limit: 3, sealed: true, error: "Bearer secret" } })).toEqual({ type: "alarm:memory_limit_reset", strikes: 3, limit: 3, sealed: true });
    expect(lifecycleDiagnostic({ type: "tool:execute", payload: { secret: "secret" } })).toBeUndefined();
    expect(lifecycleDiagnostic({ type: "job:backlog_warning", payload: { count: "Bearer secret" } })).toBeUndefined();
  });

  it("summarizes failed Dynamic Workers without exporting console, URL or exception text", () => {
    expect(dynamicWorkerFailure({ outcome: "exceededCpu", cpuTime: 30001, wallTime: 60000, logs: [{ message: "secret" }], exceptions: [{ message: "secret" }], event: { request: { url: "https://private/?token=secret" } } })).toEqual({ outcome: "exceededCpu", cpuMs: 30001, wallMs: 60000, exceptions: 1 });
    expect(dynamicWorkerFailure({ outcome: "secret", exceptions: [{ message: "secret" }] })).toEqual({ outcome: "other", exceptions: 1 });
    expect(dynamicWorkerFailure({ outcome: "ok", logs: [{ message: "secret" }], exceptions: [] })).toBeUndefined();
  });
});
