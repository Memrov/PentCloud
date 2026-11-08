import { expect, it } from "vite-plus/test";
import { threadAttempts, threadTree } from "../src/ui/attempts";
import type { UIJob } from "../src/ui/api";
const jobs: UIJob[] = [
  {
    id: "p1",
    runId: "r",
    logicalThreadId: "p",
    attempt: 1,
    status: "completed",
    revision: 1
  },
  {
    id: "p2",
    runId: "r",
    logicalThreadId: "p",
    attempt: 2,
    revisionOf: "p1",
    status: "running",
    revision: 1
  },
  {
    id: "c1",
    runId: "r",
    logicalThreadId: "c",
    parentJobId: "p1",
    attempt: 1,
    status: "completed",
    revision: 1
  },
  {
    id: "c2",
    runId: "r",
    logicalThreadId: "c",
    parentJobId: "p2",
    attempt: 2,
    status: "created",
    revision: 1
  }
];
it("groups revisions beneath one logical specialist and keeps parent links across primary slices", () => {
  const groups = threadTree(jobs);
  expect(groups.map((j) => j.id)).toEqual(["p2", "c2"]);
  expect(groups[1]?.parentJobId).toBe("p");
  expect(threadAttempts(jobs, jobs[3]!).map((j) => j.id)).toEqual(["c1", "c2"]);
});
