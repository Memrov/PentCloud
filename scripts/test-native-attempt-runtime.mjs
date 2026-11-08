import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withNativeTestHarness } from "./lib/native-test-harness.mjs";

const app = fileURLToPath(new URL("../apps/control-plane/", import.meta.url));
await withNativeTestHarness(
  {
    root: app,
    workers: [{ configPath: "test/native-attempt-probe/wrangler.jsonc" }]
  },
  async (server, url) => {
    // Keep the remaining Python assertions against the real workerd fixture;
    // migrated scenarios run under test:workers (see attempt.runtime.ts).
    const child = spawn(
      process.env.PYTHON ?? "python3",
      [
        fileURLToPath(
          new URL(
            "../apps/control-plane/test/native-attempt-probe/check.py",
            import.meta.url
          )
        ),
        url.href.replace(/\/$/, "")
      ],
      { stdio: "inherit" }
    );
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`Attempt assertions failed (${signal ?? code})`))
      );
    });
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
