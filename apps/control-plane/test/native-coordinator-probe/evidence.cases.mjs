import { describe } from "vite-plus/test";
import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, it } from "vite-plus/test";
describe("evidence", () => {
  beforeEach(reset);
  it("retains stopped-run evidence with immutable provenance and same-run reads", async () => {
    const value = await env.COORDINATOR.getByName("global").evidenceScenario();
    assert.equal(value.listing.commit, value.afterStop.commit);
    assert.match(value.content, /retained on stop/);
    assert.equal(value.stoppedContent, value.content);
    assert.equal(value.forged, true);
    assert.equal(value.crossRun, true);
    assert.equal(value.job.evidenceCommits.length, 1);
    assert.equal(value.job.status, "interrupted");
    assert.equal(value.mainUnchanged, true);
  });
});
