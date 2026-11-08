/// <reference types="@cloudflare/vitest-plugin/types" />
import { exports } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type {
  ToolPackService,
  ToolPackScope
} from "../../../../shared/tool-packs";
const customer = exports as unknown as {
  default: Fetcher;
  ToolPackGateway: ToolPackService;
  Coordinator: {
    getByName(name: string): {
      onboardingExport(): Promise<{ targets: unknown[] }>;
    };
  };
};
it("serves first-run status from the complete customer Worker without exposing application APIs", async () => {
  const status = await customer.default.fetch(
    "https://customer.test/v1/ui/setup"
  );
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ access: false, ready: false });
  expect(
    (await customer.default.fetch("https://customer.test/v1/ui/runs")).status
  ).toBe(401);
});
it("provides the private tool gateway as a native loopback capability", async () => {
  const denied = await customer.ToolPackGateway.run(
    {
      runId: "run-check",
      attemptId: "attempt-check",
      role: "pentester"
    } as ToolPackScope,
    { pack: "http", request: {} },
    {}
  );
  expect(denied).toMatchObject({ rejected: true, notExecuted: true });
  const state = await customer.Coordinator.getByName(
    "customer-constructor"
  ).onboardingExport();
  expect(state.targets).toEqual([]);
});
