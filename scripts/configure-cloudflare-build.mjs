import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configs = {
  app: new URL("../apps/control-plane/wrangler.jsonc", import.meta.url),
  gateway: new URL(
    "../infra/aws-toolbox/control/wrangler.jsonc",
    import.meta.url
  )
};

// Installation metadata belongs in Cloudflare Builds, not in the shared source.
// Runtime credentials remain bound Worker secrets and are never included here.
export function validateBuildConfig(
  kind,
  value,
  template,
  expectedName,
  installationTemplate
) {
  if (!Object.hasOwn(configs, kind)) throw new Error("Choose app or gateway.");
  if (typeof value !== "string" || !value || value.length > 5000) {
    throw new Error(
      "Set PENTCLOUD_DEPLOY_CONFIG in Cloudflare Builds (maximum 5000 characters)."
    );
  }
  let config;
  try {
    config = JSON.parse(value);
  } catch {
    throw new Error("PENTCLOUD_DEPLOY_CONFIG must be valid JSON.");
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Expected one Worker configuration.");
  if (
    typeof config.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name)
  )
    throw new Error("A valid Worker name is required.");
  if (expectedName && config.name !== expectedName)
    throw new Error("The configuration does not match this Builds Worker.");
  if (config.env || config.build)
    throw new Error(
      "Supply a single Worker configuration without environment or build overrides."
    );
  const sourceRoot =
    kind === "app" ? "apps/control-plane" : "infra/aws-toolbox/control";
  const sourcePath = (value, relative, suffix) =>
    value === relative ||
    (typeof value === "string" &&
      value.replaceAll("\\", "/").endsWith(`/${sourceRoot}/${suffix}`));
  if (!sourcePath(config.main, template.main, "src/worker.ts"))
    throw new Error("Preserve the source Worker entrypoint.");
  config.main = template.main;
  if (kind === "app") {
    if (
      !sourcePath(
        config.assets?.directory,
        template.assets.directory,
        "dist/client"
      )
    )
      throw new Error("Preserve the source assets directory.");
    config.assets.directory = template.assets.directory;
    // Vite owns compilation now. Accept old private Builds metadata while
    // using the current source's map policy; preserve installation settings.
    delete config.minify;
    delete config.rules;
    config.upload_source_maps = template.upload_source_maps;
  }
  const contract = [template, installationTemplate]
    .filter(Boolean)
    .find(
      (candidate) =>
        JSON.stringify(config.migrations) ===
        JSON.stringify(candidate.migrations)
    );
  const secretDeclarations = [
    template.secrets,
    installationTemplate?.secrets,
    ...(kind === "app"
      ? [{ required: ["OPENCODE_GO_API_KEY"] }, { required: [] }]
      : [])
  ];
  if (
    !secretDeclarations.some(
      (value) => JSON.stringify(value) === JSON.stringify(config.secrets)
    )
  )
    throw new Error(
      "Preserve source secret declarations; enter values as native Worker secrets."
    );
  if (!contract)
    throw new Error(
      "Preserve migration and secret declarations shipped with this source."
    );
  // Model secrets are optional during first-run setup. Native deploys preserve
  // existing secret bindings; no secret values are transferred here.
  if (template.secrets) config.secrets = template.secrets;
  else delete config.secrets;
  for (const key of [
    "main",
    "compatibility_date",
    "compatibility_flags",
    "durable_objects",
    "migrations",
    "secrets",
    "version_metadata",
    ...(kind === "app" ? ["assets", "worker_loaders"] : [])
  ]) {
    const expected = key === "migrations" ? contract[key] : template[key];
    if (JSON.stringify(config[key]) !== JSON.stringify(expected))
      throw new Error(`Preserve the source configuration's ${key}.`);
  }
  if (
    config.vars === undefined ||
    (config.vars &&
      typeof config.vars === "object" &&
      !Array.isArray(config.vars))
  ) {
    for (const key of Object.keys(config.vars || {})) {
      if (/(?:key|token|secret|password|credential)/i.test(key))
        throw new Error(
          "Bind credentials as Worker secrets, not configuration variables."
        );
    }
  } else throw new Error("Configuration variables must be an object.");
  if (template.vars) config.vars = { ...template.vars, ...config.vars };
  if (kind === "app") {
    // Old private Builds metadata can outlive the source. Retire only this
    // Worker's former RESULTS hint and its exact namespace push target.
    const retired = (config.workflows ?? []).filter(
      (entry) =>
        entry.binding === "RESULTS" &&
        entry.class_name === "ResultValidation" &&
        (!entry.script_name || entry.script_name === config.name)
    );
    if (retired.length) {
      config.workflows = config.workflows.filter(
        (entry) => !retired.includes(entry)
      );
      if (!config.workflows.length) delete config.workflows;
      if (Array.isArray(config.triggers?.events)) {
        const names = new Set(retired.map((entry) => entry.name));
        config.triggers.events = config.triggers.events.flatMap((event) => {
          if (
            event.type !== "cf.artifacts.repo.pushed" ||
            Object.keys(event.filter ?? {}).length !== 1 ||
            event.filter.namespace !==
              config.artifacts?.find((entry) => entry.binding === "ARTIFACTS")
                ?.namespace ||
            !Array.isArray(event.targets)
          )
            return [event];
          const targets = event.targets.filter(
            (target) =>
              !(target.type === "workflow" && names.has(target.workflow_name))
          );
          return targets.length ? [{ ...event, targets }] : [];
        });
      }
    }
    // An explicit empty list tells native deploys to remove the old subscription.
    config.triggers ??= {};
    config.triggers.events ??= [];
    if (
      (config.workflows ?? []).some(
        (entry) =>
          entry.class_name === "ResultValidation" &&
          (!entry.script_name || entry.script_name === config.name)
      ) ||
      config.exports?.ResultValidation
    )
      throw new Error(
        "ResultValidation is retired; remove its obsolete executable contract."
      );
    const toolBinding =
      config.services?.[0]?.binding === "TOOL_PACKS"
        ? ["TOOL_PACKS", { entrypoint: "ToolPackGateway" }]
        : ["TOOLBOX", { entrypoint: "ToolboxGateway" }];
    for (const [key, binding, fixed] of [
      ["artifacts", "ARTIFACTS", {}],
      ["services", ...toolBinding]
    ]) {
      const entries = config[key];
      if (
        !Array.isArray(entries) ||
        entries.length !== 1 ||
        entries[0].binding !== binding ||
        Object.entries(fixed).some(([k, v]) => entries[0][k] !== v)
      )
        throw new Error(`Preserve the ${key} binding contract.`);
      const resource =
        entries[0][
          key === "artifacts"
            ? "namespace"
            : key === "services"
              ? "service"
              : "name"
        ];
      if (typeof resource !== "string" || !resource)
        throw new Error(`Configure the ${key} resource.`);
    }
    for (const key of ["browser", "ai"])
      if (config[key]?.binding !== template[key].binding)
        throw new Error(`Preserve the ${key} binding.`);
  } else {
    const container = config.containers?.[0];
    if (
      config.containers?.length !== 1 ||
      container.class_name !== "KaliToolbox" ||
      container.scheduling_policy !== "durable_object" ||
      !container.name ||
      !container.images?.stock?.image
    )
      throw new Error("Configure the prepared stock Kali container.");
  }
  return config;
}

async function main() {
  const kind = process.argv[2];
  if (!Object.hasOwn(configs, kind) || process.argv.length !== 3)
    throw new Error(
      "Usage: node scripts/configure-cloudflare-build.mjs app|gateway"
    );
  const template = JSON.parse(await readFile(configs[kind], "utf8"));
  const installationTemplate = JSON.parse(
    await readFile(
      new URL(`../templates/private-install/${kind}.json`, import.meta.url),
      "utf8"
    )
  );
  const config = validateBuildConfig(
    kind,
    process.env.PENTCLOUD_DEPLOY_CONFIG,
    template,
    process.env.WRANGLER_CI_OVERRIDE_NAME,
    installationTemplate
  );
  await writeFile(configs[kind], `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });
  console.log("Applied this installation’s Cloudflare Builds configuration.");
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
