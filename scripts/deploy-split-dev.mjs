import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules/.bin/wrangler");
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

function deploy(config, rollout) {
  const result = spawnSync(
    wrangler,
    [
      "deploy",
      "--config",
      config,
      "--containers-rollout",
      rollout,
      "--keep-vars",
      ...(process.env.PENTCLOUD_DEPLOY_DRY_RUN === "1" ? ["--dry-run"] : [])
    ],
    { cwd: root, stdio: "inherit" }
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Deployment failed for ${config}: ${result.error?.message ?? result.status}`
    );
}

for (const pack of packs)
  deploy(`infra/tool-packs/wrangler.dev.${pack}.jsonc`, "none");
deploy("infra/tool-packs/wrangler.dev.gateway.jsonc", "immediate");

for (const name of ["coordinator", "attempt"]) {
  const path = `apps/control-plane/dist-split-dev-${name}/worker/wrangler.json`;
  const config = JSON.parse(readFileSync(join(root, path), "utf8"));
  if (
    config.name !== `pentcloud-dev-${name}` ||
    config.assets ||
    config.route ||
    config.routes?.length ||
    config.domains?.length
  )
    throw new Error(`Unsafe public route or assets on ${name}`);
  deploy(path, "none");
}

const uiPath = "apps/control-plane/dist-split-dev-ui/worker/wrangler.json";
const ui = JSON.parse(readFileSync(join(root, uiPath), "utf8"));
if (
  ui.name !== "pentcloud-dev-app" ||
  !ui.routes?.some((route) => route.pattern === "dev.pentcloud.dev") ||
  ui.containers?.length
)
  throw new Error("Invalid UI Worker build");
deploy(uiPath, "immediate");
