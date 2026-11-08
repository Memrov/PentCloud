import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { emptyOpenCodeModelsSnapshot } from "../opencode-models-snapshot";
import { fixtureServices } from "./fixture-services";

const dir = import.meta.dirname;

export default defineConfig({
  root: path.resolve(dir, "../.."),
  plugins: [
    emptyOpenCodeModelsSnapshot,
    cloudflareTest({
      wrangler: { configPath: path.join(dir, "wrangler.jsonc") },
      miniflare: {
        outboundService: async (request) => {
          if (new URL(request.url).origin !== "http://attempt-fixture.invalid")
            return new Response("Unexpected outbound request", { status: 502 });
          // Miniflare's Node Request and the Worker's Request have different
          // platform extensions; these services use only their shared HTTP API.
          return (
            (await fixtureServices(request as unknown as Request)) ??
            new Response("Unknown fixture service", { status: 404 })
          );
        }
      }
    })
  ],
  test: {
    name: "attempt",
    include: [path.join(dir, "*.runtime.ts")],
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
