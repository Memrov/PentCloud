import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {withNativeTestHarness} from "./lib/native-test-harness.mjs";

const options = {
  root: fileURLToPath(new URL("../", import.meta.url)),
  workers: [{config: {
    name: "native-harness-lifecycle-test",
    main: "scripts/test-fixtures/native-harness-worker.mjs",
    compatibility_date: "2026-10-19",
    durable_objects: {bindings: [{name: "COUNTER", class_name: "Counter"}]},
    migrations: [{tag: "v1", new_sqlite_classes: ["Counter"]}],
  }}],
};

test("native fixture shutdown closes its listener after successful work", async () => {
  // Removing the wrapper's finally/close must leave this listener reachable.
  let address;
  await withNativeTestHarness(options, async (server, url) => {
    address = url;
    assert.deepEqual(await (await server.fetch("/")).json(), {count: 1});
  });
  await assert.rejects(fetch(address, {signal: AbortSignal.timeout(2000)}));
});

test("native fixture shutdown preserves a failed assertion and closes its listener", async () => {
  let address;
  const failure = new Error("deliberate fixture assertion failure");
  await assert.rejects(withNativeTestHarness(options, async (server, url) => {
    address = url;
    assert.equal((await server.fetch("/")).status, 200);
    throw failure;
  }), error => error === failure);
  await assert.rejects(fetch(address, {signal: AbortSignal.timeout(2000)}));
});

test("native fixtures preserve durable state across eviction and isolate the next fixture", async () => {
  await withNativeTestHarness(options, async server => {
    assert.deepEqual(await (await server.fetch("/")).json(), {count: 1});
    await server.getWorker().evictDurableObject("COUNTER", {name: "counter"});
    assert.deepEqual(await (await server.fetch("/")).json(), {count: 2});
  });
  await withNativeTestHarness(options, async server => {
    assert.deepEqual(await (await server.fetch("/")).json(), {count: 1});
  });
});
