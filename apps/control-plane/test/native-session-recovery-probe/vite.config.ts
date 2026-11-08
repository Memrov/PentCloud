import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { scriptedModel } from "./scripted-model";
import { emptyOpenCodeModelsSnapshot } from "../opencode-models-snapshot";

const dir = import.meta.dirname;

export default defineConfig({
  root: path.resolve(dir, "../.."),
  plugins: [
    emptyOpenCodeModelsSnapshot,
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
