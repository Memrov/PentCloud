import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps/control-plane");
const stages = [
  ["04-coordinator-bound", "coordinator"],
  ["04-attempt-bound", "attempt"],
  ["05-source-ui", "ui"]
];

function run(command, args, options = {}) {
  const environment = { ...process.env, ...options.env };
  delete environment.WRANGLER_CI_OVERRIDE_NAME;
  delete environment.WRANGLER_CI_MATCH_TAG;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: environment,
    stdio: "inherit"
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.status}`
    );
}

run(process.execPath, [
  "scripts/split-dev-worker-config.mjs",
  process.env.PENTCLOUD_SPLIT_INPUT_CONFIG ??
    "apps/control-plane/wrangler.jsonc"
]);
run("npm", ["run", "build:split", "--workspace", "@pentcloud/tool-packs"]);
for (const [stage, name] of stages) {
  const out = `dist-split-dev-${name}`;
  run(join(root, "node_modules/.bin/vp"), ["build", "--mode", "split"], {
    cwd: app,
    env: {
      PENTCLOUD_WRANGLER_CONFIG: `./.split-${stage}.jsonc`,
      PENTCLOUD_SPLIT_OUT_DIR: out
    }
  });
  if (name !== "ui")
    run(
      process.execPath,
      [
        "../../scripts/strip-split-worker-assets.mjs",
        `${out}/worker/wrangler.json`
      ],
      { cwd: app }
    );
}
