import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";

export default async function buildFixture() {
  if (process.env.PENTCLOUD_UI_BASE_URL) return;
  const root = fileURLToPath(new URL("../..", import.meta.url));
  await build({
    configFile: fileURLToPath(
      new URL("ui-fixture.config.mts", import.meta.url)
    ),
    mode: "browser-fixture"
  });
  // Reuse one compiled Worker across test resets instead of rebundling each time.
  execFileSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--config",
      "scripts/browser-qa/ui-fixture.wrangler.jsonc",
      "--outdir",
      fileURLToPath(
        new URL(
          "../../node_modules/.cache/pentcloud-browser-worker",
          import.meta.url
        )
      )
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
    }
  );
}
