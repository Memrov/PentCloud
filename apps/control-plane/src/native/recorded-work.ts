/** Bounded views of existing records; never a second transcript store. */
// JSON wrapping and UTF-8 encoding must still fit the inline tool-output budget.
export const RECORDED_WORK_PAGE = 8 * 1024;
export interface RecordedWorkPage {
  format: "json-fragment";
  offset: number;
  totalCharacters: number;
  text: string;
  nextOffset?: number;
}
export function recordedWorkPage(work: unknown, offset = 0): RecordedWorkPage {
  const text = JSON.stringify(work, null, 2);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error("400: Invalid recorded-work offset");
  let end = Math.min(text.length, offset + RECORDED_WORK_PAGE);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return {
    format: "json-fragment",
    offset,
    totalCharacters: text.length,
    text: text.slice(offset, end),
    ...(end < text.length ? { nextOffset: end } : {})
  };
}
export function assertRecordedWorkAccess(
  requester: { id: string; runId: string; role: string; status: string },
  source: { id: string; runId: string }
): void {
  if (requester.role !== "reporter" || requester.status !== "running")
    throw new Error("403: Recorded work requires the active reporter");
  if (requester.runId !== source.runId || requester.id === source.id)
    throw new Error("404: Recorded work is not an earlier attempt in this run");
}
