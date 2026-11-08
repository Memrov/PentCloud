import { it, expect } from "vite-plus/test";
import {
  validateBrowserState,
  assertBrowserCommand,
  fillLogin
} from "../src/native/browser-target-access";
const target = {
  url: "https://example.com/",
  access: {
    headers: [],
    login: {
      url: "https://example.com/login",
      usernameBinding: "PENTCLOUD_TARGET_USER",
      passwordBinding: "PENTCLOUD_TARGET_PASS"
    }
  }
};
it("retains native browser clicks, typing and viewport control", () => {
  for (const method of [
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Emulation.setDeviceMetricsOverride"
  ])
    expect(() => assertBrowserCommand(target, method)).not.toThrow();
});
it("keeps only this target's authenticated state and rejects unrelated origins", () => {
  const good = {
    cookies: [
      {
        name: "session",
        value: "private-cookie",
        domain: "example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax"
      }
    ],
    origins: [
      {
        origin: "https://example.com",
        localStorage: [{ name: "auth", value: "private-token" }]
      }
    ]
  };
  expect(validateBrowserState(target, good)).toEqual(good);
  expect(() =>
    validateBrowserState(target, {
      ...good,
      cookies: [{ ...good.cookies[0], domain: "attacker.test" }]
    })
  ).toThrow(/origin|target/);
  expect(() =>
    validateBrowserState(target, {
      cookies: [],
      origins: [{ origin: "https://attacker.test", localStorage: [] }]
    })
  ).toThrow();
});
it("prevents browser scripts from replacing the trusted network layer or opening another context", () => {
  for (const method of [
    "Fetch.disable",
    "Target.createBrowserContext",
    "Target.sendMessageToTarget",
    "ServiceWorker.enable",
    "Network.loadNetworkResource",
    "Network.setRequestInterception",
    "Network.continueInterceptedRequest",
    "Browser.close"
  ])
    expect(() => assertBrowserCommand(target, method, {})).toThrow(/managed/i);
  expect(() =>
    assertBrowserCommand(target, "Page.navigate", {
      url: "https://outside.test/"
    })
  ).toThrow();
  expect(() =>
    assertBrowserCommand(target, "Page.navigate", {
      url: "https://example.com/login"
    })
  ).not.toThrow();
  expect(() =>
    assertBrowserCommand(target, "Runtime.evaluate", {
      expression: "document.title"
    })
  ).not.toThrow();
});
it("does not read a password when the page has left its credential audience", async () => {
  let reads = 0;
  await expect(
    fillLogin(
      target,
      {
        url: () => "https://outside.test/",
        evaluate: async () => {
          throw new Error("must not run");
        }
      } as never,
      {
        pageURL: "https://example.com/login",
        usernameSelector: "#username",
        passwordSelector: "#password"
      },
      async () => {
        reads++;
        return "secret";
      }
    )
  ).rejects.toThrow();
  expect(reads).toBe(0);
});
it("pins the inspected login URL across asynchronous secret resolution", async () => {
  let url = "https://example.com/login",
    evaluated = false;
  const page = {
    url: () => url,
    evaluate: async () => {
      evaluated = true;
    }
  };
  await expect(
    fillLogin(
      target,
      page as never,
      { pageURL: url, usernameSelector: "#user", passwordSelector: "#pass" },
      async () => {
        url = "https://example.com/untrusted";
        return "secret";
      }
    )
  ).rejects.toThrow(/page|target/i);
  expect(evaluated).toBe(false);
});
