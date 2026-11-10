import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { enableComputerContainer } from "./enable-computer-container.mjs";

const template = JSON.parse(
  await readFile(
    new URL("../apps/control-plane/wrangler.jsonc", import.meta.url),
    "utf8"
  )
);

test("container pilot preserves private installation metadata", () => {
  const privateConfig = {
    ...template,
    name: "example-test-app",
    vars: { ACCESS_AUD: "example-audience" },
    services: [{ binding: "TOOLBOX", service: "example-private-toolbox" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "example-private" }]
  };
  const result = enableComputerContainer(privateConfig);
  assert.equal(result.name, privateConfig.name);
  assert.deepEqual(result.services, privateConfig.services);
  assert.deepEqual(result.artifacts, privateConfig.artifacts);
  assert.deepEqual(result.migrations, privateConfig.migrations);
  assert.deepEqual(result.vars, {
    ACCESS_AUD: "example-audience",
    PENTCLOUD_COMPUTER_BACKEND: "container"
  });
  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].class_name, "NativeAttempt");
  assert.equal(
    result.containers[0].images.computer.dockerfile,
    "../../infra/computer/Dockerfile"
  );
  assert.deepEqual(enableComputerContainer(result), result);
});

test("container pilot rejects a conflicting NativeAttempt image", () => {
  assert.throws(
    () =>
      enableComputerContainer({
        ...template,
        containers: [{ class_name: "NativeAttempt", images: {} }]
      }),
    /different container/
  );
});
