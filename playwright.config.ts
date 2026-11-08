import { defineConfig } from "playwright/test";

const baseURL = process.env.PENTCLOUD_UI_BASE_URL ?? "http://127.0.0.1:4173";
const url = new URL(baseURL);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password
)
  throw new Error("UI browser tests require a localhost URL");

export default defineConfig({
  testDir: ".",
  testMatch: [
    "apps/control-plane/test/*-browser.pw.ts",
    "scripts/test-native-ui.mjs"
  ],
  outputDir: "node_modules/.cache/pentcloud-browser-results",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: url.origin,
    actionTimeout: 30_000,
    screenshot: "only-on-failure"
  },
  // An explicitly supplied local server remains available for the native UI smoke.
  webServer: process.env.PENTCLOUD_UI_BASE_URL
    ? undefined
    : {
        command:
          "vite build --config scripts/browser-qa/ui-fixture.config.mts --mode browser-fixture && vite preview --config scripts/browser-qa/ui-fixture.config.mts --mode browser-fixture",
        url: url.origin,
        reuseExistingServer: false,
        timeout: 120_000
      }
});
