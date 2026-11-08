import { test as base, expect } from "playwright/test";
import { createTestHarness, type TestHarness } from "wrangler";
import { fileURLToPath } from "node:url";

const supplied = process.env.PENTCLOUD_UI_BASE_URL;
const external = supplied ? new URL(supplied) : undefined;
if (
  external &&
  (!["127.0.0.1", "localhost", "[::1]"].includes(external.hostname) ||
    !["http:", "https:"].includes(external.protocol) ||
    external.username ||
    external.password)
)
  throw new Error("UI browser tests require a localhost URL");

export const test = base.extend<
  { resetWorker: void },
  { workerServer: TestHarness | undefined }
>({
  workerServer: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
    async ({}, use) => {
      if (external) return use(undefined);
      const server = createTestHarness({
        root: fileURLToPath(new URL("../..", import.meta.url)),
        workers: [
          {
            configPath: "scripts/browser-qa/ui-fixture.wrangler.jsonc",
            prebuiltWorkerDir: "node_modules/.cache/pentcloud-browser-worker"
          }
        ]
      });
      try {
        await server.listen();
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" }
  ],
  baseURL: async ({ workerServer }, use) => {
    await use(external?.origin ?? (await workerServer!.listen()).url.origin);
  },
  resetWorker: [
    async ({ workerServer }, use, testInfo) => {
      try {
        await use();
      } finally {
        if (workerServer) {
          if (testInfo.status !== testInfo.expectedStatus) workerServer.debug();
          await workerServer.reset();
        }
      }
    },
    { auto: true }
  ]
});
export { expect };
