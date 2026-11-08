import { describe, expect, it } from "vite-plus/test";
import { parseFindings } from "../../../shared/findings";
import { findingsPath, readFindings } from "../src/native/findings";
const item = (id = "f-1") => ({
  id,
  title: "Access control issue",
  severity: "high",
  status: "confirmed",
  target: "https://api.example.com/v1/items",
  summary: "Another disposable account can read this record.",
  evidence: "GET returned the owned test marker.",
  report: "## Impact\nUnauthorized read.\n\n## Remediation\nCheck ownership.",
  evidencePaths: [".pentagi/evidence/p/captured/proof.txt"]
});
const document = (count = 1) => ({
  version: 1,
  coverage: "complete",
  summary: "Assessment summary",
  reportPath: ".pentagi/evidence/r/assessment.md",
  findings: Array.from({ length: count }, (_, i) => item("f-" + i))
});
describe("structured finding contract", () => {
  it.each([0, 1, 30, 1000])(
    "uses the same collection for %i findings",
    (count) => {
      expect(parseFindings(document(count)).findings).toHaveLength(count);
    }
  );
  it("rejects duplicate IDs instead of dropping a row", () => {
    expect(() =>
      parseFindings({ ...document(2), findings: [item(), item()] })
    ).toThrow(/duplicate/i);
  });
  it.each([
    "../private",
    "/etc/passwd",
    ".git/config",
    ".pentagi/jobs/p/result.json",
    "safe/../unsafe",
    "x\\y"
  ])("rejects unsafe evidence path %s", (path) => {
    expect(() =>
      parseFindings({
        ...document(),
        findings: [{ ...item(), evidencePaths: [path] }]
      })
    ).toThrow(/path/i);
  });
  it.each([
    { severity: "urgent" },
    { status: "fixed" },
    { target: "https://user:pass@example.com/" },
    { title: "" }
  ])("rejects invalid finding field %j", (patch) => {
    expect(() =>
      parseFindings({ ...document(), findings: [{ ...item(), ...patch }] })
    ).toThrow();
  });
  it("rejects unsupported versions and oversized collections", () => {
    expect(() => parseFindings({ ...document(), version: 2 })).toThrow(
      /version/i
    );
    expect(() => parseFindings(document(1001))).toThrow(/1000/);
  });
  it("keeps partial coverage distinct from a complete empty assessment", () => {
    expect(
      parseFindings({ ...document(0), coverage: "partial" }).coverage
    ).toBe("partial");
  });
});
describe("immutable native finding references", () => {
  const read = (values: Record<string, string>) => async (path: string) =>
    values[path] === undefined ? null : new Blob([values[path]!]);
  const files = (): Record<string, string> => ({
    [findingsPath("r")]: JSON.stringify(document()),
    ".pentagi/evidence/r/assessment.md": "# Assessment",
    ".pentagi/evidence/p/captured/proof.txt": "Owned marker"
  });
  it("loads exact references even when unrelated files exceed the old listing cap", async () => {
    const values = files();
    for (let i = 0; i < 200; i++) values["misc/" + i] = "x";
    const result = await readFindings(read(values), "r", true);
    expect(result?.document.findings).toHaveLength(1);
    expect(result?.files.map((x) => x.path)).toEqual([
      ".pentagi/evidence/r/assessment.md",
      ".pentagi/evidence/p/captured/proof.txt"
    ]);
  });
  it("distinguishes absent legacy index from missing required index", async () => {
    expect(await readFindings(read({}), "r", false)).toBeUndefined();
    await expect(readFindings(read({}), "r", true)).rejects.toThrow(
      /required/i
    );
  });
  it("rejects absent evidence/report and invalid UTF-8 index", async () => {
    const values = files();
    delete values[".pentagi/evidence/p/captured/proof.txt"];
    await expect(readFindings(read(values), "r", true)).rejects.toThrow(
      /reference/i
    );
    await expect(
      readFindings(async () => new Blob([new Uint8Array([255])]), "r", true)
    ).rejects.toThrow(/UTF-8/i);
  });
});

it("never interprets arbitrary legacy sidecars as a newly pinned contract", async () => {
  let reads = 0;
  const result = await readFindings(
    async () => {
      reads++;
      return new Blob(['{"findings":[]}']);
    },
    "old-reporter",
    false
  );
  expect(result).toBeUndefined();
  expect(reads).toBe(0);
});
