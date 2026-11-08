import { APIError } from "./api";
import { materialFileURL, type RunFile } from "./materials-api";
const LIMIT = 2 * 1024 * 1024;
export function reportCandidates(files: readonly RunFile[]): RunFile[] {
  return files.filter(
    (f) =>
      (f.kind === "output" || f.kind === "report") &&
      f.previewable &&
      /\.md$/i.test(f.path) &&
      (!f.path.startsWith(".pentagi/") ||
        (f.kind === "report" &&
          /^\.pentagi\/evidence\/[A-Za-z0-9._-]+\/[^\0]+\.md$/i.test(
            f.path
          ))) &&
      f.size <= LIMIT
  );
}
/** Only an explicit, unambiguous accepted path is selected automatically. */
export function referencedReport(
  files: readonly RunFile[],
  notes: string
): RunFile | undefined {
  const tokens = new Set(
    notes.split(/[\s`"'()[\]<>;,]+/).map((t) => t.replace(/[.:!?]+$/, ""))
  );
  const matches = files.filter((f) => tokens.has(f.path));
  return matches.length === 1 ? matches[0] : undefined;
}
export async function readReportText(response: Response): Promise<string> {
  if (!response.ok)
    throw new APIError(
      response.status,
      `Report unavailable (HTTP ${response.status})`
    );
  if (Number(response.headers.get("content-length")) > LIMIT)
    throw new Error(
      "Report exceeds the 2 MiB reader limit. Download it from Files."
    );
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        throw new Error(
          "Report exceeds the 2 MiB reader limit. Download it from Files."
        );
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new Error("Report is not valid UTF-8. Use Files to download it.");
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new Error("Report is not valid UTF-8. Use Files to download it.");
    }
  } finally {
    reader.releaseLock();
  }
  if (text.includes("\0"))
    throw new Error("Report contains binary data. Use Files to download it.");
  return text;
}
export async function readReportFile(
  runId: string,
  file: RunFile,
  fetcher: typeof fetch = globalThis.fetch
): Promise<string> {
  if (!reportCandidates([file]).length)
    throw new Error("Select a previewable Markdown output of at most 2 MiB.");
  return readReportText(
    await fetcher(materialFileURL(runId, file), {
      cache: "no-store",
      referrerPolicy: "no-referrer"
    })
  );
}
