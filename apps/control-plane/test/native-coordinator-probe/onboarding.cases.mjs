import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vite-plus/test";
describe("onboarding operation errors", () => {
  beforeEach(reset);
  it("redacts asynchronous provider failures at the Coordinator RPC boundary", async () => {
    const value =
      await env.COORDINATOR.getByName("global").bountyCheckErrorForTest();
    expect(value.error).toContain("403:");
    expect(value.error).toContain("[redacted]");
    expect(value.error).not.toContain("private-bounty-rejection");
  });
});
