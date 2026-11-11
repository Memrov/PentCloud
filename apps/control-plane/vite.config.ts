import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  test: {
    name: "unit",
    pool: "threads",
    isolate: true,
    include: ["test/**/*.test.ts"],
    exclude: ["test/native-contract-drift.test.ts"]
  },
  plugins:
    mode === "test"
      ? []
      : [
          react(),
          tailwindcss(),
          ...(mode === "browser-fixture"
            ? []
            : [
                cloudflare({
                  configPath:
                    process.env.PENTCLOUD_WRANGLER_CONFIG ??
                    (mode === "customer"
                      ? "../../wrangler.jsonc"
                      : "./wrangler.jsonc"),
                  viteEnvironment: { name: "worker" }
                })
              ])
        ],
  build: {
    outDir:
      process.env.PENTCLOUD_SPLIT_OUT_DIR ??
      (mode === "customer"
        ? "dist-customer"
        : mode === "browser-fixture"
          ? "dist/client"
          : "dist")
  },
  environments: {
    worker: {
      build: {
        minify: true,
        sourcemap: true,
        // Lifecycle addresses internal-host callbacks by constructor.name.
        rolldownOptions: {
          output: { keepNames: true, sourcemapExcludeSources: true }
        }
      }
    }
  }
}));
