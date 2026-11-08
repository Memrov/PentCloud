import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite-plus";
import appConfig from "../../apps/control-plane/vite.config.ts";

// Compile the actual UI once; Cloudflare's test harness serves the output.
export default defineConfig((env) =>
  mergeConfig(appConfig(env), {
    root: fileURLToPath(new URL("../../apps/control-plane", import.meta.url)),
    build: {
      outDir: fileURLToPath(
        new URL(
          "../../node_modules/.cache/pentcloud-browser-fixture",
          import.meta.url
        )
      ),
      emptyOutDir: true
    }
  })
);
