import { describe, expect, it } from "vitest";
import {
  assertAdmission,
  assertCompletion,
  canonical,
  outstanding,
  publicJob,
  terminal,
} from "../src/native/domain";
import type {
  AttemptRecord,
  AttemptResult,
  RunRecord,
} from "../src/native/types";

const job = (id: string, status = "created") =>
  ({
    id,
    status,
    fingerprint: "same",
    runId: "r",
    inputCommit: "a".repeat(40),
    settingsRevision: "s",
    settings: { model: "opencode-go:deepseek-v4-pro" },
  }) as AttemptRecord;
describe("native domain invariants", () => {
  it("publishes discovery with no model/session and validates non-model completion", () => {
    const discovery={...job("discovery","running"),execution:{kind:"discovery" as const,url:"https://example.com/",profile:"whatweb-polite-v1" as const}};
    expect(publicJob(discovery)).toMatchObject({executionKind:"discovery",model:"none"});
    expect(publicJob(discovery).nativeSession).toBeUndefined();
    const result={id:"discovery",runId:"r",status:"completed",inputCommit:"a".repeat(40),outputCommit:"b".repeat(40),promptDigest:"c".repeat(64),finishedAt:1,model:null,settingsRevision:"s",executionKind:"discovery"};
    expect(()=>assertCompletion(discovery,result as AttemptResult,{id:"r",phase:"discovery",headCommit:"a".repeat(40)} as unknown as RunRecord)).not.toThrow();
  });
  it("advertises native session controls only in the live native job projection", () => {
    expect(publicJob(job("native", "completed"))).toMatchObject({nativeSession: true});
  });
  it("bounds admission globally across runs and allows identical replay at capacity", () => {
    const jobs = [
      job("a", "running"),
      { ...job("b"), runId: "other" },
      job("c"),
    ];
    expect(outstanding(jobs)).toBe(3);
    expect(() => assertAdmission(jobs, "d", "new")).toThrow("429");
    expect(assertAdmission(jobs, "a", "same")).toBe(false);
    expect(() => assertAdmission(jobs, "a", "changed")).toThrow("409");
  });
  it("treats yielded and cancelled attempts as terminal and frees their slot", () => {
    expect(terminal("waiting")).toBe(true);
    expect(terminal("interrupted")).toBe(true);
    expect(outstanding([job("a", "waiting"), job("b", "interrupted")])).toBe(0);
  });
  it("canonicalizes nested objects independently of property insertion order", () => {
    expect(canonical({ b: 1, a: { z: 2, y: 3 } })).toBe(
      canonical({ a: { y: 3, z: 2 }, b: 1 }),
    );
  });
  it("rejects late, stale-head and changed-provenance completion", () => {
    const task = job("a", "running");
    const run = {
      id: "r",
      headCommit: task.inputCommit,
      phase: "primary",
    } as RunRecord;
    const result = {
      id: "a",
      runId: "r",
      inputCommit: task.inputCommit,
      outputCommit: "b".repeat(40),
      promptDigest: "c".repeat(64),
      status: "completed",
      settingsRevision: "s",
      model: task.settings.model,
      finishedAt: 1,
    } as AttemptResult;
    expect(() => assertCompletion(task, result, run)).not.toThrow();
    expect(() =>
      assertCompletion({ ...task, status: "interrupted" }, result, run),
    ).toThrow();
    expect(() =>
      assertCompletion(task, result, { ...run, phase: "cancelled" }),
    ).toThrow();
    expect(() =>
      assertCompletion(task, result, { ...run, headCommit: "d".repeat(40) }),
    ).toThrow();
    expect(() =>
      assertCompletion(task, { ...result, settingsRevision: "wrong" }, run),
    ).toThrow();
    expect(() =>
      assertCompletion(task, { ...result, id: "other" }, run),
    ).toThrow();
  });
});
