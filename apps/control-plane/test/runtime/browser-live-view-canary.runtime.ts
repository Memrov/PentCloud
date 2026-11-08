import { expect, it } from "vite-plus/test";
import canary, {
  runBrowserLiveViewCanary
} from "../native-browser-live-view-canary/worker";

function provider(readonly = true, fail = false) {
  let active = false;
  let acquisitions = 0;
  let closes = 0;
  const options: unknown[] = [];
  const bearer = "https://live.browser.run/ui/view?wss=canary-secret-bearer";
  const targets = [
    {
      id: "blank-page",
      type: "page",
      url: "about:blank",
      devtoolsFrontendUrl: bearer
    }
  ];
  const BROWSER = {
    acquire: async () => {
      acquisitions++;
      active = true;
      return { sessionId: "canary-session" };
    },
    fetch: async () => Response.json(targets),
    devtools: { listTargets: async () => targets },
    getLiveView: async (_id: string, input: unknown) => {
      options.push(input);
      if (fail) throw new Error(bearer);
      return {
        devtoolsFrontendUrl: bearer,
        options: {
          mode: "tab",
          ...(readonly ? { guardrails: { mode: "readonly" } } : {})
        }
      };
    },
    closeSession: async () => {
      closes++;
      active = false;
      return { status: "closed" };
    },
    getSession: async () =>
      active ? { sessionId: "canary-session", endTime: 0 } : null
  } as unknown as BrowserRun;
  return {
    env: { BROWSER, CANARY_TOKEN: "test-canary-token" },
    calls: () => ({ acquisitions, closes, options }),
    bearer
  };
}

it("checks the actual Browser/helper contract once and returns safe metadata after positive close readback", async () => {
  const fixture = provider();
  const result = await runBrowserLiveViewCanary(fixture.env);
  expect(result).toMatchObject({
    result: "passed",
    phase: "complete",
    initialUnavailable: true,
    acquisitions: 1,
    viewerRequests: 1,
    readOnly: true,
    hostedOrigin: "https://live.browser.run",
    expiresInMsRequested: 60000,
    blankPage: true,
    credentialsInStore: false,
    closed: true,
    modelCalls: 0,
    scannerCalls: 0,
    kaliCalls: 0
  });
  expect(fixture.calls()).toEqual({
    acquisitions: 1,
    closes: 1,
    options: [
      {
        mode: "tab",
        targetId: "blank-page",
        expiresInMs: 60000,
        guardrails: { mode: "readonly" }
      }
    ]
  });
  expect(JSON.stringify(result)).not.toContain(fixture.bearer);
  expect(JSON.stringify(result)).not.toContain("canary-secret-bearer");
});

it("closes its browser on mutable provider responses and credential-bearing provider exceptions", async () => {
  for (const fixture of [provider(false), provider(true, true)]) {
    const result = await runBrowserLiveViewCanary(fixture.env);
    expect(result).toMatchObject({
      result: "failed",
      closed: true,
      viewerRequests: 1,
      acquisitions: 1
    });
    expect(fixture.calls().closes).toBe(1);
    expect(JSON.stringify(result)).not.toContain("canary-secret-bearer");
  }
});

it("rejects unauthorized and read-only requests without acquiring a browser", async () => {
  const fixture = provider();
  expect(
    (
      await canary.fetch(
        new Request("https://canary.test/run", { method: "POST" }),
        fixture.env
      )
    ).status
  ).toBe(401);
  expect(
    (
      await canary.fetch(
        new Request("https://canary.test/run", {
          headers: { Authorization: "Bearer test-canary-token" }
        }),
        fixture.env
      )
    ).status
  ).toBe(404);
  expect(fixture.calls()).toEqual({ acquisitions: 0, closes: 0, options: [] });
});
