/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from "vitest";
import { managedBrowser } from "../../src/native/managed-retrieval";

describe("managed browser link extraction in Workers", () => {
  it("extracts valid scoped links from actual HTML and resolves against the final redirect URL", async () => {
    const visited: string[] = [];
    const result = await managedBrowser({ url: "https://example.com/docs/start", action: "links" }, {
      binding: {} as Ai,
      scopes: ["https://example.com/docs/"],
      signal: new AbortController().signal,
      fetch: async (input) => {
        visited.push(String(input));
        if (visited.length === 1) return new Response(null, { status: 302, headers: { location: "/docs/final/" } });
        return new Response('<a href=child?x=1&amp;y=2>unquoted</a><a href="child?x=1&amp;y=2">duplicate</a><a href="/private">outside</a><a href="https://user:pass@example.com/docs/">credentials</a><a href="javascript:alert(1)">script</a><a href="/docs/allowed">allowed</a>', { headers: { "content-type": "text/html" } });
      },
    });
    expect(visited).toEqual(["https://example.com/docs/start", "https://example.com/docs/final/"]);
    expect(result).toEqual({ status: 200, url: "https://example.com/docs/final/", links: ["https://example.com/docs/final/child?x=1&y=2", "https://example.com/docs/allowed"] });
  });

  it("preserves a readable HTTP error page and rejects missing redirect locations", async () => {
    const options = { binding: {} as Ai, scopes: ["https://example.com/docs/"], signal: new AbortController().signal };
    const result = await managedBrowser({ url: "https://example.com/docs/missing", action: "html" }, { ...options, fetch: async () => new Response("<h1>Missing</h1>", { status: 404, headers: { "content-type": "text/html" } }) });
    expect(result).toEqual({ status: 404, url: "https://example.com/docs/missing", html: "<h1>Missing</h1>" });
    await expect(managedBrowser({ url: "https://example.com/docs/missing", action: "html" }, { ...options, fetch: async () => new Response("redirect", { status: 302 }) })).rejects.toThrow("Browser redirect omitted Location");
  });
});
