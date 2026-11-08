import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readonlyBrowserLiveView } from "../src/native/browser-live-view";
import { createBrowserLiveView } from "../src/ui/api";
import { BrowserLiveViewControl } from "../src/ui/components/browser-live-view";

const bearer = "https://live.browser.run/ui/view?wss=readonly-secret";
const browser = (view: unknown) =>
  ({ liveView: async () => view }) as Parameters<
    typeof readonlyBrowserLiveView
  >[0];
const binding = (view: unknown) =>
  ({ getLiveView: async () => view }) as Parameters<
    typeof readonlyBrowserLiveView
  >[1];

describe("on-demand readonly browser view", () => {
  it("returns unavailable for an absent existing browser without calling the provider", async () => {
    const provider = {
      getLiveView: () => {
        throw new Error("Browser must stay asleep");
      }
    };
    expect(
      await readonlyBrowserLiveView(browser(undefined), provider as never)
    ).toEqual({ available: false });
  });

  it("mints a one-minute view for the existing session with provider-enforced readonly permissions", async () => {
    let received: unknown;
    const provider = {
      getLiveView: async (...args: unknown[]) => {
        received = args;
        return {
          devtoolsFrontendUrl: bearer,
          webSocketDebuggerUrl: "wss://omit-secret",
          id: "omit-id",
          options: { mode: "tab", guardrails: { mode: "readonly" } }
        };
      }
    };
    const started = Date.now();
    const view = await readonlyBrowserLiveView(
      browser({
        sessionId: "existing",
        targets: [
          {
            targetId: "page",
            type: "page",
            url: "https://live.browser.run/ui/view?wss=discard-mutable-secret"
          }
        ]
      }),
      provider as never
    );
    expect(received).toEqual([
      "existing",
      {
        mode: "tab",
        targetId: "page",
        expiresInMs: 60_000,
        guardrails: { mode: "readonly" }
      }
    ]);
    expect(view).toEqual({
      available: true,
      readOnly: true,
      url: bearer,
      expiresAt: expect.any(Number)
    });
    if (view.available)
      expect(view.expiresAt - started).toBeGreaterThanOrEqual(60_000);
    expect(JSON.stringify(view)).not.toContain("discard-mutable-secret");
    expect(JSON.stringify(view)).not.toContain("omit-secret");
    expect(JSON.stringify(view)).not.toContain("omit-id");
  });

  it("fails closed without returning provider errors or mutable/untrusted credentials", async () => {
    const handle = browser({
      sessionId: "existing",
      targets: [{ targetId: "page", type: "page" }]
    });
    for (const value of [
      { devtoolsFrontendUrl: bearer, options: { mode: "tab" } },
      {
        devtoolsFrontendUrl: "https://attacker.test/ui/view?jwt=secret",
        options: { mode: "tab", guardrails: { mode: "readonly" } }
      }
    ])
      await expect(
        readonlyBrowserLiveView(handle, binding(value))
      ).rejects.toThrow("503: Browser view is unavailable");
    await expect(
      readonlyBrowserLiveView(handle, {
        getLiveView: async () => {
          throw new Error(bearer);
        }
      } as never)
    ).rejects.toThrow(/^503: Browser view is unavailable$/);
    expect(
      await readonlyBrowserLiveView(
        browser({ sessionId: "existing", targets: [] }),
        binding({})
      )
    ).toEqual({ available: false });
  });

  it("creates credentials through one POST and validates only a trusted, short-lived readonly result", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        available: true,
        readOnly: true,
        url: bearer,
        expiresAt: Date.now() + 60_000,
        providerSecret: "omit"
      })
    );
    const view = await createBrowserLiveView("job-1", fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/ui/jobs/job-1/browser-live-view",
      { method: "POST", cache: "no-store", referrerPolicy: "no-referrer" }
    );
    expect(JSON.stringify(view)).not.toContain("omit");
    for (const value of [
      {
        available: true,
        readOnly: false,
        url: bearer,
        expiresAt: Date.now() + 60_000
      },
      {
        available: true,
        readOnly: true,
        url: "javascript:alert(1)",
        expiresAt: Date.now() + 60_000
      },
      {
        available: true,
        readOnly: true,
        url: bearer,
        expiresAt: Date.now() - 1
      }
    ])
      await expect(
        createBrowserLiveView("job-1", async () => Response.json(value))
      ).rejects.toThrow("Invalid browser view");
  });

  it("renders an operator action without fetching credentials or embedding a viewer", () => {
    const html = renderToStaticMarkup(
      createElement(BrowserLiveViewControl, { jobId: "job-1" })
    );
    expect(html).toContain("Create browser view");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("live.browser.run");
  });
});
