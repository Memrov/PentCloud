/** Versioned data shared by native validation and the read-only findings UI. */
export const FINDINGS_LIMIT = 2 * 1024 * 1024;
export const severities = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
  "unknown"
] as const;
export type FindingSeverity = (typeof severities)[number];
export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  status: "suspected" | "confirmed" | "inconclusive";
  target: string;
  summary: string;
  evidence: string;
  report: string;
  evidencePaths: string[];
}
export interface FindingsDocument {
  version: 1;
  coverage: "complete" | "partial";
  summary: string;
  reportPath: string;
  findings: Finding[];
}
export interface FindingFile {
  path: string;
  size: number;
}
export interface FindingsBundle {
  document: FindingsDocument;
  files: FindingFile[];
}
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
function text(
  value: unknown,
  name: string,
  max: number,
  empty = false
): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error(`Invalid finding ${name}`);
  return value;
}
export function findingFilePath(value: unknown): string {
  const path = text(value, "path", 2048);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path
      .split("/")
      .some(
        (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git"
      ) ||
    (path.startsWith(".") && !path.startsWith(".pentagi/evidence/"))
  )
    throw new Error("Invalid finding file path");
  return path;
}
export function parseFindings(value: unknown): FindingsDocument {
  if (!object(value) || value.version !== 1)
    throw new Error("Unsupported findings version");
  if (!["complete", "partial"].includes(String(value.coverage)))
    throw new Error("Invalid findings coverage");
  if (!Array.isArray(value.findings) || value.findings.length > 1000)
    throw new Error("Findings requires an array of at most 1000 records");
  const ids = new Set<string>();
  const findings = value.findings.map((x): Finding => {
    if (!object(x)) throw new Error("Invalid finding record");
    const id = text(x.id, "id", 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
      throw new Error("Invalid finding id");
    if (ids.has(id)) throw new Error("Duplicate finding id");
    ids.add(id);
    if (
      !severities.includes(x.severity as FindingSeverity) ||
      !["suspected", "confirmed", "inconclusive"].includes(String(x.status))
    )
      throw new Error("Invalid finding severity/status");
    const target = text(x.target, "target", 2048);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error("Invalid finding target");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid finding target");
    if (!Array.isArray(x.evidencePaths) || x.evidencePaths.length > 128)
      throw new Error("Invalid finding evidence paths");
    return {
      id,
      title: text(x.title, "title", 500),
      severity: x.severity as FindingSeverity,
      status: x.status as Finding["status"],
      target,
      summary: text(x.summary, "summary", 8000),
      evidence: text(x.evidence, "evidence", 64000, true),
      report: text(x.report, "report", 256000),
      evidencePaths: [...new Set(x.evidencePaths.map(findingFilePath))]
    };
  });
  const reportPath = findingFilePath(value.reportPath);
  if (!/\.md$/i.test(reportPath))
    throw new Error("Finding report path must be Markdown");
  return {
    version: 1,
    coverage: value.coverage as FindingsDocument["coverage"],
    summary: text(value.summary, "summary", 16000),
    reportPath,
    findings
  };
}
