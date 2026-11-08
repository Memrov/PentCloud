import { defineConfig } from "vite-plus";
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "contracts",
    pool: "threads",
    isolate: true,
    include: ["test/native-contract-drift.test.ts"]
  }
});
