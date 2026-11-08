import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fixtureService } from "./fixture-services";

const dir = import.meta.dirname;

export default defineConfig({
  plugins: [
    {
      // OpenCode inlines an 8 MB models.dev snapshot as one string literal,
      // larger than the test runner can send to workerd. Attempts run OpenCode
      // without the snapshot, so it is never read.
      name: "empty-opencode-models-snapshot",
      enforce: "pre",
      transform: (code, id) =>
        id.includes("/@opencode/core/dist/") &&
        code.includes("var snapshot_default = '")
          ? code.replace(
              /^var snapshot_default = '.*';$/m,
              "var snapshot_default = '{}';"
            )
          : null
    },
    cloudflareTest({
      wrangler: { configPath: path.join(dir, "wrangler.jsonc") },
      // The probe's fake model and curl echo answer every outbound request.
      miniflare: {
        // Miniflare's Node-side Request type; the same object at runtime.
        outboundService: async (request) =>
          (await fixtureService(request as unknown as Request)) ??
          new Response("Unexpected outbound request", { status: 502 })
      }
    })
  ],
  test: {
    name: "attempt",
    include: [path.join(dir, "*.runtime.ts")],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
