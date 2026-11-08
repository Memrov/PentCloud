import { expect, it } from "vite-plus/test";
import {
  findingTargets,
  latestReporters,
  targetKey,
  parseFindingSnapshot
} from "../src/ui/findings-model";
import type { UIJob, UIRun } from "../src/ui/api";
const run = (id: string, target?: { id: string; name: string }): UIRun => ({
  id,
  status: "completed",
  baselineRepo: "r",
  inputCommit: "a".repeat(40),
  maxDepth: 4,
  maxJobs: 32,
  ...(target
    ? {
        target: {
          ...target,
          url: "https://same.invalid",
          kind: "website",
          revision: 1
        }
      }
    : {})
});
it("separates saved target identity from names and preserves unassigned legacy runs", () => {
  const a = run("a", { id: "t1", name: "Same" }),
    b = run("b", { id: "t2", name: "Same" });
  expect(targetKey(a)).not.toBe(targetKey(b));
  expect(
    findingTargets([
      a,
      b,
      run("old"),
      { ...a, id: "trash", lifecycle: "trashed" }
    ]).map((x) => x.key)
  ).toEqual(["target:t1", "target:t2", "run:old"]);
});
it("keeps last accepted report when a retry fails and retains independent reporter threads", () => {
  const make = (
    id: string,
    attempt: number,
    status: UIJob["status"],
    logicalThreadId = "r"
  ): UIJob => ({
    id,
    runId: "a",
    role: "reporter",
    status,
    revision: 1,
    attempt,
    logicalThreadId,
    ...(status === "completed" ? { outputCommit: "b".repeat(40) } : {})
  });
  expect(
    latestReporters([
      make("old", 1, "completed"),
      make("new", 2, "failed"),
      make("second", 1, "completed", "second")
    ]).map((j) => j.id)
  ).toEqual(["old", "second"]);
});
it("rejects a response from a different assessment instead of relabeling it", () => {
  expect(() =>
    parseFindingSnapshot(
      { version: 1, runId: "other", jobId: "j", commit: "b".repeat(40) },
      "r",
      "j",
      "b".repeat(40)
    )
  ).toThrow(/provenance/);
});
