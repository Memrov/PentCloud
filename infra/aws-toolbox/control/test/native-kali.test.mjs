import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../apps/control-plane/package.json", import.meta.url));
const { build } = require("esbuild");
// Only the platform constructor/container boundary is substituted. The native
// production class and all request/lifecycle decisions execute unchanged.
const bundle = await build({
  entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true,
  write: false, platform: "node", format: "esm", target: "es2023",
  plugins: [{ name: "native-platform-boundary", setup(builder) {
    builder.onResolve({filter: /^cloudflare:workers$/}, () => ({path: "workers", namespace: "native-platform-boundary"}));
    builder.onLoad({filter: /.*/, namespace: "native-platform-boundary"}, () => ({contents: "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export class WorkerEntrypoint extends DurableObject {}"}));
  }}],
});
const { KaliToolbox } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const GENERATION = "X-Pentcloud-Toolbox-Generation";

function fixture(running = false, initial = {}) {
  const calls = {starts: [], timeouts: [], upstream: []};
  const state = {running, labels: running ? {"pentcloud-gen": "retained-generation"} : {}, readyStatus: 503, fail: false, ...initial};
  const container = {
    get running() { return state.running; }, images: {stock: "registry.test/exact-stock@sha256:pinned"},
    start(options) {
      if (state.startError) throw state.startError;
      // Native start.labels limits, verified in the live failure and public API:
      // https://developers.cloudflare.com/containers/api/durable-object-container/#start
      const labels = Object.entries(options.labels ?? {});
      if (labels.length > 10) throw new Error("Native Container accepts at most 10 labels");
      for (const [name, value] of labels) {
        if (Buffer.byteLength(name) < 1 || Buffer.byteLength(name) > 16) throw new Error("Native label names require 1 to 16 bytes");
        if (Buffer.byteLength(value) > 64) throw new Error("Native label values allow at most 64 bytes");
        if (/[\x00-\x1f\x7f]/.test(name + value)) throw new Error("Native labels cannot contain control characters");
      }
      calls.starts.push(options); state.running = true; state.labels = options.labels;
    },
    async setInactivityTimeout(ms) { calls.timeouts.push(ms); if (state.inactivityPending) await state.inactivityPending; if (state.inactivityError) throw state.inactivityError; },
    async inspect() { return state.inspect ? state.inspect() : state.running ? {labels: state.labels, image: "registry.test/exact-stock@sha256:pinned"} : null; },
    getTcpPort(port) { assert.equal(port, 8081); return {async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.upstream.push(request);
      if (state.fail) throw new Error("private-container-error-secret");
      if (request.method === "GET") return new Response(null, {status: state.readyStatus});
      if (state.pendingFetch) return state.pendingFetch;
      if (request.headers.get("x-redirect")) return new Response(null, {status: 307, headers: {location: "https://unexpected.example/"}});
      return Response.json({headers: Object.fromEntries(request.headers), body: await request.text(), url: request.url}, {status: state.mcpStatus ?? 200, headers: state.upstreamLost ? {"X-Pentcloud-Toolbox-Lost": "true"} : {}});
    }}; },
  };
  const pending = [];
  const ctx = {container, waitUntil(promise) {pending.push(promise);}, blockConcurrencyWhile(run) {return run();}};
  const env = {KALI_MCP_TOKEN: "native-mcp-token-long-enough"};
  const runtime = new KaliToolbox(ctx, env);
  const fetch = (path, generation, init = {}) => runtime.fetch(new Request(`https://toolbox.internal${path}`, {
    ...init, headers: {...init.headers, ...(generation ? {[GENERATION]: generation} : {})},
  }));
  return {calls, state, fetch, pending, ctx, env, container, runtime, ready: runtime.ready.bind(runtime), activity: runtime.activity.bind(runtime), status: runtime.status.bind(runtime)};
}

test("startup failures identify the failing boundary without logging credentials or start options", async () => {
  const cases = [
    {phase: "bearer_configuration", configure: f => {f.env.KALI_MCP_TOKEN = "short";}, errorName: "Error", starts: 0},
    {phase: "stock_image_configuration", configure: f => {delete f.container.images.stock;}, errorName: "Error", starts: 0},
    {phase: "container_start", configure: f => {f.state.startError = new TypeError(`Native start rejected ${f.env.KALI_MCP_TOKEN}\n{\"env\":\"private-start-options\"}`);}, errorName: "TypeError", starts: 0},
    {phase: "container_start", configure: f => {f.state.startError = new Error(`Native start rejected {\"env\":\"private-start-options\",\"token\":\"${f.env.KALI_MCP_TOKEN}\"}`);}, errorName: "Error", starts: 0, detail: "Native start rejected [structured detail omitted]"},
    {phase: "container_start", configure: f => {f.state.startError = new Error("x".repeat(230) + f.env.KALI_MCP_TOKEN);}, errorName: "Error", starts: 0, detail: "x".repeat(230) + "[redacted]"},
    {phase: "inactivity_timeout", configure: f => {f.state.inactivityError = new RangeError(`Invalid native timeout ${f.env.KALI_MCP_TOKEN}`);}, errorName: "RangeError", starts: 1},
  ];
  for (const scenario of cases) {
    const f = fixture(), errors = [], log = console.error;
    scenario.configure(f);
    try {
      console.error = (...values) => {errors.push(values);};
      assert.deepEqual(await f.ready(), {error: "unavailable"});
    } finally { console.error = log; }
    assert.equal(errors.length, 1);
    const [event, diagnostic] = errors[0];
    assert.equal(event, "pentcloud.toolbox.runtime_unavailable");
    assert.equal(diagnostic.phase, scenario.phase);
    assert.equal(diagnostic.errorName, scenario.errorName);
    assert.equal(diagnostic.operation, "ready");
    const serialized = JSON.stringify(errors);
    assert.ok(!serialized.includes(f.env.KALI_MCP_TOKEN));
    assert.ok(!serialized.includes("private-start-options"));
    assert.ok(!serialized.includes("entrypoint"));
    assert.ok(diagnostic.detail.length <= 240);
    if (scenario.detail) assert.equal(diagnostic.detail, scenario.detail);
    assert.equal(f.calls.starts.length, scenario.starts);
  }
});

test("health never boots; ready starts the exact stock image once with native inactivity and runtime bearer delivery", async () => {
  const {ready, status, calls} = fixture();
  assert.deepEqual(await status(), {state: "stopped", inactivityTimeoutMs: 1800000});
  assert.equal(calls.starts.length, 0);
  const value = await ready();
  assert.equal(value.state, "booting");
  assert.ok(value.generation);
  assert.equal(calls.starts.length, 1);
  const options = calls.starts[0];
  assert.equal(options.image, "registry.test/exact-stock@sha256:pinned");
  assert.deepEqual(options.instance, {vcpu: 2, memoryMib: 6144, diskMb: 20000});
  assert.equal(options.enableInternet, true);
  assert.deepEqual(calls.timeouts, [1800000]);
  assert.deepEqual(options.entrypoint.slice(0, 2), ["/bin/bash", "-c"]);
  assert.ok(options.entrypoint[2].includes("umask 077"));
  assert.ok(options.entrypoint[2].includes("exec /usr/bin/tini -g -- /opt/kali-mcp/bin/entrypoint.sh"));
  assert.ok(!options.entrypoint.join(" ").includes("native-mcp-token-long-enough"));
  assert.equal(options.env.PENTCLOUD_KALI_TOKEN, "native-mcp-token-long-enough");
  assert.equal(options.env.MCP_GATEWAY_TOKEN_FILE, "/tmp/pentcloud-mcp-token");
  assert.equal(options.env.PATH, undefined, "the stock image's OCI PATH remains authoritative");
});

test("native running is not readiness; authenticated stock MCP HTTP must respond first", async () => {
  const {ready, calls, state} = fixture();
  const first = await ready();
  assert.equal((await ready(first.generation)).state, "booting");
  state.readyStatus = 400; // Stock MCP requires a session; this is an actual HTTP response.
  assert.deepEqual(await ready(first.generation), {state: "ready", generation: first.generation});
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.upstream.at(-1).headers.get("authorization"), "Bearer native-mcp-token-long-enough");
});

test("a failed cold timeout setup is retried successfully before the existing runtime becomes ready", async () => {
  const {ready, calls, state} = fixture(false, {inactivityError: new Error("injected timeout failure"), readyStatus: 400});
  const log = console.error;
  try {
    console.error = () => {};
    assert.deepEqual(await ready(), {error: "unavailable"});
    assert.equal(calls.starts.length, 1);
    assert.equal(state.running, true);
    delete state.inactivityError;
    assert.equal((await ready()).state, "ready");
    assert.deepEqual(calls.timeouts, [1800000, 1800000], "readiness retries timeout setup instead of trusting running");
    assert.equal(calls.starts.length, 1, "timeout retry never starts a replacement runtime");
    assert.equal(calls.upstream.length, 1);
  } finally { console.error = log; }
});

test("continuing cold or constructor timeout failure blocks readiness, MCP and activity without another start", async () => {
  const log = console.error;
  try {
    console.error = () => {};
    for (const running of [false, true]) {
      const {fetch, ready, activity, calls, state, pending} = fixture(running, {inactivityError: new Error("injected timeout failure"), readyStatus: 400});
      await Promise.all(pending);
      if (!running) assert.deepEqual(await ready(), {error: "unavailable"});
      const generation = state.labels["pentcloud-gen"];
      assert.deepEqual(await ready(generation), {error: "unavailable"});
      assert.deepEqual(await activity(generation), {error: "unavailable"});
      assert.equal((await fetch("/mcp", generation, {method: "POST"})).status, 503);
      assert.equal(calls.upstream.length, 0, "no HTTP probe or mutation dispatches before timeout setup succeeds");
      assert.equal(calls.starts.length, running ? 0 : 1);
    }
  } finally { console.error = log; }
});

test("constructor timeout setup is shared with requests and reset only for a new runtime", async () => {
  let release;
  const inactivityPending = new Promise(resolve => {release = resolve;});
  const {runtime, calls, state} = fixture(true, {inactivityPending, readyStatus: 400});
  let readyFinished = false;
  const ready = runtime.ready("retained-generation").then(reply => {readyFinished = true;return reply;});
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(readyFinished, false, "readiness must await the constructor's native setup");
    assert.equal(calls.timeouts.length, 1, "concurrent setup is deduplicated");
  } finally { release(); }
  assert.equal((await ready).state, "ready");
  await runtime.activity("retained-generation");
  assert.equal(calls.timeouts.length, 1, "successful setup is cached within this runtime lifetime");
  state.running = false;
  assert.equal((await runtime.ready()).state, "booting");
  assert.equal(calls.timeouts.length, 2, "each new start must apply native inactivity again");
});

test("overlapping cold readiness requests start one shared generation", async () => {
  const {ready, calls} = fixture();
  const results = await Promise.all(Array.from({length: 12}, () => ready()));
  assert.equal(calls.starts.length, 1);
  assert.equal(new Set(results.map(value => value.generation)).size, 1);
  assert.ok(results.every(value => value.state === "booting"));
});

test("pinned readiness, MCP and activity never boot or adopt a replacement generation", async () => {
  const {fetch, ready, activity, calls, state} = fixture();
  assert.deepEqual(await ready("old-generation"), {error: "generation_lost"});
  assert.deepEqual(await activity("old-generation"), {error: "generation_lost"});
  assert.equal((await fetch("/mcp", "old-generation", {method: "POST"})).status, 409);
  assert.deepEqual(await ready(""), {error: "generation_lost"}, "an empty pin is not permission to boot");
  assert.equal(calls.starts.length, 0);
  const first = await ready();
  state.running = false;
  assert.deepEqual(await ready(first.generation), {error: "generation_lost"});
  assert.equal(calls.starts.length, 1);
  const second = await ready();
  assert.notEqual(first.generation, second.generation);
  assert.equal((await fetch("/mcp", first.generation, {method: "POST"})).status, 409);
  assert.equal(calls.upstream.length, 0, "a stale mutation never reaches the replacement server");
});

test("stock HTTP conflicts retain their matching generation without impersonating native runtime loss", async () => {
  const {fetch, state} = fixture(true);
  state.mcpStatus = 409;
  state.upstreamLost = true;
  const response = await fetch("/mcp", "retained-generation", {method: "POST", body: "conflicting-request"});
  assert.equal(response.status, 409);
  assert.equal(response.headers.get(GENERATION), "retained-generation");
  assert.equal(response.headers.get("X-Pentcloud-Toolbox-Lost"), null);
});

test("DO recreation restores only the finite native timeout and retains the running generation", async () => {
  const {status, activity, calls, pending, state} = fixture(true);
  await Promise.all(pending);
  assert.deepEqual(calls.timeouts, [1800000]);
  const health = await status();
  assert.equal(health.generation, "retained-generation");
  assert.equal(calls.starts.length, 0);
  assert.deepEqual(await activity("retained-generation"), {state: "running", generation: "retained-generation"});
  assert.equal(calls.starts.length, 0);
  assert.deepEqual(calls.timeouts, [1800000], "read/status/activity requests rely on native activity, not a renewal timer");
  state.running = false;
  assert.deepEqual(await activity("retained-generation"), {error: "generation_lost"});
});

test("MCP forwards once with sanitized authentication, preserves redirects and never retries a failed mutation", async () => {
  const {fetch, calls, state} = fixture(true);
  const response = await fetch("/mcp?codemode=false", "retained-generation", {method: "POST", body: "unchanged-body", headers: {
    authorization: "Bearer operator-token", cookie: "private-cookie", "cf-access-client-secret": "access-token", "mcp-session-id": "same-session", "mcp-protocol-version": "2025-03-26",
  }});
  const forwarded = await response.json();
  assert.equal(forwarded.url, "http://kali.internal/mcp?codemode=false");
  assert.equal(forwarded.headers.authorization, "Bearer native-mcp-token-long-enough");
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers["cf-access-client-secret"], undefined);
  assert.equal(forwarded.headers["mcp-session-id"], "same-session");
  assert.equal(forwarded.body, "unchanged-body");
  assert.equal(response.headers.get(GENERATION), "retained-generation");
  assert.equal((await fetch("/mcp", "retained-generation", {method: "POST", headers: {"x-redirect": "1"}})).status, 307);
  state.fail = true;
  const before = calls.upstream.length;
  const errors = [], log = console.error;
  let failed;
  try {
    console.error = (...values) => { errors.push(values); };
    failed = await fetch("/mcp", "retained-generation", {method: "POST", body: "mutation"});
  } finally { console.error = log; }
  assert.deepEqual(errors, [["pentcloud.toolbox.runtime_unavailable", {operation: "/mcp"}]]);
  assert.equal(failed.status, 503);
  assert.equal(calls.upstream.length, before + 1);
  assert.ok(!(await failed.text()).includes("private-container-error-secret"));
  assert.equal(calls.starts.length, 0);
});

test("a replacement start cannot interleave old-generation inspection and MCP dispatch", async () => {
  const {fetch, ready, calls, state} = fixture(true);
  let release, entered;
  const held = new Promise(resolve => {release = resolve;});
  const inspecting = new Promise(resolve => {entered = resolve;});
  state.inspect = async () => { entered(); await held; return {labels: {"pentcloud-gen": "retained-generation"}, image: "stock"}; };
  const old = fetch("/mcp", "retained-generation", {method: "POST", body: "old-mutation"});
  await inspecting;
  state.running = false;
  const replacement = ready();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.starts.length, 0, "native lifecycle start waits for the inspection/dispatch boundary");
  release();
  assert.equal((await old).status, 409);
  assert.equal((await replacement).state, "booting");
  assert.equal(calls.upstream.length, 0);
});

test("an in-flight MCP response never holds the lifecycle gate or buffers the stream", async () => {
  const {fetch, status, activity, calls, state} = fixture(true);
  let release;
  state.pendingFetch = new Promise(resolve => {release = resolve;});
  const mcp = fetch("/mcp", "retained-generation", {method: "POST", body: "mutation"});
  while (!calls.upstream.length) await new Promise(resolve => setTimeout(resolve, 0));
  const health = await Promise.race([status(), new Promise((_, reject) => setTimeout(() => reject(new Error("MCP response held lifecycle gate")), 100))]);
  assert.equal(health.state, "running");
  assert.deepEqual(await activity("retained-generation"), {state: "running", generation: "retained-generation"});
  release(new Response("stream-result", {headers: {"mcp-session-id": "same-session"}}));
  assert.equal((await mcp).headers.get("mcp-session-id"), "same-session");
});

// These domain calls must exercise the production methods, with no lifecycle HTTP adapter.
test("typed lifecycle RPC starts only unpinned readiness and fences stale activity", async () => {
  const {runtime, calls, state} = fixture();
  assert.deepEqual(await runtime.status(), {state: "stopped", inactivityTimeoutMs: 1800000});
  assert.deepEqual(await runtime.ready("lost-generation"), {error: "generation_lost"});
  assert.deepEqual(await runtime.activity("lost-generation"), {error: "generation_lost"});
  assert.equal(calls.starts.length, 0);
  const first = await runtime.ready();
  assert.equal(first.state, "booting");
  assert.equal(calls.starts.length, 1);
  assert.deepEqual(await runtime.ready("stale-generation"), {error: "generation_lost", generation: first.generation});
  assert.deepEqual(await runtime.activity(first.generation), {state: "running", generation: first.generation});
  state.readyStatus = 400;
  assert.deepEqual(await runtime.ready(first.generation), {state: "ready", generation: first.generation});
  state.running = false;
  assert.deepEqual(await runtime.ready(first.generation), {error: "generation_lost"});
  assert.equal(calls.starts.length, 1);
});

test("explicit scratch clear destroys a running instance without starting one and is idempotent",async()=>{
 const f=fixture(true);let destroyed=0;
 f.container.destroy=async()=>{destroyed++;f.state.running=false;};
 assert.deepEqual(await f.runtime.clear(),{state:'stopped'});
 assert.deepEqual(await f.runtime.clear(),{state:'stopped'});
 assert.equal(destroyed,1);assert.equal(f.calls.starts.length,0);
 const stopped=fixture(false);stopped.container.destroy=async()=>assert.fail('stopped runtime must not be touched');
 assert.deepEqual(await stopped.runtime.clear(),{state:'stopped'});assert.equal(stopped.calls.starts.length,0);
});
test("scratch clear failure never reports success or starts a replacement",async()=>{
 const f=fixture(true);f.container.destroy=async()=>{throw Error('fixture destroy unavailable')};
 assert.deepEqual(await f.runtime.clear(),{error:'unavailable'});assert.equal(f.calls.starts.length,0);assert.equal(f.state.running,true);
});
