import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { withNativeTestHarness } from "./lib/native-test-harness.mjs";

const app = fileURLToPath(new URL("../apps/control-plane/", import.meta.url));
await withNativeTestHarness(
  {
    root: app,
    workers: [{ configPath: "test/native-attempt-probe/wrangler.jsonc" }]
  },
  async (server, url) => {
    // Keep one actual HTTP/model round trip; scenario assertions live in Vitest.
    const model = await server.fetch(new URL("/native-pinned-model", url));
    const value = await model.json();
    assert.equal(model.status, 200, JSON.stringify(value));
    assert.equal(value.result.status, "completed", JSON.stringify(value));
    assert.equal(value.modelRequests, 1);
    assert.equal(value.request.authenticated, true);
    // The Explorer remains the platform diagnostic API, without an observer Worker.
    const response = await fetch(
      new URL("/cdn-cgi/local/explorer/api/local/observability/query", url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: "SELECT service, name, outcome, count(*) AS count FROM spans GROUP BY service, name, outcome LIMIT 100"
        }),
        signal: AbortSignal.timeout(10000)
      }
    );
    if (!response.ok)
      throw new Error(
        `Local Explorer failed: ${response.status} ${await response.text()}`
      );
    console.log(
      JSON.stringify({
        localExplorer: await response.json(),
        runtimeLogs: server.getLogs().length
      })
    );
  }
);
