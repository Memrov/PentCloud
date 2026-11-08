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
    include: ["test/**/*.test.ts"]
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
                    mode === "customer"
                      ? "../../wrangler.jsonc"
                      : "./wrangler.jsonc",
                  viteEnvironment: { name: "worker" }
                })
              ])
        ],
  build: {
    outDir:
      mode === "customer"
        ? "dist-customer"
        : mode === "browser-fixture"
          ? "dist/client"
          : "dist"
  },
  environments: {
    worker: {
      build: {
        minify: true,
        sourcemap: true,
        rolldownOptions: { output: { sourcemapExcludeSources: true } }
      }
    }
  }
}));
