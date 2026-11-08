import { defineConfig } from "vitest/config";

// Each project runs in the Workers runtime with its own Worker and bindings,
// as cloudflare/agents organises its Durable Object tests.
export default defineConfig({
  test: {
    projects: [
      "test/runtime/vitest.config.ts",
      "test/native-session-recovery-probe/vitest.config.ts"
    ]
  }
});
