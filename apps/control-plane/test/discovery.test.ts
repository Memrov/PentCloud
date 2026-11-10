import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { discoveryOutcome, httpDiscovery } from "../src/native/discovery";
const envelope = (status: string, http_status: unknown = 200) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ status, http_status, scan_id: "known" })
    }
  ]
});

describe("best-effort initial HTTP discovery", () => {
  afterEach(() => vi.useRealTimers());
  it("retains the successful parallel probe when its peer uses the time budget", async () => {
    vi.useFakeTimers();
    const methods: string[] = [];
    const pending = httpDiscovery("https://example.com/", async (request) => {
      methods.push(request.method);
      if (request.method === "HEAD")
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          )
        );
      return new Response("<title>Owned fixture</title>", {
        headers: {
          "Content-Type": "text/html",
          "Set-Cookie": "private-session=secret",
          Server: "fixture"
        }
      });
    });
    expect(methods).toEqual(["HEAD", "GET"]);
    await vi.advanceTimersByTimeAsync(10000);
    const result = await pending;
    expect(result).toMatchObject({
      status: "completed",
      http_status: 200,
      coverage: "partial",
      probes: [
        { method: "HEAD", status: "timed_out" },
        {
          method: "GET",
          status: "completed",
          body: "<title>Owned fixture</title>",
          headers: { server: "fixture" }
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("private-session");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends stalled response bodies at the shared deadline and reports no usable response", async () => {
    vi.useFakeTimers();
    const pending = httpDiscovery("https://example.com/", async (request) => {
      if (request.method === "HEAD") throw new Error("HEAD unavailable");
      return new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => controller.error(request.signal.reason),
              { once: true }
            );
          }
        })
      );
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({
      status: "failed",
      coverage: "unavailable",
      probes: [
        { method: "HEAD", status: "failed", error: "HEAD unavailable" },
        { method: "GET", status: "timed_out" }
      ]
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds retained bodies and never follows a redirect outside the saved target", async () => {
    let cancelled = false;
    const result = await httpDiscovery(
      "https://example.com/",
      async (request) => {
        expect(request.url).toBe("https://example.com/");
        expect(request.redirect).toBe("manual");
        if (request.method === "HEAD")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://outside.invalid/" }
          });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("x".repeat(100000)));
            },
            cancel() {
              cancelled = true;
            }
          })
        );
      }
    );
    expect(result.probes[1]).toMatchObject({
      status: "completed",
      bodyTruncated: true
    });
    expect(result.probes[1]!.body).toHaveLength(65536);
    expect(cancelled).toBe(true);
    expect(result.http_status).toBe(302);
    expect(result.coverage).toBe("partial");
  });
  it("settles both probes before propagating caller cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const settled: string[] = [];
    const pending = httpDiscovery(
      "https://example.com/",
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              settled.push(request.method);
              reject(request.signal.reason);
            },
            { once: true }
          );
        }),
      controller.signal
    );
    const aborted = pending.catch((error: unknown) => error);
    controller.abort(new Error("Assessment stopped"));
    expect(await aborted).toMatchObject({ message: "Assessment stopped" });
    expect(settled).toEqual(["HEAD", "GET"]);
    expect(vi.getTimerCount()).toBe(0);
  });
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
