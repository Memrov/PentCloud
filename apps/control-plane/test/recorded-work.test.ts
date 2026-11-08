import { describe, expect, it } from "vitest";
import {
  recordedWorkPage,
  assertRecordedWorkAccess,
  RECORDED_WORK_PAGE
} from "../src/native/recorded-work";

describe("reporter recorded work", () => {
  it("makes every character available through bounded pages without splitting Unicode", () => {
    const work = {
      messages: [{ text: "evidence 🧪 ".repeat(20000) }],
      remoteCalls: [{ state: "unknown", name: "ffuf", remoteId: "520de8b8" }]
    };
    let offset = 0,
      text = "";
    for (let n = 0; n < 100; n++) {
      const page = recordedWorkPage(work, offset);
      expect(page.text.length).toBeLessThanOrEqual(RECORDED_WORK_PAGE);
      expect(/[\uD800-\uDBFF]$/.test(page.text)).toBe(false);
      text += page.text;
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(JSON.parse(text)).toEqual(work);
    for (const invalid of [-1, 0.5, Infinity, text.length + 1])
      expect(() => recordedWorkPage(work, invalid)).toThrow(/offset/);
  });
  it("requires an active reporter and a different attempt in the same run", () => {
    const requester = {
      id: "reporter",
      runId: "run-a",
      role: "reporter",
      status: "running"
    };
    const source = { id: "pentester", runId: "run-a" };
    expect(() => assertRecordedWorkAccess(requester, source)).not.toThrow();
    for (const bad of [
      { ...requester, role: "primary" },
      { ...requester, status: "completed" }
    ])
      expect(() => assertRecordedWorkAccess(bad, source)).toThrow();
    for (const bad of [
      { ...source, runId: "run-b" },
      { ...source, id: "reporter" }
    ])
      expect(() => assertRecordedWorkAccess(requester, bad)).toThrow();
  });
});
