import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { splitDevWorkerConfigs } from "./split-dev-worker-config.mjs";

const source = JSON.parse(
  await readFile(
    new URL("../apps/control-plane/wrangler.jsonc", import.meta.url),
    "utf8"
  )
);
source.name = "pentcloud-dev-app";
source.routes = [{ pattern: "dev.pentcloud.dev", custom_domain: true }];
source.containers = [
  {
    class_name: "NativeAttempt",
    scheduling_policy: "durable_object",
    images: { computer: { dockerfile: "Dockerfile" } }
  }
];

void test("staged transfer keeps the old SQLite namespaces and container until commit", () => {
  const stages = splitDevWorkerConfigs(source);
  assert.equal(
    stages["01-source-convert"].exports.NativeAttempt.container,
    "pentcloud-dev-app-nativeattempt"
  );
  assert.equal(
    stages["02-attempt-receive"].exports.NativeAttempt.state,
    "expecting-transfer"
  );
  assert.equal(
    stages["02-attempt-receive"].durable_objects.bindings.some(
      (x) => x.name === "ATTEMPTS"
    ),
    false
  );
  assert.equal(stages["02-attempt-receive"].routes, undefined);
  assert.equal(stages["02-coordinator-receive"].routes, undefined);
  assert.equal(
    stages["05-source-ui"].routes?.[0]?.pattern,
    "dev.pentcloud.dev"
  );
  assert.equal(
    stages["03-source-commit"].exports.NativeAttempt.state,
    "transferred"
  );
  assert.equal(stages["03-source-commit"].main, source.main);
  assert.equal(
    stages["04-attempt-bound"].exports.NativeAttempt.container,
    "pentcloud-dev-app-nativeattempt"
  );
  assert.equal(
    stages["04-attempt-bound"].durable_objects.bindings.find(
      (x) => x.name === "ATTEMPTS"
    ).script_name,
    undefined
  );
  assert.equal(stages["05-source-ui"].main, "src/ui-entry.ts");
  assert.equal(
    stages["05-source-ui"].durable_objects.bindings.find(
      (x) => x.name === "ATTEMPTS"
    ).script_name,
    "pentcloud-dev-attempt"
  );
});

void test("staged transfer refuses an unexpected migration history", () => {
  assert.throws(
    () => splitDevWorkerConfigs({ ...source, migrations: [] }),
    /Missing existing SQLite class/
  );
});

void test("private config may omit retired proof migrations", () => {
  const privateConfig = structuredClone(source);
  privateConfig.migrations = privateConfig.migrations.filter(
    (migration) => migration.tag !== "v1"
  );
  assert.equal(
    splitDevWorkerConfigs(privateConfig)["05-source-ui"].name,
    "pentcloud-dev-app"
  );
});
