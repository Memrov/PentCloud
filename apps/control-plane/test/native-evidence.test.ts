import { describe, it, expect } from "vitest";
import {
  validateEvidenceCheckpoint,
  evidenceManifestPath,
  evidenceBytesHash,
  stockOutputPaths,
  type EvidenceManifest
} from "../src/native/evidence";
const base = "a".repeat(40),
  commit = "b".repeat(40),
  scope = {
    runId: "run-one",
    id: "job-one",
    inputCommit: base,
    promptDigest: "c".repeat(64)
  };
async function fixture() {
  const path = ".pentagi/evidence/job-one/tool/result.json",
    body = new TextEncoder().encode('{"status":"completed"}');
  const manifest: EvidenceManifest = {
    version: 1,
    runId: scope.runId,
    jobId: scope.id,
    inputCommit: base,
    promptDigest: scope.promptDigest,
    sequence: 1,
    files: [
      {
        path,
        size: body.length,
        sha256: await evidenceBytesHash(body),
        tool: "nmap_get_scan_results",
        receiptId: "call-one",
        generation: "generation-one",
        source: "tool-result"
      }
    ]
  };
  const text = JSON.stringify(manifest) + "\n",
    manifestPath = evidenceManifestPath(scope.id);
  const receipt = {
    commit,
    parentCommit: base,
    manifestPath,
    manifestDigest: await evidenceBytesHash(new TextEncoder().encode(text)),
    sequence: 1
  };
  const files = new Map([
    [path, new Blob([body])],
    [manifestPath, new Blob([text])]
  ]);
  const trees: Record<
    string,
    Array<{ name: string; type: string; hash: string }>
  > = {
    before: [],
    after: [{ name: ".pentagi", type: "tree", hash: "p" }],
    p: [{ name: "evidence", type: "tree", hash: "e" }],
    e: [{ name: scope.id, type: "tree", hash: "owned" }],
    owned: [
      { name: "manifest.json", type: "blob", hash: "m" },
      { name: "tool", type: "tree", hash: "tool" }
    ],
    tool: [{ name: "result.json", type: "blob", hash: "r" }]
  };
  const repo = {
    async readCommit(c: string) {
      return c === commit
        ? { parents: [base], treeHash: "after" }
        : c === base
          ? { parents: [], treeHash: "before" }
          : null;
    },
    async readTree(t: string) {
      return trees[t] ?? null;
    },
    async readFile({ path }: { path: string }) {
      return files.get(path) ?? null;
    }
  };
  return { repo, manifest, receipt, files, trees };
}
describe("immutable evidence checkpoints", () => {
  it("collects only exact family output references and rejects traversal or other roots", () => {
    expect(
      stockOutputPaths("playwright", {
        path: "/opt/kali-mcp/output/playwright/screenshot.png",
        nested: [
          "/etc/passwd",
          "/opt/kali-mcp/output/nmap/other.xml",
          "/opt/kali-mcp/output/playwright/../private",
          "/opt/kali-mcp/output/playwright/.git/config"
        ]
      })
    ).toEqual(["/opt/kali-mcp/output/playwright/screenshot.png"]);
  });
  it("recognizes stock Playwright Markdown links without authorizing arbitrary paths", () => {
    expect(
      stockOutputPaths("playwright", {
        content: [
          {
            type: "text",
            text: "### Snapshot\n- [Snapshot](../opt/kali-mcp/output/playwright/page.yml)\n[bad](../opt/kali-mcp/output/playwright/%2e%2e/private) [secret](/etc/passwd)"
          }
        ]
      })
    ).toEqual(["/opt/kali-mcp/output/playwright/page.yml"]);
  });
  it("accepts exact own-job evidence without accepting a terminal result", async () => {
    const f = await fixture();
    expect(await validateEvidenceCheckpoint(f.repo, scope, f.receipt)).toEqual(
      f.manifest
    );
  });
  it("rejects changed content, scope and parent lineage", async () => {
    const f = await fixture();
    f.files.set(f.manifest.files[0]!.path, new Blob(["tampered"]));
    await expect(
      validateEvidenceCheckpoint(f.repo, scope, f.receipt)
    ).rejects.toThrow();
    const g = await fixture();
    await expect(
      validateEvidenceCheckpoint(
        g.repo,
        { ...scope, runId: "different" },
        g.receipt
      )
    ).rejects.toThrow();
    await expect(
      validateEvidenceCheckpoint(g.repo, scope, {
        ...g.receipt,
        parentCommit: "d".repeat(40)
      })
    ).rejects.toThrow();
  });
  it("rejects unrelated source changes and forged terminal files in a checkpoint", async () => {
    const f = await fixture();
    f.trees.after!.push({
      name: "app.ts",
      type: "blob",
      hash: "source-change"
    });
    await expect(
      validateEvidenceCheckpoint(f.repo, scope, f.receipt)
    ).rejects.toThrow();
    const g = await fixture();
    g.manifest.files[0]!.path = ".pentagi/jobs/job-one/result.json";
    const text = JSON.stringify(g.manifest) + "\n";
    g.files.set(g.receipt.manifestPath, new Blob([text]));
    g.receipt.manifestDigest = await evidenceBytesHash(
      new TextEncoder().encode(text)
    );
    await expect(
      validateEvidenceCheckpoint(g.repo, scope, g.receipt)
    ).rejects.toThrow();
  });
});

it("terminal publication cannot alter previously checkpointed evidence", async () => {
  const { assertEvidencePreserved } = await import("../src/native/evidence");
  const f = await fixture();
  await expect(
    assertEvidencePreserved(f.repo, commit, f.receipt, f.manifest.files)
  ).resolves.toBeUndefined();
  f.files.set(
    f.manifest.files[0]!.path,
    new Blob(["changed after checkpoint"])
  );
  await expect(
    assertEvidencePreserved(f.repo, commit, f.receipt, f.manifest.files)
  ).rejects.toThrow();
});
