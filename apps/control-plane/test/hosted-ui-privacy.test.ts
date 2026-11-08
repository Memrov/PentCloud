import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/ui/components/chat-markdown";
import { targetHeaders } from "../src/native/target-headers";
import { hostedUIResponse } from "../src/native/ui-response";
import { performAPIRequest } from "../src/native/api-access";

describe("hosted UI privacy", () => {
  it("keeps formatted findings while suppressing image loads, preloads and embedded HTML", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        children:
          '# Finding\n\n**Critical** and `code`.\n\n![tracker](https://target.invalid/pixel.png)\n\n<img src="https://target.invalid/html.png" srcset="https://target.invalid/retina.png 2x">\n<iframe src="https://target.invalid/frame"></iframe>\n<video src="https://target.invalid/movie"></video>\n<link rel="preload" href="https://target.invalid/style.css">'
      })
    );
    expect(html).toContain("Finding");
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain("<code");
    expect(html).toContain("Image hidden");
    expect(html).not.toMatch(/<(?:img|iframe|video|source|link)\b/);
    expect(html).not.toContain("target.invalid");
  });
  it("keeps external navigation behind explicit interaction and rejects executable URLs", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        children:
          "[Inspect target](https://target.invalid/)\n\n[bad](javascript:alert(1))"
      })
    );
    expect(html).toContain("Inspect target");
    expect(html).toContain("external-link");
    expect(html).not.toMatch(/href="https:\/\/target/);
    expect(html).not.toContain("javascript:");
  });
  it("confines production connections to the installation, allowing its exact WebSocket host", async () => {
    const original = new Response("<html>UI</html>", {
      headers: { "Content-Type": "text/html", ETag: "build-one" }
    });
    const response = hostedUIResponse(
      original,
      "https://pentcloud.account.workers.dev/settings"
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'self' wss://pentcloud.account.workers.dev"
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self'"
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-src 'none'"
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("ETag")).toBe("build-one");
    expect(await response.text()).toBe("<html>UI</html>");
  });
  it("prevents edge script injection without changing private cache directives or API responses", () => {
    const html = hostedUIResponse(
      new Response("<html>UI</html>", {
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "private, no-store"
        }
      }),
      "https://app.invalid/"
    );
    expect(html.headers.get("Cache-Control")).toBe(
      "private, no-store, no-transform"
    );
    const again = hostedUIResponse(html, "https://app.invalid/");
    expect(again.headers.get("Cache-Control")).toBe(
      "private, no-store, no-transform"
    );
    const data = hostedUIResponse(
      Response.json(
        { ok: true },
        { headers: { "Cache-Control": "private, no-store" } }
      ),
      "https://app.invalid/v1/ui/runs"
    );
    expect(data.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("target HTTP identity boundary", () => {
  it("drops operator identity and forwarding headers without altering explicit target API keys", () => {
    const headers = targetHeaders(
      {
        "CF-Connecting-IP": "192.0.2.1",
        "CF-Connecting-IPv6": "2001:db8::1",
        "X-Real-IP": "192.0.2.1",
        "X-Forwarded-For": "192.0.2.1",
        Forwarded: "for=192.0.2.1",
        "True-Client-IP": "192.0.2.1",
        "CF-Access-Jwt-Assertion": "operator",
        "CF-Access-Token": "operator",
        Cookie: "CF_Authorization=operator",
        Authorization: "Bearer operator",
        Referer: "https://pentcloud.invalid/private",
        Origin: "https://pentcloud.invalid",
        Accept: "application/json"
      },
      { header: "Authorization", value: "Bearer target-test-key" }
    );
    const actual: Record<string, string> = {};
    headers.forEach((value, name) => {
      actual[name] = value;
    });
    expect(actual).toEqual({
      accept: "application/json",
      authorization: "Bearer target-test-key"
    });
    expect(
      targetHeaders({}, { header: "X-API-Key", value: "target-key" }).get(
        "X-API-Key"
      )
    ).toBe("target-key");
  });
  it("rejects reserved identity credentials before issuing a target request", async () => {
    let called = false;
    await expect(
      performAPIRequest(
        {
          targetURL: "https://target.invalid/",
          header: "CF-Connecting-IP",
          value: "private"
        },
        { path: "/", method: "GET" },
        async () => {
          called = true;
          return new Response();
        }
      )
    ).rejects.toThrow(/identity headers/);
    expect(called).toBe(false);
  });
});
