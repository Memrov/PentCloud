import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withNativeTestHarness } from "./lib/native-test-harness.mjs";

const root = fileURLToPath(new URL("../apps/control-plane/", import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../apps/control-plane/test/native-research-canary/wrangler.jsonc",
      import.meta.url
    )
  )
);

test("research fixture rejects missing, empty and incorrect credentials before accessing a DO", async () => {
  for (const token of [undefined, "", "local-canary-test-secret"]) {
    await withNativeTestHarness(
      {
        root,
        workers: [
          {
            config: {
              ...fixture,
              main: "test/native-research-canary/worker.ts",
              vars: token === undefined ? {} : { CANARY_TOKEN: token }
            }
          }
        ]
      },
      async (server) => {
        for (const path of ["/health", "/run", "/clean"]) {
          for (const authorization of [
            undefined,
            "Bearer undefined",
            "Bearer null",
            "Bearer ",
            "Bearer wrong"
          ]) {
            const response = await server.fetch(path, {
              method: "POST",
              headers:
                authorization === undefined
                  ? {}
                  : { Authorization: authorization }
            });
            assert.equal(
              response.status,
              401,
              `${path} must reject ${authorization ?? "no credential"} with ${token === undefined ? "absent" : token === "" ? "empty" : "configured"} binding`
            );
          }
        }
        if (token) {
          const response = await server.fetch("/health", {
            headers: { Authorization: `Bearer ${token}` }
          });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), { ready: true });
        }
      }
    );
  }
});

test("checked-in local probe configurations publish no workers.dev or preview URL", () => {
  const directory = new URL("../apps/control-plane/test/", import.meta.url);
  for (const name of readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^native-/.test(entry.name))
    .map((entry) => entry.name)) {
    const configURL = new URL(`${name}/wrangler.jsonc`, directory);
    let config;
    try {
      config = JSON.parse(readFileSync(configURL, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assert.equal(config.workers_dev, false, name);
    assert.equal(config.preview_urls, false, name);
  }
});
