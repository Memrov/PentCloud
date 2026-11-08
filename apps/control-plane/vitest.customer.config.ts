import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/customer/worker.ts",
      miniflare: {
        modulesRules: [
          { type: "Data", include: ["**/*.bin"], fallthrough: true },
          {
            type: "Text",
            include: ["**/*.tmpl", "**/*.txt", "**/*.md"],
            fallthrough: true
          }
        ],
        compatibilityDate: "2026-10-30",
        compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"],
        durableObjects: {
          COORDINATOR: { className: "Coordinator", useSQLite: true },
          ATTEMPTS: { className: "NativeAttempt", useSQLite: true }
        }
      }
    })
  ],
  test: {
    testTimeout: 60000,
    include: ["test/customer-runtime/**/*.runtime.ts"]
  }
});
