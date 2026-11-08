import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { scriptedModel } from "./scripted-model";

const dir = import.meta.dirname;

export default defineConfig({
  plugins: [
    {
      // OpenCode inlines an 8 MB models.dev snapshot as one string literal,
      // also too large for the test runner. These tests run OpenCode with
      // `models: { snapshot: false }`, so the snapshot is never read.
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
      // Every outbound request from the Worker goes to the scripted model.
      miniflare: { outboundService: scriptedModel }
    })
  ],
  test: {
    name: "question-recovery",
    include: [path.join(dir, "*.runtime.ts")],
    // abortAllDurableObjects() reaches every object in the runtime.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
