import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf;
let gateway;
let publicWorker;
let upstream;
before(async () => {
  // Pinned Wrangler's bundled workerd supports dates through 2026-10-19.
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "caller", modules: true, compatibilityDate: "2026-10-19",
      script: `export default {async fetch(request, env) {
        const url=new URL(request.url);
        if(url.pathname.startsWith("/rpc/")) {
          const expected=url.searchParams.has("generation")?url.searchParams.get("generation"):undefined;
          return Response.json(await env.TOOLBOX[url.pathname.slice(5)](expected));
        }
        return env.TOOLBOX.fetch(request);
      }}`,
      serviceBindings: { TOOLBOX: { name: "toolbox", entrypoint: "ToolboxGateway" } },
    }, {
      name: "toolbox", modules: true, compatibilityDate: "2026-10-19", compatibilityFlags: ["nodejs_compat","enable_ctx_exports"],
      modules: [{type: "ESModule", path: new URL("../dist/fixture.mjs", import.meta.url).pathname, contents: `
        import worker, {KaliToolbox} from './worker.js';
        export default {async fetch(request, env, ctx) {
          if(new URL(request.url).pathname === '/fixture') return Response.json(await env.KALI_TOOLBOX.getByName('shared').fixture(await request.json()));
          return worker.fetch(request,env,ctx);
        }};
        export {ToolboxGateway,KaliOutbound} from './worker.js';
        export class FixtureKali extends KaliToolbox {
          fixtureState = {running:true,generation:'fixture-generation',starts:0,timeouts:[],failTimeout:false};
          async fixture(options) {Object.assign(this.fixtureState,options);return this.fixtureState;}
          get container() { const target=this.env.KALI, state=this.fixtureState; return {
            interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},
            get running(){return state.running;}, images:{stock:'exact-stock-fixture'},
            inspect:async()=>state.running?{labels:{'pentcloud-gen':state.generation},image:'exact-stock-fixture'}:null,
            getTcpPort:port=>{if(port!==8081)throw Error('wrong port');return target;},
            start:options=>{state.starts++;state.running=true;state.generation=options.labels['pentcloud-gen'];},
            setInactivityTimeout:async ms=>{state.timeouts.push(ms);if(state.failTimeout)throw Error('fixture native timeout unavailable');},
          }; }
        }
      `}, {type: "ESModule", path: new URL("../dist/worker.js", import.meta.url).pathname, contents: await readFile(new URL("../dist/worker.js", import.meta.url), "utf8")}],
      bindings: { CONTROL_TOKEN: "operator-fixture", KALI_MCP_TOKEN: "mcp-fixture-long-enough" },
      serviceBindings: { KALI: "kali" },
      durableObjects: {KALI_TOOLBOX: {className: "FixtureKali", useSQLite: true}},
    }, {
      name: "kali", modules: true, compatibilityDate: "2026-10-19",
      script: `let waiting=false;export default {async fetch(request) {
        const path=new URL(request.url).pathname;
        if(path==='/fixture/state')return Response.json({waiting});
        if(request.headers.get('x-held')){waiting=true;await new Promise(resolve=>setTimeout(resolve,1000));waiting=false;}
        if (request.method === "GET") {let timer;return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("data: first\\n\\n"));
            timer=setTimeout(() => { controller.enqueue(new TextEncoder().encode("data: second\\n\\n")); controller.close(); }, 150); },
          cancel(){clearTimeout(timer);}
        }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "session-fixture" } });}
        if (request.headers.get("x-redirect")) return new Response(null, { status: 307, headers: { location: "https://unexpected.example/" } });
        return Response.json({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
      }}`,
    }],
  }));
  gateway = await mf.getWorker("caller");
  publicWorker = await mf.getWorker("toolbox");
  upstream = await mf.getWorker("kali");
});
after(async () => { await mf?.dispose(); });

test("private named entrypoint injects bearer, drops operator credentials and preserves MCP request", async () => {
  const response = await gateway.fetch("https://toolbox.internal/mcp", {
    method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    headers: { authorization: "Bearer caller-token", cookie: "credential=fixture", "cf-access-client-secret": "access-fixture", "mcp-session-id": "session-fixture", "mcp-protocol-version": "2025-03-26", "content-type": "application/json", "X-Pentcloud-Toolbox-Generation": "fixture-generation" },
  });
  const forwarded = await response.json();
  assert.equal(forwarded.url, "http://kali.internal/mcp");
  assert.equal(forwarded.headers.authorization, "Bearer mcp-fixture-long-enough");
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers["cf-access-client-secret"], undefined);
  assert.equal(forwarded.headers["mcp-session-id"], "session-fixture");
  assert.equal(forwarded.headers["mcp-protocol-version"], "2025-03-26");
  assert.equal(JSON.parse(forwarded.body).method, "tools/list");
});

test("private capability cannot invoke AWS controls or arbitrary URLs, methods, paths or queries", async () => {
  for (const url of ["https://outside.example/mcp", "http://toolbox.internal/mcp", "https://toolbox.internal/host/restart", "https://toolbox.internal/toolbox/start", "https://toolbox.internal/mcp/", "https://toolbox.internal/mcp?url=https://outside.example", "https://toolbox.internal/mcp?codemode=true"]) {
    assert.equal((await gateway.fetch(url, { method: "POST" })).status, 404, url);
  }
  assert.equal((await gateway.fetch("https://toolbox.internal/mcp", { method: "PUT" })).status, 405);
  assert.equal((await gateway.fetch("https://toolbox.internal/mcp?codemode=false", { method: "DELETE", headers: {"X-Pentcloud-Toolbox-Generation": "fixture-generation"} })).status, 200);
  assert.equal((await gateway.fetch("https://toolbox.internal/health")).status, 404);
});

test("MCP SSE remains streamed and session headers survive", async () => {
  const response = await gateway.fetch("https://toolbox.internal/mcp", {headers: {"X-Pentcloud-Toolbox-Generation": "fixture-generation"}});
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("mcp-session-id"), "session-fixture");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "data: first\n\n", "first event arrives before the upstream closes");
  let content = new TextDecoder().decode(first.value);
  while (true) { const { value, done } = await reader.read(); if (done) break; content += new TextDecoder().decode(value); }
  assert.equal(content, "data: first\n\ndata: second\n\n");
});

test("gateway returns redirects without forwarding secret to another destination", async () => {
  const response = await gateway.fetch("https://toolbox.internal/mcp", { method: "POST", headers: { "x-redirect": "1", "X-Pentcloud-Toolbox-Generation": "fixture-generation" }, redirect: "manual" });
  assert.equal(response.status, 307);
});

test("public gateway rejects every route even with former operator or MCP credentials",async()=>{
  for(const path of ["/health","/mcp","/toolbox/status","/toolbox/start","/toolbox/restart"])
    for(const token of ["","native-operator-fixture","mcp-fixture-long-enough"])
      assert.equal((await publicWorker.fetch("https://public.example"+path,{method:"POST",headers:{Authorization:"Bearer "+token}})).status,404);
});

test("service and DO lifecycle RPC preserve typed outcomes and reject private HTTP lifecycle routes", async () => {
  assert.deepEqual(await (await gateway.fetch("https://caller.test/rpc/status")).json(), {state: "running", generation: "fixture-generation", inactivityTimeoutMs: 1800000});
  assert.deepEqual(await (await gateway.fetch("https://caller.test/rpc/ready")).json(), {state: "ready", generation: "fixture-generation"});
  assert.deepEqual(await (await gateway.fetch("https://caller.test/rpc/activity?generation=fixture-generation")).json(), {state: "running", generation: "fixture-generation"});
  for (const method of ["ready", "activity"]) {
    assert.deepEqual(await (await gateway.fetch(`https://caller.test/rpc/${method}?generation=stale-generation`)).json(), {error: "generation_lost", generation: "fixture-generation"});
  }
  for (const [path, method] of [["/health", "GET"], ["/ready", "GET"], ["/activity", "POST"]]) {
    assert.equal((await gateway.fetch(`https://toolbox.internal${path}`, {method})).status, 404);
  }
});


test("workerd lifecycle RPC does not wait for an in-flight MCP response", async () => {
  const mcp = gateway.fetch("https://toolbox.internal/mcp", {method: "POST", body: "one-mutation", headers: {"X-Pentcloud-Toolbox-Generation": "fixture-generation", "x-held": "1"}});
  let timer;
  try {
    const until = Date.now() + 2000;
    while (!(await (await upstream.fetch("https://kali.test/fixture/state")).json()).waiting) {
      assert.ok(Date.now() < until, "MCP did not reach its upstream");
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const replies = await Promise.race([
      Promise.all([gateway.fetch("https://caller.test/rpc/status").then(r => r.json()), gateway.fetch("https://caller.test/rpc/activity?generation=fixture-generation").then(r => r.json())]),
      new Promise((_, reject) => {timer = setTimeout(() => reject(new Error("MCP response held lifecycle RPC")), 2000);}),
    ]);
    assert.equal(replies[0].state, "running");
    assert.deepEqual(replies[1], {state: "running", generation: "fixture-generation"});
    assert.equal((await (await upstream.fetch("https://kali.test/fixture/state")).json()).waiting, true, "lifecycle RPC completed before the MCP response");
  } finally {
    clearTimeout(timer);
    const response = await mcp;
    assert.equal(response.status, 200, "the held MCP request must complete successfully");
    await response.body.cancel();
  }
});

test("workerd RPC cold start shares a generation and retries timeout failure without another start", async () => {
  const fixture = async options => (await publicWorker.fetch("https://fixture.internal/fixture", {method: "POST", body: JSON.stringify(options)})).json();
  try {
    await fixture({running:false,starts:0,timeouts:[],failTimeout:true});
    assert.deepEqual(await (await gateway.fetch("https://caller.test/rpc/status")).json(), {state:"stopped",inactivityTimeoutMs:1800000});
    assert.deepEqual(await (await gateway.fetch("https://caller.test/rpc/ready?generation=lost-generation")).json(), {error:"generation_lost"});
    assert.equal((await fixture({})).starts, 0, "status and pinned recovery cannot start the runtime");
    assert.deepEqual(await (await gateway.fetch("https://caller.test/rpc/ready")).json(), {error:"unavailable"});
    const failed = await fixture({});
    assert.equal(failed.starts, 1);
    assert.deepEqual(failed.timeouts, [1800000]);
    await fixture({failTimeout:false});
    const replies = await Promise.all(Array.from({length:8}, async () => (await gateway.fetch("https://caller.test/rpc/ready")).json()));
    assert.ok(replies.every(reply => reply.state === "ready" && reply.generation === failed.generation));
    const recovered = await fixture({});
    assert.equal(recovered.starts, 1);
    assert.deepEqual(recovered.timeouts, [1800000,1800000]);
    await fixture({running:false});
    assert.deepEqual(await (await gateway.fetch(`https://caller.test/rpc/ready?generation=${failed.generation}`)).json(), {error:"generation_lost"});
    assert.equal((await fixture({})).starts, 1, "lost pinned generation cannot restart");
    const cold = await Promise.all(Array.from({length:8}, async () => (await gateway.fetch("https://caller.test/rpc/ready")).json()));
    const next = await fixture({});
    assert.equal(next.starts, 2);
    assert.notEqual(next.generation, failed.generation);
    assert.ok(cold.every(reply => reply.generation === next.generation && ["booting","ready"].includes(reply.state)));
    assert.deepEqual(next.timeouts, [1800000,1800000,1800000]);
  } finally { await fixture({running:true,generation:"fixture-generation",failTimeout:false}); }
});

test("private lifecycle status never starts a stopped runtime and a lost generation cannot replace it",async()=>{
  const fixture=async options=>(await publicWorker.fetch("https://fixture.internal/fixture",{method:"POST",body:JSON.stringify(options)})).json();
  try{
    await fixture({running:false,starts:0,failTimeout:false});
    assert.deepEqual(await (await gateway.fetch("https://caller.test/rpc/status")).json(),{state:"stopped",inactivityTimeoutMs:1800000});
    assert.equal((await fixture({})).starts,0);
    assert.equal((await (await gateway.fetch("https://caller.test/rpc/ready?generation=lost-generation")).json()).error,"generation_lost");
    assert.equal((await fixture({})).starts,0);
    assert.equal((await (await gateway.fetch("https://caller.test/rpc/ready")).json()).state,"booting");
    assert.equal((await fixture({})).starts,1);
  }finally{await fixture({running:true,generation:"fixture-generation",failTimeout:false});}
});
