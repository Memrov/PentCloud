import { describe, expect, it, vi } from "vitest";
import { LegacyHistory } from "../src/native/history";

const snapshot = "a".repeat(40);
const run = {
  id: "old-run",
  baseline_repo: "legacy-source",
  input_commit: "b".repeat(40),
  status: "completed",
  max_depth: 3,
  max_jobs: 10,
  revision: 1,
};
const job = {
  id: "old-job",
  run_id: "old-run",
  status: "completed",
  revision: 2,
  role: "coder",
  input_commit: "b".repeat(40),
  output_commit: "c".repeat(40),
  arguments: { task: "historic task" },
  transcript_archive_status: "complete",
  prompt: "private prompt",
  remote: "https://secret:credential@example.com",
};
const message = {
  id: "old-message",
  role: "assistant",
  parts: [{ type: "text", text: "Archived answer", state: "done" }],
};
const archive = {
  version: 1,
  jobId: "old-job",
  archivedAt: 1,
  messages: [message],
};

function fixture(values: Record<string, unknown> = {}) {
  const records: Record<string, unknown> = {
    "runs/old-run.json": run,
    "jobs/old-job.json": job,
    "transcripts/old-job.json": archive,
    ...values,
  };
  const repository = {
    readCommit: vi.fn(async (hash: string) => ({
      hash,
      treeHash: "d".repeat(40),
      message: "",
      author: { name: "", email: "" },
      committer: { name: "", email: "" },
      parents: [],
      authoredAt: 1,
      committedAt: 1,
    })),
    readTree: vi.fn(async (hash: string) =>
      hash === "d".repeat(40)
        ? ["runs", "jobs"].map((name) => ({
            name,
            mode: "40000",
            hash: name,
            type: "tree" as const,
          }))
        : Object.keys(records)
            .filter(
              (path) => path.startsWith(hash + "/") && records[path] !== null,
            )
            .map((path) => ({
              name: path.split("/")[1]!,
              mode: "100644",
              hash: "e".repeat(40),
              type: "blob" as const,
            })),
    ),
    readFile: vi.fn(async ({ path }: { ref: string; path: string }) =>
      records[path] === null || records[path] === undefined
        ? null
        : new Blob([JSON.stringify({ revision: 0, value: records[path] })]),
    ),
    [Symbol.dispose]: vi.fn(),
  };
  const get = vi.fn(async () => repository);
  return {
    repository,
    get,
    history: new LegacyHistory({
      ARTIFACTS: { get },
      LEGACY_STATE_COMMIT: snapshot,
      CONTROL_TOKEN: "known-private-fixture",
    }),
  };
}

describe("immutable legacy history", () => {
  it("reads only the pinned commit using the native read capabilities and projects safe run/job fields", async () => {
    const { history, repository, get } = fixture();
    expect(await history.listRuns()).toEqual({
      runs: [
        {
          id: "old-run",
          status: "completed",
          baselineRepo: "legacy-source",
          inputCommit: run.input_commit,
          maxDepth: 3,
          maxJobs: 10,
        },
      ],
    });
    const result = await history.getRun("old-run");
    expect(result.jobs[0]).toMatchObject({
      id: "old-job",
      role: "coder",
      task: "historic task",
      archiveStatus: "complete",
    });
    expect(result.jobs[0]).not.toHaveProperty("prompt");
    expect(result.jobs[0]).not.toHaveProperty("remote");
    expect(result.jobs[0]).not.toHaveProperty("nativeSession");
    expect(get).toHaveBeenCalledWith("pentagi-control-state");
    expect(
      repository.readCommit.mock.calls.every(([ref]) => ref === snapshot),
    ).toBe(true);
    expect(
      repository.readFile.mock.calls.every(
        ([options]) => options.ref === snapshot,
      ),
    ).toBe(true);
    expect(repository[Symbol.dispose]).toHaveBeenCalledTimes(2);
  });

  it("returns a finite SSE snapshot consumable by the UI and redacts transcript credential payloads", async () => {
    const { history } = fixture({
      "transcripts/old-job.json": {
        ...archive,
        messages: [
          {
            ...message,
            metadata: { unsafe: "private" },
            parts: [
              {
                type: "text",
                text: 'Bearer bearer-fixture known-private-fixture api_key=another-secret {"token":"serialized-credential"}',
                state: "streaming",
              },
              {
                type: "dynamic-tool",
                toolCallId: "call",
                toolName: "terminal",
                state: "output-available",
                input: { authorization: "credential", command: "pwd" },
                output: { password: "private", result: "okay" },
              },
            ],
          },
        ],
      },
    });
    const response = await history.events("old-job");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-legacy-state-commit")).toBe(snapshot);
    const raw = await response.text();
    const projected = JSON.parse(
      raw.split("\n\n")[0]!.split("data: ")[1]!.trim(),
    );
    expect(raw).toContain("event: end\n");
    expect(projected).toMatchObject({
      busy: false,
      cursor: 0,
      pending: [],
      job: { id: "old-job" },
    });
    expect(projected.messages[0].parts[0].state).toBe("done");
    expect(raw).not.toContain("bearer-fixture");
    expect(raw).not.toContain("known-private-fixture");
    expect(raw).not.toContain("another-secret");
    expect(raw).not.toContain("serialized-credential");
    expect(projected.messages[0]).not.toHaveProperty("metadata");
    expect(projected.messages[0].parts[1].input).toEqual({
      authorization: "[REDACTED]",
      command: "pwd",
    });
    expect(projected.messages[0].parts[1].output).toEqual({
      password: "[REDACTED]",
      result: "okay",
    });
  });

  it("rejects path traversal before any repository access and fails identity/provenance mismatches", async () => {
    const { history, get } = fixture();
    await expect(history.events("../old-job")).rejects.toThrow("400");
    expect(get).not.toHaveBeenCalled();
    await expect(
      fixture({
        "jobs/old-job.json": { ...job, id: "different" },
      }).history.events("old-job"),
    ).rejects.toThrow("identity mismatch");
    await expect(
      fixture({
        "transcripts/old-job.json": { ...archive, jobId: "different" },
      }).history.events("old-job"),
    ).rejects.toThrow("identity mismatch");
    await expect(
      fixture({ "runs/old-run.json": null }).history.events("old-job"),
    ).rejects.toThrow("run provenance");
    await expect(
      fixture({
        "jobs/old-job.json": { ...job, input_commit: "main" },
      }).history.events("old-job"),
    ).rejects.toThrow("commit provenance");
    await expect(
      fixture({
        "jobs/old-job.json": { ...job, status: "running" },
      }).history.events("old-job"),
    ).rejects.toThrow("Active jobs");
  });

  it("distinguishes a missing archive from an actual empty archive", async () => {
    const missing = await (
      await fixture({ "transcripts/old-job.json": null }).history.events(
        "old-job",
      )
    ).text();
    expect(missing).toContain("archive_unavailable");
    const empty = await (
      await fixture({
        "transcripts/old-job.json": { ...archive, messages: [] },
      }).history.events("old-job")
    ).text();
    expect(empty).toContain('"messages":[]');
    expect(empty).not.toContain("archive_unavailable");
  });

  it("requires explicit immutable snapshot configuration and rejects unsafe tree entries", async () => {
    const get = vi.fn();
    expect(await new LegacyHistory({ ARTIFACTS: { get } }).listRuns()).toEqual({
      runs: [],
    });
    expect(get).not.toHaveBeenCalled();
    expect(
      () =>
        new LegacyHistory({
          ARTIFACTS: { get },
          LEGACY_STATE_COMMIT: "pentagi/state",
        }),
    ).toThrow("snapshot configuration");
    const { history, repository } = fixture();
    repository.readTree.mockImplementation(async (hash) =>
      hash === "d".repeat(40)
        ? [{ name: "runs", mode: "40000", hash: "runs", type: "tree" }]
        : [
            {
              name: "../escape.json",
              mode: "100644",
              hash: "e".repeat(40),
              type: "blob",
            },
          ],
    );
    await expect(history.listRuns()).rejects.toThrow("historical identifier");
  });

  it("preserves legacy derived terminal run status despite stale created/running ledger fields", async () => {
    const { history } = fixture({
      "runs/old-run.json": { ...run, status: "created" },
      "jobs/old-job.json": { ...job, status: "failed" },
    });
    expect((await history.listRuns()).runs[0]?.status).toBe("failed");
    expect((await history.getRun("old-run")).run.status).toBe("failed");
  });
});
