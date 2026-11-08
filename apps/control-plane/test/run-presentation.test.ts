import { expect, it } from "vite-plus/test";
import { parseRun, runHasFinished, type UIJob } from "../src/ui/api";
import { runDate, runLabel } from "../src/ui/run-label";
import {
  acceptedOutcome,
  emptySessionProjection
} from "../src/ui/session-projection";
const run = {
  id: "run-abcdefgh-other",
  status: "completed",
  baselineRepo: "private",
  inputCommit: "a".repeat(40),
  maxDepth: 4,
  maxJobs: 32,
  target: {
    id: "target",
    name: "Owned site",
    url: "https://owned.invalid/",
    kind: "website",
    revision: 1
  }
};
it("projects creation time without requiring it on immutable older archives", () => {
  const timestamp = Date.UTC(2026, 10, 3, 12, 30);
  expect(parseRun({ ...run, createdAt: timestamp }).createdAt).toBe(timestamp);
  expect(runLabel(parseRun({ ...run, createdAt: timestamp }))).toContain(
    "Owned site"
  );
  expect(runDate(parseRun(run))).toBe("abcdefgh");
  for (const createdAt of [NaN, Infinity, -1, 8.65e15, "now"])
    expect(() => parseRun({ ...run, createdAt })).toThrow(
      "invalid run projection"
    );
});
it("shows the terminal recap only for the exact accepted attempt, status and commit", () => {
  const job: UIJob = {
    id: "job",
    runId: run.id,
    status: "completed",
    revision: 1,
    outputCommit: "a".repeat(40)
  };
  const projection = {
    ...emptySessionProjection(),
    result: {
      id: job.id,
      status: "completed" as const,
      outputCommit: job.outputCommit!,
      tool: "report_result",
      arguments: {
        message: "Actual accepted recap",
        result: "Separate reviewer notes"
      }
    }
  };
  expect(acceptedOutcome(projection, job)).toBe("Actual accepted recap");
  expect(acceptedOutcome(projection, { ...job, id: "other" })).toBeUndefined();
  expect(
    acceptedOutcome(projection, { ...job, status: "running" })
  ).toBeUndefined();
  expect(
    acceptedOutcome(projection, { ...job, outputCommit: "b".repeat(40) })
  ).toBeUndefined();
  expect(acceptedOutcome(emptySessionProjection(), job)).toBeUndefined();
});

it("keeps Stop run available for unfinished waiting runs while hiding it at a terminal phase", () => {
  expect(
    runHasFinished(parseRun({ ...run, phase: "analysis", status: "waiting" }))
  ).toBe(false);
  expect(
    runHasFinished(parseRun({ ...run, phase: "setup", status: "waiting" }))
  ).toBe(false);
  expect(
    runHasFinished(parseRun({ ...run, phase: "completed", status: "waiting" }))
  ).toBe(true);
  expect(
    runHasFinished(
      parseRun({ ...run, phase: "cancelled", status: "interrupted" })
    )
  ).toBe(true);
  expect(runHasFinished(parseRun(run))).toBe(true);
  expect(runHasFinished(parseRun({ ...run, status: "waiting" }))).toBe(false);
});
