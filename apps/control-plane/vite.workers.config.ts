import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Separate Worker/binding projects share the root test run and the focused gate.
export const workerProjects = [
  "test/runtime/vite.config.ts",
  "test/native-session-recovery-probe/vite.config.ts",
  "test/native-attempt-probe/vite.config.ts"
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default defineConfig({
  root: import.meta.dirname,
  test: { projects: workerProjects }
});
