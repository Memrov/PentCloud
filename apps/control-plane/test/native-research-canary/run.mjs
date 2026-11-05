// Real upstream retrieval in local workerd; no deployment, model or scanner call.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const require = createRequire(resolve(root, "package.json"));
const mf = require("miniflare");
const { fetch, EnvHttpProxyAgent } = require("undici");
const dispatcher = new EnvHttpProxyAgent();
const directory = mkdtempSync(resolve(tmpdir(), "pentcloud-managed-research-"));
let runtime;
try {
  execFileSync(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", "test/native-research-canary/wrangler.jsonc", "--outdir", directory], {
    cwd: resolve(root, "apps/control-plane"),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let keylessRequests = 0;
  const options = {
    script: readFileSync(resolve(directory, "worker.js"), "utf8"),
    modules: true,
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { CANARY_TOKEN: "local-retrieval-proof" },
    durableObjects: { PROBE: { className: "ResearchProbe", useSQLite: true } },
    // Only the local harness routes egress through the session's configured
    // proxy. Stock OpenCode and Web Fetch run unchanged inside the Worker.
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.href === "https://agent.tinyfish.ai/mcp") {
        assert.equal(request.headers.get("x-tinyfish-access-mode"), "keyless");
        assert.equal(request.headers.has("x-api-key"), false);
        keylessRequests++;
      } else {
        assert.equal(url.origin, "https://developers.cloudflare.com");
        assert.ok(url.pathname.startsWith("/agents/"));
      }
      const response = await fetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(35000),
      });
      // Undici has already decoded the body; do not make workerd decode twice.
      const headers = new Headers([...response.headers]);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new mf.Response(await response.arrayBuffer(), { status: response.status, headers: [...headers] });
    },
  };
  runtime = new mf.Miniflare(mf.convertV4MiniflareOptions?.(options) ?? options);
  const response = await runtime.dispatchFetch("http://proof.invalid/run", { method: "POST", headers: { Authorization: "Bearer local-retrieval-proof" } });
  assert.equal(response.status, 200);
  const proof = await response.json();
  assert.equal(proof.durableObject.error, undefined, JSON.stringify(proof.durableObject));
  assert.equal(proof.durableObject.search.provider, "tinyfish");
  assert.equal(proof.durableObject.search.items.length, 3);
  assert.ok(proof.durableObject.search.items.some((item) => item.url === "https://developers.cloudflare.com/agents/"));
  assert.equal(proof.durableObject.browserStatus, 200);
  assert.equal(proof.durableObject.browserFormat, "markdown-negotiated");
  assert.ok(proof.durableObject.browserCharacters > 100);
  assert.equal(keylessRequests, 1);
  assert.equal(proof.modelCalls, 0);
  assert.equal(proof.scans, 0);
  console.log(JSON.stringify({ ...proof, keylessRequests, deployments: 0 }, null, 2));
} finally {
  await runtime?.dispose();
  await dispatcher.close();
  rmSync(directory, { recursive: true, force: true });
}
