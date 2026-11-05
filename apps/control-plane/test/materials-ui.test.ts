import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { APIError, createRun, parseJob, reviseJob } from "../src/ui/api";
import { MaterialPreview } from "../src/ui/components/materials";

const SHA = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"; // SHA-256 of hello\n
const COMMIT = "a".repeat(40);
const receipt = (id: string, name = "notes.txt") => ({ id, runId: "run-files", name, sha256: SHA, size: 6, mediaType: "text/plain", kind: "text", status: "ready", sourcePath: `.pentagi/materials/${SHA}/source`, textPath: `.pentagi/materials/${SHA}/source` });
async function client() {
  const module = await import("../src/ui/materials-api").catch(() => null);
  expect(module, "The real file client must exist").not.toBeNull();
  return module!;
}


describe("chat materials client", () => {
  it("retries the same upload identity/hash and exact raw bytes after a lost reply", async () => {
    const { AttachmentDraft } = await client();
    const sent: Array<{ url: string; body: number[]; hash: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), body: [...new Uint8Array(await new Response(init?.body).arrayBuffer())], hash: new Headers(init?.headers).get("X-Content-SHA256") });
      if (sent.length === 1) throw new Error("Network reply lost");
      const id = new URL(String(input), "https://app.test").pathname.split("/").at(-1)!;
      return Response.json(receipt(id));
    };
    const draft = new AttachmentDraft("run-files", fetcher);
    await draft.add([new File(["hello\n"], "notes.txt", { type: "text/plain" })]);
    const failed = draft.snapshot().files[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.id).toBeTruthy();
    await draft.retry(failed.id);
    expect(draft.snapshot().files[0]?.status).toBe("ready");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]?.body).toEqual([104, 101, 108, 108, 111, 10]);
    expect(sent[0]?.hash).toBe(SHA);
    expect(sent[0]?.url).toContain(`/runs/run-files/uploads/${failed.id}?name=notes.txt`);
  });

  it("rejects over-count/size selections before uploading and retains accepted selections", async () => {
    const { AttachmentDraft } = await client();
    let uploads = 0;
    const draft = new AttachmentDraft("run-files", async (input) => {
      uploads++;
      return Response.json(receipt(new URL(String(input), "https://app.test").pathname.split("/").at(-1)!));
    });
    await draft.add([new File(["hello\n"], "notes.txt")]);
    const selectedId = draft.snapshot().files[0]!.id;
    await draft.add(Array.from({length: 8}, (_, i) => new File(["hello\n"], `${i}.txt`)));
    expect(draft.snapshot().error).toMatch(/8 files/i);
    expect(draft.snapshot().files.map(file => file.id)).toEqual([selectedId]);
    await draft.add([new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.txt")]);
    expect(draft.snapshot().error).toMatch(/2 MiB/);
    expect(uploads).toBe(1);
  });

  it("rejects duplicate filenames in the same batch and against staged files before upload", async () => {
    const { AttachmentDraft } = await client();
    let uploads = 0;
    const draft = new AttachmentDraft("run-files", async input => {
      uploads++;
      return Response.json(receipt(new URL(String(input), "https://app.test").pathname.split("/").at(-1)!));
    });
    await draft.add([new File(["hello\n"], "notes.txt"), new File(["different"], "notes.txt")]);
    expect(draft.snapshot().error).toMatch(/duplicate.*filename/i);
    expect(draft.snapshot().files).toHaveLength(0);
    expect(uploads).toBe(0);
    await draft.add([new File(["hello\n"], "notes.txt")]);
    const selectedId = draft.snapshot().files[0]!.id;
    await draft.add([new File(["changed"], "notes.txt")]);
    expect(draft.snapshot().error).toMatch(/duplicate.*filename/i);
    expect(draft.snapshot().files.map(file => file.id)).toEqual([selectedId]);
    expect(uploads).toBe(1);
  });

  it("distinguishes definitive validation rejections from ambiguous admissions", async () => {
    const { canCorrectMaterialSubmission } = await client();
    expect(canCorrectMaterialSubmission).toBeTypeOf("function");
    for (const status of [400, 409, 413, 415, 422]) expect(canCorrectMaterialSubmission(new APIError(status, "rejected"))).toBe(true);
    for (const status of [401, 403, 429, 500, 503]) expect(canCorrectMaterialSubmission(new APIError(status, "retry"))).toBe(false);
    expect(canCorrectMaterialSubmission(new Error("Network reply lost"))).toBe(false);
  });

  it("preserves pre-session material input rejection without inventing native session capability", () => {
    const rejected = {id: "job-rejected", runId: "run-files", status: "invalid_result", revision: 2, inputError: "Material selection rejected"};
    expect(parseJob(rejected)).toMatchObject({inputError: "Material selection rejected"});
    expect(parseJob(rejected)).not.toHaveProperty("nativeSession");
    expect(parseJob({...rejected, inputError: 10})).not.toHaveProperty("inputError");
  });

  it("does not mark a mismatched server receipt ready", async () => {
    const { AttachmentDraft } = await client();
    const draft = new AttachmentDraft("run-files", async () => Response.json({...receipt("wrong-id"), runId: "other-run"}));
    await draft.add([new File(["hello\n"], "notes.txt")]);
    expect(draft.snapshot().files[0]?.status).toBe("failed");
    expect(draft.snapshot().files[0]?.receipt).toBeUndefined();
  });

  it("rejects file descriptors that change the selected immutable commit or escape a path", async () => {
    const { parseRunFiles } = await client();
    const file = { path: "evidence/notes.txt", name: "notes.txt", size: 6, mediaType: "text/plain", kind: "output", commit: COMMIT, previewable: true };
    expect(parseRunFiles({runId: "run-files", commit: COMMIT, files: [file]}, "run-files").files[0]?.commit).toBe(COMMIT);
    expect(() => parseRunFiles({runId: "run-files", commit: COMMIT, files: [{...file, commit: "b".repeat(40)}]}, "run-files")).toThrow(/invalid/i);
    expect(() => parseRunFiles({runId: "run-files", commit: COMMIT, files: [{...file, path: "../secret"}]}, "run-files")).toThrow(/invalid/i);
  });

  it("passes selected upload IDs to create and keeps the explicit revision identity across retries", async () => {
    const requests: Array<{url: string; body: any}> = [];
    const run = {id: "run-files", status: "running", baselineRepo: "run-run-files", inputCommit: COMMIT, maxDepth: 4, maxJobs: 48};
    const job = {id: "job-files", runId: "run-files", status: "running", revision: 1};
    const fetcher: typeof fetch = async (input, init) => { requests.push({url: String(input), body: JSON.parse(String(init?.body))}); return Response.json(String(input).endsWith("/runs") ? {run, rootJob: job} : {job}); };
    await createRun({runId: "run-files", task: "Review files", launchTime: "2026-11-01T00:00:00Z", uploadIds: ["upload-1"]}, fetcher);
    await reviseJob("job-files", "Review files", fetcher, {requestId: "revision-stable", uploadIds: ["upload-1"]});
    await reviseJob("job-files", "Review files", fetcher, {requestId: "revision-stable", uploadIds: ["upload-1"]});
    expect(requests[0]?.body.upload_ids).toEqual(["upload-1"]);
    expect(requests[1]).toEqual({url: "/v1/ui/jobs/job-files/revisions", body: {instructions: "Review files", request_id: "revision-stable", upload_ids: ["upload-1"]}});
    expect(requests[2]).toEqual(requests[1]);
  });
});

describe("inert material previews", () => {
  it("renders hostile file content as text and exposes truncation truthfully", () => {
    const html = renderToStaticMarkup(createElement(MaterialPreview, {name: "<img src=x onerror=alert(1)>.html", text: "<script>alert('file')</script>", truncated: true}));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("Preview limited to 64 KiB");
  });
});
