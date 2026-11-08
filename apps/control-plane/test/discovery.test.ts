import { describe, expect, it } from "vite-plus/test";
import { discoveryOutcome } from "../src/native/discovery";
const envelope = (status: string, http_status: unknown = 200) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ status, http_status, scan_id: "known" })
    }
  ]
});
describe("native discovery outcome classification", () => {
  it("distinguishes successful completion from failed-but-settled scanner envelopes", () => {
    expect(discoveryOutcome(envelope("completed")).success).toBe(true);
    for (const status of [
      "failed",
      "error",
      "timed_out",
      "cancelled",
      "running"
    ])
      expect(discoveryOutcome(envelope(status)).success).toBe(false);
    expect(discoveryOutcome({ isError: true, content: [] }).success).toBe(
      false
    );
  });
  it("does not call empty completed WhatWeb results successful discovery", () => {
    for (const httpStatus of [null, 0, "200", NaN, 99, 600])
      expect(discoveryOutcome(envelope("completed", httpStatus))).toEqual({
        success: false,
        status: "no-http-response"
      });
    expect(
      discoveryOutcome({
        content: [{ type: "text", text: '{"status":"completed"}' }]
      })
    ).toEqual({ success: false, status: "no-http-response" });
    // An observed HTTP response is useful discovery even without a technology match.
    for (const httpStatus of [200, 301, 401, 403, 500])
      expect(discoveryOutcome(envelope("completed", httpStatus))).toEqual({
        success: true,
        status: "completed"
      });
  });
});
