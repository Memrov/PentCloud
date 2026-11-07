/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessKeys, accessToken, accessHeaders } from "./access-fixture";
import type { RecordedCall, RuntimeFixtureEnv } from "./router-fixture";

const bindings = env as unknown as RuntimeFixtureEnv;
const app = exports as unknown as { default: Fetcher };
const coordinator = () => bindings.COORDINATOR.getByName("global");
const authorized = async (path: string, init: RequestInit = {}) => {
  const headers = await accessHeaders(init.headers);
  return app.default.fetch(
    new Request(`https://operator.test${path}`, { ...init, headers }),
  );
};
const recordedCalls = async (): Promise<RecordedCall[]> =>
  JSON.parse(await coordinator().calls()) as RecordedCall[];
const jsonBody = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

beforeEach(async () => {
  accessKeys();
  await coordinator().clearCalls();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("production router in actual Workers runtime", () => {
  it("authenticates lifecycle actions and fences purged sessions before attempt RPC",async()=>{
    expect((await app.default.fetch("https://operator.test/v1/ui/runs/run-1",{method:"DELETE"})).status).toBe(401);
    for(const action of ["archive","trash","restore"])expect((await authorized(`/v1/ui/runs/run-1/${action}`,jsonBody({}))).status).toBe(200);
    expect((await authorized("/v1/ui/runs/run-1",{...jsonBody({confirm:"wrong"}),method:"DELETE"})).status).toBe(400);
    expect(await (await authorized("/v1/ui/runs/run-1",{...jsonBody({confirm:"run-1"}),method:"DELETE"})).json()).toEqual({runId:"run-1",deleted:true});
    expect(await (await authorized("/v1/ui/runs/run-1/report?job=reporter")).text()).toBe("# Accepted report");
    expect((await authorized("/v1/ui/lifecycle")).status).toBe(200);
    expect((await authorized("/v1/ui/lifecycle/prepare-uninstall",jsonBody({}))).status).toBe(200);
    for(const action of ["events","inspect","session-controls"])expect((await authorized(`/v1/ui/jobs/purged/${action}`)).status).toBe(409);
    expect((await authorized("/v1/ui/runs?view=other")).status).toBe(400);
    const calls=await recordedCalls();expect(calls).toContainEqual({method:"report",args:["run-1","reporter"]});
    expect(calls.filter(call=>["events","inspect","sessionControls"].includes(call.method))).toEqual([]);
  });
  it("creates hosted browser views only through authenticated operator POST and prevents caching/referrers", async () => {
    const path = "/v1/ui/jobs/job-1/browser-live-view";
    expect((await app.default.fetch(`https://operator.test${path}`, {method: "POST"})).status).toBe(401);
    expect((await app.default.fetch(`https://operator.test${path}`, {method: "POST", headers: {"Cf-Access-Jwt-Assertion": "invalid"}})).status).toBe(403);
    expect((await authorized(path)).status).toBe(404);
    expect(await recordedCalls()).toEqual([]);
    const response = await authorized(path, {method: "POST"});
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.json()).toMatchObject({available: true, readOnly: true, url: expect.stringContaining("https://live.browser.run/")});
    expect(await recordedCalls()).toEqual([{method: "browserLiveView", args: []}]);
  });
  it("authenticates runtime diagnostics and rejects malformed recovery before RPC", async () => {
    expect((await app.default.fetch("https://operator.test/v1/ui/runtime-diagnostics")).status).toBe(401);
    expect((await authorized("/v1/ui/runtime-diagnostics")).status).toBe(200);
    for (const value of [{scope:"other", observedAt:1}, {scope:"coordinator", observedAt:-1},
      {scope:"attempt", observedAt:1}, {scope:"attempt", observedAt:1, attemptId:"../escape"},
      {scope:"coordinator", observedAt:1, unknown:true}]) {
      expect((await authorized("/v1/ui/runtime-recovery", jsonBody(value))).status).toBe(400);
    }
    expect(await recordedCalls()).toEqual([{method:"diagnostics",args:[]}]);
    expect((await authorized("/v1/ui/runtime-recovery", jsonBody({scope:"attempt",observedAt:1,attemptId:"job-1"}))).status).toBe(200);
    expect((await authorized("/v1/ui/runtime-recovery", jsonBody({scope:"coordinator",observedAt:999}))).status).toBe(409);
    expect(await recordedCalls()).toContainEqual({method:"rearmPlatformRecovery",args:[{scope:"attempt",observedAt:1,attemptId:"job-1"}]});
  });
  it("authenticates narrow native controls and preserves exact reply identity", async () => {
    const root = "/v1/ui/jobs/job-1";
    expect((await app.default.fetch(`https://operator.test${root}/session-controls`)).status).toBe(401);
    expect(await recordedCalls()).toEqual([]);
    const controls = await authorized(`${root}/session-controls`);
    expect(controls.status).toBe(200);
    expect(controls.headers.get("Cache-Control")).toBe("no-store");
    expect(await controls.json()).toMatchObject({session: "ses_root", usage: {stats: {steps: 2}}});
    const answer = {session: "ses_root", answer: {continue: true}};
    expect((await authorized(`${root}/forms/frm_exact/reply`, jsonBody(answer))).status).toBe(200);
    expect((await authorized(`${root}/permissions/per_exact/reply`, jsonBody({session: "ses_root", decision: "once"}))).status).toBe(200);
    expect((await authorized(`${root}/forms/frm_exact/cancel`, jsonBody({session: "ses_root"}))).status).toBe(200);
    expect((await authorized(`${root}/forms/frm_stale/reply`, jsonBody(answer))).status).toBe(409);
    const before = await recordedCalls();
    expect(before).toContainEqual({method: "replyNative", args: ["form", "frm_exact", answer, false]});
    for (const path of ["opencode/config", "permissions/per_exact/cancel", "forms/frm_exact/create"])
      expect((await authorized(`${root}/${path}`, jsonBody({}))).status).toBe(404);
    expect(await recordedCalls()).toEqual(before);
  });
  it("serves health without auth and rejects unauthenticated API and Agent routes before RPC", async () => {
    const health = await app.default.fetch("https://operator.test/health");
    expect(await health.json()).toMatchObject({
      runtime: "Cloudflare OpenCode V2",
      concurrency: 1,
      maxOutstanding: 3,
      timeoutSeconds: null,
      goConfigured: true,
    });
    for (const path of [
      "/v1/runs",
      "/v1/ui/runs",
      "/agents/coordinator/global",
    ]) {
      const response = await app.default.fetch(`https://operator.test${path}`);
      expect(response.status).toBe(401);
    }
    const invalid = await app.default.fetch("https://operator.test/v1/runs", {
      headers: { Authorization: "Bearer invalid" },
    });
    expect(invalid.status).toBe(401);
    expect(await recordedCalls()).toEqual([]);
  });

  it("keeps toolbox diagnostics behind Access and invokes only narrow lifecycle RPC",async()=>{
    expect((await app.default.fetch("https://operator.test/v1/toolbox/status")).status).toBe(401);
    expect(await recordedCalls()).toEqual([]);
    const status=await authorized("/v1/toolbox/status");expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({state:"stopped",running:false});
    expect((await authorized("/v1/toolbox/start",{method:"POST",headers:{"X-Pentcloud-Toolbox-Generation":"lost"}})).status).toBe(409);
    expect((await authorized("/v1/toolbox/start",{method:"POST"})).status).toBe(202);
    expect(await recordedCalls()).toEqual([{method:"toolboxStatus",args:[]},{method:"toolboxReady",args:["lost"]},{method:"toolboxReady",args:[null]}]);
  });
  it("reports an uninstalled toolbox without crashing or starting Kali in a package-only install",async()=>{
    for(const [path,method] of [["/v1/toolbox/status","GET"],["/v1/ui/toolbox/start","POST"]] as const){
      const response=await authorized(path,{method,headers:{"X-Fixture-Tool-Backend":"tool-packs"}});
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({state:"not-installed",runtime:"Cloudflare tool packs"});
    }
    expect(await recordedCalls()).toEqual([]);
  });
  it("rejects old operator bearers, expired identity and cross-origin mutations before RPC", async()=>{
    expect((await app.default.fetch("https://operator.test/v1/runs",{headers:{Authorization:`Bearer ${bindings.CONTROL_TOKEN}`}})).status).toBe(401);
    expect((await app.default.fetch("https://operator.test/v1/runs",{headers:{"Cf-Access-Jwt-Assertion":await accessToken(undefined,undefined,undefined,1)}})).status).toBe(403);
    expect((await app.default.fetch("https://operator.test/v1/runs",{headers:{"Cf-Access-Jwt-Assertion":await accessToken(undefined,undefined,undefined,null)}})).status).toBe(403);
    for(const headers of [{Origin:"https://other.example"},{"Sec-Fetch-Site":"cross-site"}])
      expect((await authorized("/v1/settings",{method:"PUT",headers,body:"{}"})).status).toBe(403);
    expect(await recordedCalls()).toEqual([]);
  });
  it("verifies Access signatures, issuer and audience before authenticated settings mutation", async () => {
    const token = (issuer: string, audience: string) => accessToken(issuer,audience,"access-operator@example.com");
    for (const [issuer, audience] of [
      ["https://wrong.invalid", "runtime-test-audience"],
      ["https://access.invalid", "wrong-audience"],
    ]) {
      const denied = await app.default.fetch(
        "https://operator.test/v1/settings",
        {
          method: "PUT",
          headers: {
            "Cf-Access-Jwt-Assertion": await token(issuer!, audience!),
            "If-Match": "3",
          },
          body: JSON.stringify({ roles: {} }),
        },
      );
      expect(denied.status).toBe(403);
    }
    expect(await recordedCalls()).toEqual([]);
    const validToken = await token(
      "https://access.invalid",
      "runtime-test-audience",
    );
    const [header, payload, signature] = validToken.split(".");
    const tampered = `${header}.${payload}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
    expect(
      (
        await app.default.fetch("https://operator.test/v1/settings", {
          method: "PUT",
          headers: { "Cf-Access-Jwt-Assertion": tampered, "If-Match": "3" },
          body: JSON.stringify({ roles: {} }),
        })
      ).status,
    ).toBe(403);
    const accepted = await app.default.fetch(
      "https://operator.test/v1/settings",
      {
        method: "PUT",
        headers: {
          "Cf-Access-Jwt-Assertion": await token(
            "https://access.invalid",
            "runtime-test-audience",
          ),
          "If-Match": "3",
        },
        body: JSON.stringify({ roles: {} }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(await recordedCalls()).toEqual([
      { method: "saveSettings", args: [{}, 3, "access-operator@example.com"] },
    ]);

  });

  it("returns safe HTTP errors for absent native/history sessions and asynchronous Agent failures", async () => {
    const missing = await authorized("/v1/ui/jobs/missing/events");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: expect.stringContaining("404:"),
    });
    const run = await authorized("/v1/ui/runs/missing/jobs");
    expect(run.status).toBe(404);
    const failed = await authorized("/agents/coordinator/global?fixture-error");
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(bindings.CONTROL_TOKEN);
  });

  it("rejects non-string operator messages and revision identities without coercing task intent", async () => {
    const invalid = [
      ["/v1/jobs/job-1/steer", { message: { nested: "instruction" } }],
      ["/v1/jobs/job-1/steer", { message: 123 }],
      ["/v1/jobs/job-1/revisions", { instructions: {}, request_id: "request" }],
      ["/v1/jobs/job-1/revisions", { instructions: "Review", request_id: {} }],
    ] as const;
    for (const [path, body] of invalid)
      expect((await authorized(path, jsonBody(body))).status).toBe(400);
    expect(await recordedCalls()).toEqual([]);
  });

  it("authenticates remote operator routes, forwards exact inspection identity, and wakes only after verified reconciliation", async () => {
    for (const path of [
      "/v1/jobs/job-1/remote-receipts",
      "/v1/jobs/job-1/remote-inspect",
      "/v1/jobs/job-1/remote-receipts/call-1.0/reconcile",
    ]) {
      expect(
        (await app.default.fetch(`https://operator.test${path}`)).status,
      ).toBe(401);
    }
    expect(await recordedCalls()).toEqual([]);
    expect(
      await (await authorized("/v1/ui/jobs/job-1/remote-receipts")).json(),
    ).toEqual([{ id: "call-1.0", tool: "nmap_scan", state: "unknown" }]);
    expect(
      (
        await authorized(
          "/v1/jobs/job-1/remote-inspect",
          jsonBody({
            tool: "nmap_get_scan_results",
            args: { scan_id: "scan-1" },
          }),
        )
      ).status,
    ).toBe(200);
    const proof = { inspectionTool: "nmap_get_scan_results", scanId: "scan-1" };
    const reconciled = await authorized(
      "/v1/ui/jobs/job-1/remote-receipts/%63all-1.0/reconcile",
      jsonBody(proof),
    );
    expect(await reconciled.json()).toEqual({
      reconciled: true,
      receiptId: "call-1.0",
    });
    expect(await recordedCalls()).toEqual([
      { method: "remoteReceipts", args: [] },
      {
        method: "inspectRemote",
        args: ["nmap_get_scan_results", { scan_id: "scan-1" }],
      },
      { method: "reconcileRemote", args: ["call-1.0", proof] },
      { method: "reconcileToolOutcome", args: ["job-1"] },
    ]);
  });

  it("rejects invalid remote bodies and never wakes Coordinator for denied or unresolved proof", async () => {
    for (const [path, payload] of [
      [
        "/v1/jobs/job-1/remote-inspect",
        { tool: "nmap_get_scan_results", args: [] },
      ],
      ["/v1/jobs/job-1/remote-inspect", { tool: {}, args: {} }],
      [
        "/v1/jobs/job-1/remote-receipts/call-1.0/reconcile",
        { inspectionTool: {}, scanId: "scan" },
      ],
      [
        "/v1/jobs/job-1/remote-receipts/call%252F1/reconcile",
        { inspectionTool: "nmap_get_scan_results", scanId: "scan" },
      ],
    ] as const)
      expect((await authorized(path, jsonBody(payload))).status).toBe(400);
    expect(await recordedCalls()).toEqual([]);
    expect(
      (
        await authorized(
          "/v1/jobs/job-1/remote-inspect",
          jsonBody({ tool: "forbidden", args: {} }),
        )
      ).status,
    ).toBe(403);
    for (const scanId of ["mismatch", "unknown"])
      expect(
        (
          await authorized(
            "/v1/jobs/job-1/remote-receipts/call-1.0/reconcile",
            jsonBody({ inspectionTool: "nmap_get_scan_results", scanId }),
          )
        ).status,
      ).toBe(409);
    expect(
      (await recordedCalls()).some(
        (call) => call.method === "reconcileToolOutcome",
      ),
    ).toBe(false);
  });

  it("authenticates owned remote control and wakes only after the Attempt verifies success", async () => {
    const payload = {
      tool: "msf_stop_job",
      args: { job_id: "owned-job" },
      request_id: "operator-stop-1",
    };
    const denied = await app.default.fetch(
      "https://operator.test/v1/jobs/job-1/remote-control",
      jsonBody(payload),
    );
    expect(denied.status).toBe(401);
    expect(await recordedCalls()).toEqual([]);
    for (const prefix of ["/v1", "/v1/ui"]) {
      const response = await authorized(
        `${prefix}/jobs/job-1/remote-control`,
        jsonBody(payload),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        controlled: true,
        verified: true,
        settled: true,
        receiptIds: ["call-owned"],
      });
    }
    expect(await recordedCalls()).toEqual([
      {
        method: "controlRemote",
        args: [payload.tool, payload.args, payload.request_id],
      },
      { method: "reconcileToolOutcome", args: ["job-1"] },
      {
        method: "controlRemote",
        args: [payload.tool, payload.args, payload.request_id],
      },
      { method: "reconcileToolOutcome", args: ["job-1"] },
    ]);
  });

  it("rejects malformed or unowned remote control without waking the global slot", async () => {
    for (const payload of [
      { tool: {}, args: {}, request_id: "operator-stop-1" },
      { tool: "msf_stop_job", args: [], request_id: "operator-stop-1" },
      { tool: "msf_stop_job", args: null, request_id: "operator-stop-1" },
      { tool: "msf_stop_job", args: {}, request_id: {} },
      { tool: "msf_stop_job", args: {}, request_id: "" },
    ])
      expect(
        (await authorized("/v1/jobs/job-1/remote-control", jsonBody(payload)))
          .status,
      ).toBe(400);
    expect(await recordedCalls()).toEqual([]);
    expect(
      (
        await authorized(
          "/v1/jobs/job-1/remote-control",
          jsonBody({
            tool: "msf_stop_job",
            args: { job_id: "unowned" },
            request_id: "reject-unowned",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await authorized(
          "/v1/jobs/job-1/remote-control",
          jsonBody({
            tool: "msf_stop_job",
            args: { job_id: "invalid-result" },
            request_id: "reject-invalid-result",
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await recordedCalls()).some(
        (call) => call.method === "reconcileToolOutcome",
      ),
    ).toBe(false);
    expect((await authorized("/v1/jobs/job-1/remote-control")).status).toBe(
      404,
    );
  });

  it("returns accepted pending control without waking, while verified control can retain other held resources", async () => {
    const pending = await authorized(
      "/v1/jobs/job-1/remote-control",
      jsonBody({
        tool: "msf_stop_job",
        args: { job_id: "pending" },
        request_id: "pending-stop",
      }),
    );
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({
      controlled: true,
      verified: false,
      settled: false,
    });
    expect(
      (await recordedCalls()).some(
        (call) => call.method === "reconcileToolOutcome",
      ),
    ).toBe(false);
    const verified = await authorized(
      "/v1/jobs/job-1/remote-control",
      jsonBody({
        tool: "msf_stop_job",
        args: { job_id: "other-held" },
        request_id: "verified-stop",
      }),
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      controlled: true,
      verified: true,
      settled: false,
    });
    expect(
      (await recordedCalls()).filter(
        (call) => call.method === "reconcileToolOutcome",
      ),
    ).toEqual([{ method: "reconcileToolOutcome", args: ["job-1"] }]);
  });

  it("routes both API prefixes over typed Durable Object RPC and persists the real SQL call journal across eviction", async () => {
    for (const prefix of ["/v1", "/v1/ui"]) {
      const list = await authorized(`${prefix}/runs`);
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ runs: [{ id: "run-1" }] });
      const jobs = await authorized(`${prefix}/runs/run-1/jobs`);
      expect(await jobs.json()).toMatchObject({
        jobs: [{ id: "job-1", runId: "run-1" }],
      });
    }
    expect((await recordedCalls()).map((call) => call.method)).toEqual([
      "listRuns",
      "getRun",
      "listRuns",
      "getRun",
    ]);
    const stub = bindings.COORDINATOR.getByName("eviction-proof");
    await stub.clearCalls();
    await stub.listRuns();
    const before = await stub.calls();
    await evictDurableObject(stub);
    expect(await stub.calls()).toEqual(before);
  });

  it("forwards run creation, queue, cancellation, steering, revision identity and interruption", async () => {
    expect(
      (
        await authorized(
          "/v1/ui/runs",
          jsonBody({
            run_id: "operator-run",
            task: "Inspect",
            launch_time: "2026-10-31T00:00:00Z",
          }),
        )
      ).status,
    ).toBe(202);
    expect((await authorized("/v1/queue")).status).toBe(200);
    expect(
      (await authorized("/v1/ui/runs/run-1/cancel", { method: "POST" })).status,
    ).toBe(200);
    expect(
      (
        await authorized(
          "/v1/ui/jobs/job-1/steer",
          jsonBody({ message: "Continue" }),
        )
      ).status,
    ).toBe(200);
    const revision = await authorized(
      "/v1/ui/jobs/job-1/revisions",
      jsonBody({ instructions: "Review again", request_id: "stable-request" }),
    );
    expect(revision.status).toBe(202);
    expect(await revision.json()).toMatchObject({
      job: { id: "job-revision", revisionOf: "job-1" },
    });
    expect(
      (await authorized("/v1/jobs/job-1/interrupt", { method: "POST" })).status,
    ).toBe(200);
    expect(await recordedCalls()).toEqual([
      {
        method: "createRun",
        args: [
          {
            actor:"operator",
            run_id: "operator-run",
            task: "Inspect",
            launch_time: "2026-10-31T00:00:00Z",
          },
        ],
      },
      { method: "queueSnapshot", args: [] },
      { method: "cancelRun", args: ["run-1"] },
      { method: "steer", args: ["job-1", "Continue"] },
      { method: "revise", args: ["job-1", "Review again", "stable-request"] },
      { method: "interrupt", args: ["job-1"] },
    ]);
  });

  it("validates If-Match before settings RPC and preserves domain revision conflicts", async () => {
    for (const revision of [
      undefined,
      "",
      " ",
      "no-revision",
      "-1",
      "1.5",
      "1e1",
      "0x3",
    ]) {
      const response = await authorized("/v1/ui/settings", {
        method: "PUT",
        headers: revision === undefined ? {} : { "If-Match": revision },
        body: JSON.stringify({ roles: {} }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("If-Match"),
      });
    }
    expect(await recordedCalls()).toEqual([]);
    const response = await authorized("/v1/ui/settings", {
      method: "PUT",
      headers: { "If-Match": "3" },
      body: JSON.stringify({ roles: { primary: { model: "fixture" } } }),
    });
    expect(response.status).toBe(200);
    expect(await recordedCalls()).toEqual([
      {
        method: "saveSettings",
        args: [{ primary: { model: "fixture" } }, 3, "operator"],
      },
    ]);
    const conflict = await authorized("/v1/settings", {
      method: "PUT",
      headers: { "If-Match": "999" },
      body: JSON.stringify({ roles: {} }),
    });
    expect(conflict.status).toBe(409);
    const revisionConflict = await authorized(
      "/v1/ui/jobs/job-1/revisions",
      jsonBody({ instructions: "Review", request_id: "conflict" }),
    );
    expect(revisionConflict.status).toBe(409);
  });

  it("rejects malformed JSON and over-limit streamed bodies before invoking the service", async () => {
    for (const body of ["{", "null", "[]", '"text"'])
      expect(
        (await authorized("/v1/runs", { method: "POST", body })).status,
      ).toBe(400);
    const chunk = new Uint8Array(256 * 1024).fill(32);
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (count++ < 10) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const response = await authorized("/v1/ui/runs", {
      method: "POST",
      body: stream,
    });
    expect(response.status).toBe(413);
    expect(await recordedCalls()).toEqual([]);
  });

  it("keeps activity and session replay while serving run summaries through readonly State", async () => {
    const removed = await authorized("/v1/ui/runs/run-1/events?cursor=4", {
      headers: { "Last-Event-ID": "4" },
    });
    expect(removed.status).toBe(404);
    const activity = await authorized("/v1/runs/run-1/workflow-events", {
      headers: { "Last-Event-ID": "3" },
    });
    expect(await activity.text()).toContain("event: activity");
    expect(await recordedCalls()).toEqual([
      {
        method: "stream",
        args: [
          "run-1",
          "https://operator.test/v1/runs/run-1/workflow-events",
          "3",
        ],
      },
    ]);
    const session = await authorized("/v1/ui/jobs/job-1/events?cursor=7", {
      headers: { "Last-Event-ID": "7" },
    });
    expect(session.headers.get("X-Fixture-Cursor")).toBe("7");
    expect(session.headers.get("X-Fixture-Url")).toBe(
      "https://operator.test/v1/ui/jobs/job-1/events?cursor=7",
    );
    expect(await session.text()).toContain("event: session");
    expect(
      await (await authorized("/v1/jobs/job-1/inspect")).json(),
    ).toMatchObject({ sessionId: "ses_fixture" });
  });

  it("routes only the supported native Agent endpoint and exposes settings/catalog", async () => {
    const agent = await authorized("/agents/coordinator/global", {
      headers: { Upgrade: "websocket" },
    });
    expect(await agent.json()).toMatchObject({
      routed: "coordinator",
      pathname: "/agents/coordinator/global",
    });
    expect(await (await authorized("/v1/ui/settings")).json()).toMatchObject({
      casRevision: 3,
    });
    expect(
      await (await authorized("/v1/ui/settings/models")).json(),
    ).toMatchObject({
      models: [
        { id: "opencode-go:deepseek-v4-pro", reasoningEfforts: ["default"] },
      ],
      stale: false,
    });
    for (const path of [
      "/v1/unknown",
      "/v1/ui/jobs/bad%2Fid/events",
      "/agents/specialist-chat/job-1",
    ])
      expect((await authorized(path)).status).toBe(404);
    expect((await authorized("/v1/ui/runs", { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("preserves service status codes and redacts configured secrets from errors", async () => {
    const conflict = await authorized("/v1/runs/error/jobs");
    expect(conflict.status).toBe(409);
    const text = await conflict.text();
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(bindings.CONTROL_TOKEN);
    expect(text).not.toContain(bindings.OPENCODE_GO_API_KEY);
    expect((await authorized("/v1/runs/unavailable/jobs")).status).toBe(503);
  });
});
