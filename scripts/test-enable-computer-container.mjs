import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  enableArtifactService,
  enableCodexRunner,
  enableComputerContainer,
  enableRunPreparationWorkflow
} from "./enable-computer-container.mjs";

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

test("Codex dev app reaches Artifacts through a private service", () => {
  const result = enableArtifactService({
    ...template,
    artifacts: [{ binding: "ARTIFACTS", namespace: "pentcloud-dev-work" }]
  });
  assert.equal(result.artifacts, undefined);
  assert(
    result.services.some(
      (entry) =>
        entry.binding === "ARTIFACTS" &&
        entry.service === "pentcloud-artifacts-dev" &&
        entry.entrypoint === "ArtifactService"
    )
  );
  assert.deepEqual(enableArtifactService(result), result);
  assert.throws(
    () =>
      enableArtifactService({
        ...result,
        artifacts: [{ binding: "ARTIFACTS", namespace: "other" }]
      }),
    /one owner/
  );
});

test("Codex dev app binds the small run preparation Workflow", () => {
  const result = enableRunPreparationWorkflow(template);
  assert.deepEqual(result.workflows, [
    {
      name: "pentcloud-run-preparation-v1",
      binding: "RUN_PREPARATION_WORKFLOW",
      class_name: "RunPreparationWorkflow",
      script_name: "codex-role-workflow-dev"
    }
  ]);
  assert.deepEqual(enableRunPreparationWorkflow(result), result);
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

test("Codex runner preserves the private service bindings and is idempotent", () => {
  const config = {
    ...template,
    services: [{ binding: "TOOL_PACKS", service: "private-packs" }],
    vars: { ACCESS_AUD: "private-audience" }
  };
  const result = enableCodexRunner(config);
  assert.deepEqual(result.services, [
    ...config.services,
    {
      binding: "CODEX_RUNNER",
      service: "codex-lifecycle-pilot",
      entrypoint: "NativeCodexRunner"
    }
  ]);
  assert.deepEqual(result.vars, {
    ACCESS_AUD: "private-audience",
    PENTCLOUD_AGENT_ENGINE: "codex"
  });
  assert.deepEqual(enableCodexRunner(result), result);
  assert.throws(
    () =>
      enableCodexRunner({
        ...config,
        services: [{ binding: "CODEX_RUNNER", service: "other" }]
      }),
    /different service binding/
  );
});
