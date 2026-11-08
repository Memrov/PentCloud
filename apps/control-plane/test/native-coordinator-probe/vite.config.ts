import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { emptyOpenCodeModelsSnapshot } from "../opencode-models-snapshot";
import { catalogFixture } from "./fixture-services";

const dir = import.meta.dirname;
export default defineConfig({
  root: path.resolve(dir, "../.."),
  plugins: [
    emptyOpenCodeModelsSnapshot,
    cloudflareTest({
      wrangler: { configPath: path.join(dir, "wrangler.jsonc") },
      miniflare: {
        outboundService: async (request) => {
          if (
            new URL(request.url).origin !== "http://coordinator-fixture.invalid"
          )
            return new Response("Unexpected outbound request", { status: 502 });
          return catalogFixture(request as unknown as Request);
        }
      }
    })
  ],
  test: {
    name: "coordinator",
    include: [path.join(dir, "*.runtime.mjs")],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
