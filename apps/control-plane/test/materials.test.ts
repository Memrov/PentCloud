import { describe, expect, it } from "vitest";
import {
  materialSelection,
  normalizeUploadIds,
  selectionManifest,
  type MaterialFile
} from "../src/native/materials";

const file = (
  name = "notes.txt",
  sha = "a".repeat(64),
  size = 5
): MaterialFile => ({
  id: "upload-one",
  name,
  sha256: sha,
  size,
  mediaType: "text/plain",
  kind: "text",
  sourcePath: `.pentagi/materials/${sha}/source`,
  textPath: `.pentagi/materials/${sha}/source`,
  textSha256: sha,
  textSize: size,
  uploadedBy: "owner",
  createdAt: 100
});

describe("material selection contracts", () => {
  it("normalizes upload identity sets without accepting paths or unlimited batches", () => {
    expect(normalizeUploadIds(undefined)).toEqual([]);
    expect(normalizeUploadIds(["two", "one", "two"])).toEqual(["one", "two"]);
    for (const invalid of [
      null,
      "one",
      ["../x"],
      ["x/y"],
      [""],
      Array.from({ length: 9 }, (_, i) => `u${i}`)
    ])
      expect(() => normalizeUploadIds(invalid)).toThrow("400");
  });

  it("pins a stable merged selection while replacing only the same display filename", async () => {
    const first = await materialSelection(undefined, [
      file("b.txt"),
      { ...file("a.txt", "b".repeat(64)), id: "second" }
    ]);
    const next = await materialSelection(first, [
      { ...file("a.txt", "c".repeat(64)), id: "replacement" }
    ]);
    expect(next.files.map((f) => [f.name, f.sha256])).toEqual([
      ["a.txt", "c".repeat(64)],
      ["b.txt", "a".repeat(64)]
    ]);
    expect(first.files.find((f) => f.name === "a.txt")!.sha256).toBe(
      "b".repeat(64)
    );
    const reordered = await materialSelection(
      undefined,
      [...next.files].reverse()
    );
    expect(reordered).toEqual(next);
    expect(next.manifestPath).toBe(
      `.pentagi/materials/selections/${next.digest}.json`
    );
    expect(next.digest).toMatch(/^[a-f0-9]{64}$/);
    const manifest = selectionManifest(next);
    expect(JSON.parse(manifest)).toEqual({ version: 1, files: next.files });
    expect(manifest).not.toContain('"digest"');
    const actual = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest))
    );
    expect(
      [...actual].map((b) => b.toString(16).padStart(2, "0")).join("")
    ).toBe(next.digest);
  });

  it("rejects forged protected paths, text hashes and selection count or byte overflow", async () => {
    for (const invalid of [
      { ...file(), sourcePath: "source.ts" },
      { ...file(), textPath: ".pentagi/../source" },
      { ...file(), sha256: "bad" },
      { ...file(), textSha256: "b".repeat(64) },
      { ...file(), name: "../notes.txt" },
      { ...file(), name: "." },
      { ...file(), size: 2 * 1024 * 1024 + 1 }
    ])
      await expect(materialSelection(undefined, [invalid])).rejects.toThrow(
        "400"
      );
    await expect(
      materialSelection(
        undefined,
        Array.from({ length: 9 }, (_, i) => file(`${i}.txt`))
      )
    ).rejects.toThrow("400");
    await expect(
      materialSelection(
        undefined,
        Array.from({ length: 5 }, (_, i) =>
          file(`${i}.txt`, "a".repeat(64), 2 * 1024 * 1024)
        )
      )
    ).rejects.toThrow("400");
  });

  it("does not trust altered previous selections when merging a follow-up", async () => {
    const previous = await materialSelection(undefined, [file()]);
    await expect(
      materialSelection({ ...previous, digest: "0".repeat(64) }, [])
    ).rejects.toThrow("400");
    await expect(
      materialSelection(
        { ...previous, files: [{ ...file(), textSize: 6 }] },
        []
      )
    ).rejects.toThrow("400");
  });
});
