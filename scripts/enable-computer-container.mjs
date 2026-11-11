import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const computer = {
  class_name: "NativeAttempt",
  scheduling_policy: "durable_object",
  images: {
    computer: { dockerfile: "../../infra/computer/Dockerfile" }
  }
};

export function enableComputerContainer(config) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Expected a Worker configuration.");
  if (
    !config.durable_objects?.bindings?.some(
      (binding) => binding.class_name === "NativeAttempt"
    )
  )
    throw new Error("NativeAttempt must be bound as a Durable Object.");
  if (config.containers !== undefined && !Array.isArray(config.containers))
    throw new Error("Expected a list of containers.");
  if (
    config.vars !== undefined &&
    (!config.vars ||
      typeof config.vars !== "object" ||
      Array.isArray(config.vars))
  )
    throw new Error("Expected configuration variables.");
  const existing = (config.containers ?? []).find(
    (container) => container.class_name === "NativeAttempt"
  );
  if (existing && JSON.stringify(existing) !== JSON.stringify(computer))
    throw new Error("NativeAttempt already has a different container.");
  return {
    ...config,
    vars: { ...config.vars, PENTCLOUD_COMPUTER_BACKEND: "container" },
    containers: existing
      ? config.containers
      : [...(config.containers ?? []), computer]
  };
}

export function enableCodexRunner(config) {
  const binding = {
    binding: "CODEX_RUNNER",
    service: "codex-lifecycle-pilot",
    entrypoint: "NativeCodexRunner"
  };
  const services = config.services ?? [];
  const existing = services.find(
    (service) => service.binding === binding.binding
  );
  if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
    throw new Error("CODEX_RUNNER already has a different service binding.");
  return {
    ...config,
    vars: { ...config.vars, PENTCLOUD_AGENT_ENGINE: "codex" },
    services: existing ? services : [...services, binding]
  };
}

export function enableArtifactService(config) {
  const namespace = config.artifacts?.find(
    (entry) => entry.binding === "ARTIFACTS"
  );
  const binding = {
    binding: "ARTIFACTS",
    service: "pentcloud-artifacts-dev",
    entrypoint: "ArtifactService"
  };
  const services = config.services ?? [];
  const existing = services.find((service) => service.binding === "ARTIFACTS");
  if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
    throw new Error("ARTIFACTS is already bound to another service.");
  if (!namespace) {
    if (existing && !config.artifacts?.length) return config;
    throw new Error("Expected one Artifacts namespace binding.");
  }
  if (config.artifacts.length !== 1 || existing)
    throw new Error("ARTIFACTS must have one owner.");
  const result = {
    ...config,
    services: [...services, binding]
  };
  delete result.artifacts;
  return result;
}

export function enableRunPreparationWorkflow(config) {
  const binding = {
    name: "pentcloud-run-preparation-v1",
    binding: "RUN_PREPARATION_WORKFLOW",
    class_name: "RunPreparationWorkflow",
    script_name: "codex-role-workflow-dev"
  };
  const workflows = config.workflows ?? [];
  const existing = workflows.find(
    (workflow) => workflow.binding === binding.binding
  );
  if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
    throw new Error("RUN_PREPARATION_WORKFLOW is already bound elsewhere.");
  return {
    ...config,
    workflows: existing ? workflows : [...workflows, binding]
  };
}

async function main() {
  const path = resolve(process.argv[2] ?? "apps/control-plane/wrangler.jsonc");
  const config = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    `${JSON.stringify(enableRunPreparationWorkflow(enableArtifactService(enableCodexRunner(enableComputerContainer(config)))), null, 2)}\n`,
    { mode: 0o600 }
  );
  console.log("Enabled the Computer container in the private build checkout.");
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
