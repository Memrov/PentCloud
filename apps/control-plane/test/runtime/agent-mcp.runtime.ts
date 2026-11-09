/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, exports } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { accessKeys, accessToken } from "./access-fixture";
import { digest } from "../../src/native/domain";
import { agentBrowserResponse } from "../../src/native/agent-browser";
import type { NativeEnv } from "../../src/native/types";
import type { RuntimeFixtureEnv, RecordedCall } from "./router-fixture";

const bindings = env as unknown as RuntimeFixtureEnv;
const app = exports as unknown as { default: Fetcher };
const clients: Client[] = [];
const coordinator = () => bindings.COORDINATOR.getByName("global");
const calls = async () =>
  JSON.parse(await coordinator().calls()) as RecordedCall[];
const json = (value: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value)
});
async function connect(email = "operator") {
  const client = new Client({ name: "PentCloud test client", version: "1" });
  const assertion = await accessToken(undefined, undefined, email);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://operator.test/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("Host", "operator.test");
        request.headers.set("Cf-Access-Jwt-Assertion", assertion);
        return app.default.fetch(request);
      }
    })
  );
  clients.push(client);
  return client;
}
beforeEach(async () => {
  accessKeys();
  await coordinator().clearCalls();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  vi.restoreAllMocks();
});

it("protects MCP with the real Access verifier and rejects foreign browser origins before execution", async () => {
  for (const [assertion, expected] of [
    [undefined, 401],
    ["not-a-jwt", 403],
    [await accessToken("https://wrong.invalid"), 403],
    [await accessToken(undefined, "wrong-audience"), 403],
    [await accessToken(undefined, undefined, "operator", "-1m"), 403],
    [await accessToken(undefined, undefined, "access-service"), 403]
  ] as const) {
    const headers = new Headers(json({}).headers);
    if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);
    expect(
      (
        await app.default.fetch("https://operator.test/mcp", {
          ...json({}),
          headers
        })
      ).status
    ).toBe(expected);
  }
  expect(
    (
      await app.default.fetch("https://operator.test/mcp", {
        ...json({}),
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(),
          Origin: "https://foreign.test"
        }
      })
    ).status
  ).toBe(403);
  expect(await calls()).toEqual([]);
});

it("drives real MCP requests through native routes with authorization, actor audit and unchanged session fences", async () => {
  const client = await connect();
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
    "pentcloud_read",
    "pentcloud_onboarding",
    "pentcloud_start",
    "pentcloud_activate",
    "pentcloud_job",
    "pentcloud_cancel",
    "pentcloud_browser",
    "pentcloud_browser_close"
  ]);
  expect(
    await client.callTool({
      name: "pentcloud_read",
      arguments: { resource: "targets" }
    })
  ).not.toHaveProperty("isError", true);
  const start = {
    run_id: "run-agent",
    target_id: "target-1",
    target_revision: 1,
    authorized: true,
    task: "Review approved scope"
  };
  await client.callTool({
    name: "pentcloud_read",
    arguments: { resource: "models", modelRoute: "console", refresh: true }
  });
  expect(await calls()).toContainEqual({
    method: "modelCatalog",
    args: ["console", true]
  });
  const denied = await client.callTool({
    name: "pentcloud_start",
    arguments: { ...start, authorized: false }
  });
  expect(denied.isError).toBe(true);
  expect((await calls()).some((c) => c.method === "createRun")).toBe(false);
  expect(
    await client.callTool({ name: "pentcloud_start", arguments: start })
  ).not.toHaveProperty("isError", true);
  expect(await calls()).toContainEqual({
    method: "createRun",
    args: [{ ...start, actor: "operator" }]
  });
  expect(
    (
      await client.callTool({
        name: "pentcloud_onboarding",
        arguments: { action: "credential.save", input: { secret: "rejected" } }
      })
    ).isError
  ).toBe(true);
  expect(
    (
      await client.callTool({
        name: "pentcloud_job",
        arguments: {
          jobId: "purged",
          action: "form_reply",
          controlId: "question-1",
          input: { answers: [["yes"]] }
        }
      })
    ).isError
  ).toBe(true);
  expect((await calls()).filter((c) => c.method === "replyNative")).toEqual([]);
  await client.callTool({
    name: "pentcloud_job",
    arguments: {
      jobId: "job-1",
      action: "form_reply",
      controlId: "question-1",
      input: { answers: [["yes"]] }
    }
  });
  expect(await calls()).toContainEqual({
    method: "replyNative",
    args: ["form", "question-1", { answers: [["yes"]] }, false]
  });
});

it("isolates browser ownership across users and reconnects the same user without exposing assertions", async () => {
  const alice = await connect("alice@example.com"),
    bob = await connect("bob@example.com");
  for (const client of [alice, bob, await connect("alice@example.com")]) {
    const result = await client.callTool({
      name: "pentcloud_browser",
      arguments: { code: "inspect" }
    });
    expect(result).not.toHaveProperty("isError", true);
    expect(JSON.stringify(result)).not.toContain("assertion");
  }
  const browserCalls = (await calls()).filter(
    (c) => c.method === "agentBrowser"
  );
  const aliceKey = await digest(["https://operator.test", "alice@example.com"]);
  const bobKey = await digest(["https://operator.test", "bob@example.com"]);
  expect(browserCalls.map((c) => c.args[0])).toEqual([
    aliceKey,
    bobKey,
    aliceKey
  ]);
  expect(
    (
      await alice.callTool({
        name: "pentcloud_browser",
        arguments: { code: "screenshot" }
      })
    ).content
  ).toContainEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
  expect(
    (await alice.callTool({ name: "pentcloud_browser_close", arguments: {} }))
      .content
  ).toEqual([{ type: "text", text: '{"closed":true}' }]);
});

it("serves the private app with fresh server-side identity and rejects foreign origins, expired grants, MCP recursion and sockets", async () => {
  const origin = "https://operator.test";
  const auth = {
    origin,
    expiresAt: Date.now() + 300000,
    identity: "operator",
    assertion: await accessToken()
  };
  const nativeEnv = env as unknown as NativeEnv;
  const response = await agentBrowserResponse(
    new Request("http://pentcloud.internal/v1/ui/onboarding", {
      headers: {
        "Cf-Access-Jwt-Assertion": "attacker",
        Cookie: "attacker",
        Authorization: "attacker"
      }
    }),
    auth,
    nativeEnv
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ targets: [] });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.has("Set-Cookie")).toBe(false);
  expect(
    (
      await agentBrowserResponse(
        new Request("http://pentcloud.internal/"),
        { ...auth, expiresAt: Date.now() - 1 },
        nativeEnv
      )
    ).status
  ).toBe(401);
  for (const [url, headers] of [
    ["https://outside.test/v1/ui/onboarding", {}],
    [
      "http://pentcloud.internal/v1/ui/onboarding",
      { Origin: "http://foreign.internal" }
    ],
    ["http://pentcloud.internal/mcp", {}],
    [
      "http://pentcloud.internal/agents/coordinator/global",
      { Upgrade: "websocket" }
    ]
  ] as const)
    expect(
      (
        await agentBrowserResponse(
          new Request(url, { headers }),
          auth,
          nativeEnv
        )
      ).status
    ).toBe(403);
  expect(
    (
      await agentBrowserResponse(
        new Request("http://pentcloud.internal/"),
        undefined,
        nativeEnv
      )
    ).status
  ).toBe(401);
  expect(
    (
      await agentBrowserResponse(
        new Request("http://pentcloud.internal/"),
        {
          ...auth,
          assertion: await accessToken(undefined, undefined, "operator", "-1m")
        },
        nativeEnv
      )
    ).status
  ).toBe(401);
  const action = await agentBrowserResponse(
    new Request("http://pentcloud.internal/v1/ui/onboarding/target.check", {
      ...json({ id: "target-1", revision: 1, requestId: "check-1" }),
      headers: { ...json({}).headers, Origin: "http://pentcloud.internal" }
    }),
    auth,
    nativeEnv
  );
  expect(action.status).toBe(200);
  expect(await calls()).toContainEqual({
    method: "onboardingAction",
    args: [
      "target.check",
      { id: "target-1", revision: 1, requestId: "check-1" },
      "operator"
    ]
  });
});

it("loads private HTTP compatibility code under the existing CSP without returning credentials", async () => {
  const auth = {
    origin: "https://operator.test",
    expiresAt: Date.now() + 300000,
    identity: "operator",
    assertion: await accessToken()
  };
  const nativeEnv = {
    ...env,
    ASSETS: {
      fetch: async () =>
        new Response("<html><head></head><body>PentCloud</body></html>", {
          headers: { "Content-Type": "text/html" }
        })
    }
  } as unknown as NativeEnv;
  const html = await agentBrowserResponse(
    new Request("http://pentcloud.internal/"),
    auth,
    nativeEnv
  );
  expect(html.headers.get("Content-Security-Policy")).toContain(
    "script-src 'self';"
  );
  expect(await html.text()).toContain(
    '<script src="/__pentcloud_agent_browser.js"></script>'
  );
  const script = await agentBrowserResponse(
    new Request("http://pentcloud.internal/__pentcloud_agent_browser.js"),
    auth,
    nativeEnv
  );
  expect(script.headers.get("Content-Type")).toBe("application/javascript");
  expect(script.headers.get("Cache-Control")).toBe("no-store");
  const source = await script.text();
  expect(source).toContain("crypto.getRandomValues");
  expect(source).not.toContain(auth.assertion);
  const hashed = await agentBrowserResponse(
    new Request("http://pentcloud.internal/__pentcloud_agent_browser_digest", {
      method: "POST",
      body: "abc",
      headers: { Origin: "http://pentcloud.internal" }
    }),
    auth,
    nativeEnv
  );
  expect(hashed.status).toBe(200);
  expect(
    [...new Uint8Array(await hashed.arrayBuffer())]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  ).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const oversized = await agentBrowserResponse(
    new Request("http://pentcloud.internal/__pentcloud_agent_browser_digest", {
      method: "POST",
      body: new Uint8Array(2 * 1024 * 1024 + 1)
    }),
    auth,
    nativeEnv
  );
  expect(oversized.status).toBe(413);
  expect(
    (
      await agentBrowserResponse(
        new Request("http://pentcloud.internal/__pentcloud_agent_browser.js"),
        undefined,
        nativeEnv
      )
    ).status
  ).toBe(401);
});
