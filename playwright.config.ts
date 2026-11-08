import { defineConfig } from "playwright/test";

export default defineConfig({
  globalSetup: "./scripts/browser-qa/build-fixture.mts",
  testDir: ".",
  testMatch: [
    "apps/control-plane/test/*-browser.pw.ts",
    "scripts/test-native-ui.mjs"
  ],
  outputDir: "node_modules/.cache/pentcloud-browser-results",
  fullyParallel: false,
  workers: 2,
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "node_modules/.cache/pentcloud-browser-report",
        open: "never"
      }
    ]
  ],
  timeout: 30_000,
  use: {
    actionTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  }
});
