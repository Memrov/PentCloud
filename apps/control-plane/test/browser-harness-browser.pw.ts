import { test, expect } from "../../../scripts/browser-qa/fixtures.mts";

// Both cases deliberately reuse one ID without deleting it. The harness must
// discard Worker state between tests, including an earlier stream connection.
for (const pass of [1, 2])
  test(`isolates real stream state between browser cases (${pass})`, async ({
    request,
    baseURL
  }) => {
    const endpoint = "/__fixtures/streams/isolation-proof";
    expect((await (await request.get(endpoint)).json()).connections).toBe(0);
    expect(
      (await request.post(endpoint, { data: { snapshot: { pass } } })).ok()
    ).toBe(true);
    const abort = new AbortController();
    try {
      const response = await fetch(
        new URL("/v1/ui/jobs/isolation-proof/events", baseURL),
        { signal: abort.signal }
      );
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const frame = await response.body!.getReader().read();
      expect(new TextDecoder().decode(frame.value)).toBe(
        `event: snapshot\ndata: ${JSON.stringify({ pass })}\n\n`
      );
      expect((await (await request.get(endpoint)).json()).connections).toBe(1);
    } finally {
      abort.abort();
    }
    const html = await request.get("/");
    expect(html.headers()["content-security-policy"]).toContain(
      "script-src 'self'"
    );
    expect(html.headers()["content-security-policy"]).toContain(
      "frame-ancestors 'none'"
    );
    expect(await html.text()).toContain("/assets/");
  });
