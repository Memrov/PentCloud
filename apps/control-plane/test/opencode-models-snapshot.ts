import type { Plugin } from "vite";

export const emptyOpenCodeModelsSnapshot: Plugin = {
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
};
