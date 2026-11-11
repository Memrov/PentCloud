import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const read = async (name) =>
  JSON.parse(await readFile(join(root, name), "utf8"));
const gateway = await read("wrangler.gateway.jsonc");
const devGateway = await read("wrangler.dev.gateway.jsonc");
const temp = await mkdtemp(join(tmpdir(), "pentcloud-tool-bundles-"));

try {
  if (
    gateway.services?.length !== packs.length ||
    devGateway.services?.length !== packs.length
  )
    throw Error("Every tool pack needs a gateway service binding");
  const configs = [["gateway", gateway]];
  for (const pack of packs) {
    const config = await read(`wrangler.${pack}.jsonc`);
    const dev = await read(`wrangler.dev.${pack}.jsonc`);
    const worker = gateway.services.find(
      (entry) => entry.service === config.name
    );
    const devWorker = devGateway.services.find(
      (entry) => entry.service === dev.name
    );
    const [image] = config.containers ?? [];
    const cls = image?.class_name;
    if (
      !worker ||
      !devWorker ||
      worker.binding !== devWorker.binding ||
      worker.entrypoint !== devWorker.entrypoint ||
      config.durable_objects?.bindings?.[0]?.class_name !== cls ||
      image.images?.[pack]?.build_vars?.PACK !== pack ||
      config.exports?.[cls]?.storage !== "sqlite" ||
      dev.exports?.[cls]?.storage !== "sqlite" ||
      dev.exports?.[cls]?.container !== `pentcloud-dev-tools-${pack}` ||
      dev.durable_objects?.bindings?.[0]?.class_name !== cls ||
      dev.containers?.[0]?.class_name !== cls
    )
      throw Error(`Incomplete isolated Worker config for ${pack}`);
    configs.push([pack, config]);
  }
  for (const [name, config] of configs) {
    // Compile the Worker without asking Docker to build the separate image.
    // The checked-in pack config owns its image and Durable Object.
    const bundle = structuredClone(config);
    delete bundle.containers;
    bundle.main = resolve(root, bundle.main);
    const path = join(temp, `${name}.json`);
    await writeFile(path, JSON.stringify(bundle));
    const result = spawnSync(
      resolve(root, "../../node_modules/.bin/wrangler"),
      ["deploy", "--config", path, "--dry-run", "--outdir", join(temp, name)],
      { cwd: root, encoding: "utf8" }
    );
    if (result.status !== 0)
      throw Error(`${name} bundle failed: ${result.stderr || result.stdout}`);
    console.log(
      `${name}: ${result.stdout.match(/Total Upload: ([^\n]+)/)?.[1] ?? "built"}`
    );
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
