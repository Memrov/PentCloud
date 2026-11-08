import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/runtime/router-fixture.ts",
      miniflare: {
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          CONTROL_TOKEN: "runtime-test-control-token",
          OPENCODE_GO_API_KEY: "runtime-test-go-token",
          ACCESS_TEAM_DOMAIN: "https://access.invalid",
          ACCESS_AUD: "runtime-test-audience",
          ARTIFACTS_NAMESPACE: "fixture-artifacts"
        },
        durableObjects: {
          COORDINATOR: { className: "RouterControl", useSQLite: true },
          ATTEMPTS: { className: "RouterAttempt", useSQLite: true }
        }
      }
    })
  ],
  test: { include: ["test/runtime/**/*.runtime.ts"] }
});
