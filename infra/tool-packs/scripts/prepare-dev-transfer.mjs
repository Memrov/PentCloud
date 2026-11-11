import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packs = [
  "recon",
  "http",
  "nuclei",
  "sqlmap",
  "service",
  "web-context",
  "pcap",
  "file-analysis",
  "password",
  "reference",
  "metasploit"
];
const oldWorker = "pentcloud-dev-tools";
const created = (container) => ({
  type: "durable-object",
  storage: "sqlite",
  container
});

export function transferConfigs(sourceInput, gatewayInput, targetInputs) {
  const source = structuredClone(sourceInput);
  source.name = oldWorker;
  source.main = "src/legacy-worker.ts";
  if (
    source.migrations?.length !== 1 ||
    !source.migrations[0].new_sqlite_classes
  )
    throw new Error("Expected the original tool-pack SQLite migration");
  delete source.migrations;
  source.containers = [];
  source.exports = {};
  const targets = {};
  for (const pack of packs) {
    const target = structuredClone(targetInputs[pack]);
    const doBinding = target.durable_objects?.bindings?.[0];
    if (
      target.durable_objects.bindings.length !== 1 ||
      !doBinding ||
      target.containers?.length !== 1
    )
      throw new Error(`Expected one Durable Object and container for ${pack}`);
    const className = doBinding.class_name;
    if (!sourceInput.migrations[0].new_sqlite_classes.includes(className))
      throw new Error(`Unrecognized existing class ${className}`);
    const containerName = `${oldWorker}-${pack}`;
    target.containers[0].name = containerName;
    source.containers.push(structuredClone(target.containers[0]));
    source.exports[className] = created(containerName);
    delete target.migrations;
    target.exports = {
      [className]: {
        type: "durable-object",
        state: "expecting-transfer",
        storage: "sqlite",
        transfer_from: oldWorker,
        container: containerName
      }
    };
    target.durable_objects.bindings = [];
    const bound = structuredClone(target);
    bound.exports[className] = created(containerName);
    bound.durable_objects.bindings = [doBinding];
    targets[`02-${pack}-receive`] = target;
    targets[`04-${pack}-bound`] = bound;
  }
  if (
    Object.keys(source.exports).length !==
    sourceInput.migrations[0].new_sqlite_classes.length
  )
    throw new Error("A live tool class is missing from the split");
  const commit = structuredClone(source);
  delete commit.containers;
  commit.durable_objects.bindings = commit.durable_objects.bindings.map(
    (binding) => {
      const pack = packs.find(
        (p) =>
          source.exports[binding.class_name]?.container === `${oldWorker}-${p}`
      );
      if (!pack) throw new Error(`Missing target for ${binding.class_name}`);
      return { ...binding, script_name: targetInputs[pack].name };
    }
  );
  for (const [className, item] of Object.entries(commit.exports))
    commit.exports[className] = {
      type: "durable-object",
      state: "transferred",
      transferred_to:
        targetInputs[item.container.slice(`${oldWorker}-`.length)].name
    };
  const gateway = structuredClone(gatewayInput);
  gateway.name = oldWorker;
  return {
    "01-source-convert": source,
    ...targets,
    "03-source-commit": commit,
    "05-source-gateway": gateway
  };
}

async function main() {
  const source = JSON.parse(
    await readFile(join(root, "wrangler.jsonc"), "utf8")
  );
  const gateway = JSON.parse(
    await readFile(join(root, "wrangler.dev.gateway.jsonc"), "utf8")
  );
  const targetInputs = {};
  for (const pack of packs)
    targetInputs[pack] = JSON.parse(
      await readFile(join(root, `wrangler.dev.${pack}.jsonc`), "utf8")
    );
  const configs = transferConfigs(source, gateway, targetInputs);
  const out = resolve(process.argv[2] ?? root);
  await mkdir(out, { recursive: true });
  for (const [stage, config] of Object.entries(configs))
    await writeFile(
      join(out, `.split-${stage}.jsonc`),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 }
    );
  console.log(
    `Prepared ${Object.keys(configs).length} staged tool Worker configs in ${out}`
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
