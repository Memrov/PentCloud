import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceName = "pentcloud-dev-app";
const coordinatorName = "pentcloud-dev-coordinator";
const attemptName = "pentcloud-dev-attempt";
const liveClasses = [
  "ProofQueue",
  "ProofAttempt",
  "Coordinator",
  "NativeAttempt",
  "OpenCodeConnectionTest",
  "AgentBrowser"
];
const clone = (value) => structuredClone(value);
const created = () => ({ type: "durable-object", storage: "sqlite" });
const transfer = (to) => ({
  type: "durable-object",
  state: "transferred",
  transferred_to: to
});
const expecting = () => ({
  type: "durable-object",
  state: "expecting-transfer",
  storage: "sqlite",
  transfer_from: sourceName
});

function binding(name, className, scriptName) {
  return {
    name,
    class_name: className,
    ...(scriptName ? { script_name: scriptName } : {})
  };
}

function withBindings(config, replacements) {
  const next = clone(config);
  next.durable_objects.bindings = next.durable_objects.bindings.map(
    (item) => replacements[item.name] ?? item
  );
  return next;
}

function target(base, kind, phase) {
  const isCoordinator = kind === "coordinator";
  const className = isCoordinator ? "Coordinator" : "NativeAttempt";
  const name = isCoordinator ? coordinatorName : attemptName;
  const next = clone(base);
  next.name = name;
  next.main = isCoordinator
    ? "src/coordinator-entry.ts"
    : "src/attempt-entry.ts";
  delete next.assets;
  delete next.triggers;
  delete next.routes;
  delete next.route;
  delete next.domains;
  delete next.migrations;
  next.services = [
    ...(next.services ?? []),
    {
      binding: "TARGET_SECRETS",
      service: sourceName,
      entrypoint: "TargetSecretBroker"
    }
  ];
  if (isCoordinator) delete next.containers;
  else
    next.containers = (next.containers ?? []).filter(
      (x) => x.class_name === className
    );
  next.exports = { [className]: phase === "receive" ? expecting() : created() };
  if (!isCoordinator)
    next.exports.NativeAttempt.container = next.containers[0].name;
  next.durable_objects.bindings = [
    ...(phase === "bound"
      ? [binding(isCoordinator ? "COORDINATOR" : "ATTEMPTS", className)]
      : []),
    binding(
      isCoordinator ? "ATTEMPTS" : "COORDINATOR",
      isCoordinator ? "NativeAttempt" : "Coordinator",
      phase === "bound"
        ? isCoordinator
          ? attemptName
          : coordinatorName
        : sourceName
    ),
    binding("MODEL_TESTS", "OpenCodeConnectionTest", sourceName),
    binding("AGENT_BROWSERS", "AgentBrowser", sourceName)
  ];
  return next;
}

export function splitDevWorkerConfigs(input) {
  if (input.name !== sourceName || !Array.isArray(input.migrations))
    throw new Error(
      "Expected the existing private pentcloud-dev-app config with legacy migrations"
    );
  // Retired proof classes may be absent from the private migration history.
  // The active state owners must be present before preparing a transfer.
  for (const className of ["Coordinator", "NativeAttempt"])
    if (
      !input.migrations.some((m) =>
        (m.new_sqlite_classes ?? []).includes(className)
      )
    )
      throw new Error(`Missing existing SQLite class ${className}`);
  if (!input.containers?.some((x) => x.class_name === "NativeAttempt"))
    throw new Error("Expected the existing NativeAttempt container");

  const source = clone(input);
  delete source.migrations;
  source.containers = source.containers.map((item) =>
    item.class_name === "NativeAttempt"
      ? { ...item, name: item.name ?? `${sourceName}-nativeattempt` }
      : item
  );
  source.exports = Object.fromEntries(
    liveClasses.map((name) => [name, created()])
  );
  source.exports.NativeAttempt.container = source.containers.find(
    (x) => x.class_name === "NativeAttempt"
  ).name;
  const committed = withBindings(source, {
    COORDINATOR: binding("COORDINATOR", "Coordinator", coordinatorName),
    ATTEMPTS: binding("ATTEMPTS", "NativeAttempt", attemptName)
  });
  committed.exports.Coordinator = transfer(coordinatorName);
  committed.exports.NativeAttempt = transfer(attemptName);
  delete committed.containers;
  const finalSource = clone(committed);
  finalSource.main = "src/ui-entry.ts";

  return {
    "01-source-convert": source,
    "02-coordinator-receive": target(source, "coordinator", "receive"),
    "02-attempt-receive": target(source, "attempt", "receive"),
    "03-source-commit": committed,
    "04-coordinator-bound": target(source, "coordinator", "bound"),
    "04-attempt-bound": target(source, "attempt", "bound"),
    "05-source-ui": finalSource
  };
}

async function main() {
  const inputPath = resolve(
    process.argv[2] ?? "apps/control-plane/wrangler.jsonc"
  );
  const outputDir = resolve(process.argv[3] ?? "apps/control-plane");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const stages = splitDevWorkerConfigs(input);
  await mkdir(outputDir, { recursive: true });
  for (const [stage, config] of Object.entries(stages))
    await writeFile(
      join(outputDir, `.split-${stage}.jsonc`),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 }
    );
  console.log(
    `Prepared ${Object.keys(stages).length} staged Worker configs in ${outputDir}`
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
