// Cloudflare's deployment button runs this in Workers Builds. Wrangler owns provisioning.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
export function customerConfig(config, options = {}) {
  if (options.worker) config.name = options.worker;
  assert(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.name),
    "Choose a valid Worker name"
  );
  const namespace = config.name.length === 1 ? config.name + "_" : config.name;
  config.artifacts[0].namespace = namespace;
  config.vars.ARTIFACTS_NAMESPACE = namespace;
  config.vars.PENTCLOUD_WORKER_NAME = config.name;
  if (/^[a-f0-9]{32}$/.test(options.accountId ?? ""))
    config.vars.PENTCLOUD_ACCOUNT_ID = options.accountId;
  return config;
}
async function main() {
  const config = customerConfig(
    JSON.parse(
      await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    ),
    {
      worker: process.env.WRANGLER_CI_OVERRIDE_NAME,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID
    }
  );
  await writeFile(
    new URL("../wrangler.jsonc", import.meta.url),
    JSON.stringify(config, null, 2) + "\n"
  );
  const commit = "d62c15449911c66258ecdb32c2e4f66c66d62cbd";
  const response = await fetch(
    `https://codeload.github.com/Memrov/PentCloud-tools/tar.gz/${commit}`,
    { signal: AbortSignal.timeout(90000) }
  );
  assert(response.ok, "Could not download the pinned tool source");
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash("sha256").update(archive).digest("hex"),
    "45edc4f160af5b8d1466d8c221a71cbb55127793e985cf73b487c17f7aac4cf8",
    "Tool source checksum mismatch"
  );
  await mkdir(new URL("../.pentcloud-tools/", import.meta.url), {
    recursive: true
  });
  await writeFile(
    new URL("../.pentcloud-tools/source.tgz", import.meta.url),
    archive
  );
  const run = (command, args, cwd = root) =>
    execFileSync(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        GOTOOLCHAIN: "go1.26.5",
        WRANGLER_SEND_METRICS: "false"
      }
    });
  run(
    "tar",
    ["-xzf", "source.tgz", "--strip-components", "1"],
    root + "/.pentcloud-tools"
  );
  // The Docker preparation stage needs the pinned source, not host-specific tools or caches.
  await writeFile(
    new URL("../.pentcloud-tools/.dockerignore", import.meta.url),
    ".cache/\nnode_modules/\n.git/\nsource.tgz\n"
  );
  run("npm", [
    "exec",
    "--workspace",
    "@pentagi-artifacts/control-plane",
    "--",
    "vp",
    "build",
    "--mode",
    "customer"
  ]);
  run(process.execPath, [
    "scripts/check-native-worker-build.mjs",
    "apps/control-plane/dist-customer/worker"
  ]);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
