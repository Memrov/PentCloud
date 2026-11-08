import assert from "node:assert/strict";
import { exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeAll, afterAll, describe, it } from "vite-plus/test";
const fetch = (url) => exports.default.fetch(new Request(url));
describe("immutable evidence", () => {
  beforeAll(reset);
  afterAll(reset);
  it("retains exact files, checkpoints, publication, cancellation and finalization fences", async () => {
    const response = await fetch(
      "http://attempt-fixture.invalid/evidence-checkpoints"
    );
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    assert.equal(value.before, null, "a checkpoint must not finalize an agent");
    assert.equal(
      value.sameCommitRetried,
      true,
      "lost push acknowledgment retries exactly the existing commit"
    );
    assert.deepEqual(
      value.unavailable,
      [],
      "recovered publication is not incomplete file collection"
    );
    assert.equal(value.evidenceFiles.length, 1);
    assert.match(value.raw, /retained evidence/);
    assert.ok(!value.raw.includes("local-probe-go"));
    assert.equal(value.terminalParent, value.recovered.commit);
    assert.equal(value.terminal.status, "completed");
    assert.ok(value.registrations.length >= 1);
    assert.equal(value.noLatePublication, true);
    assert.equal(value.starts, 0);
    const transferred = await fetch(
      "http://attempt-fixture.invalid/evidence-transfer"
    );
    const bridge = await transferred.json();
    assert.equal(transferred.status, 200, JSON.stringify(bridge));
    assert.equal(bridge.file.sha256, bridge.expectedHash);
    assert.equal(bridge.actualHash, bridge.expectedHash);
    assert.ok(bridge.checkpoint.length > 0);
    assert.equal(bridge.starts, 0);
    assert.equal(bridge.renameFenced, true);
    console.log(
      "native agent file tools, exact bytes and immutable evidence: passed"
    );
    console.log(
      "native evidence checkpoint, lost push reply, terminal publication and cancellation: passed"
    );
    const incompleteResponse = await fetch(
        "http://attempt-fixture.invalid/evidence-incomplete-image"
      ),
      incomplete = await incompleteResponse.json();
    assert.equal(incompleteResponse.status, 200, JSON.stringify(incomplete));
    assert.equal(
      incomplete.unavailable.length,
      1,
      "genuinely missing image remains disclosed after checkpoint recovery"
    );
    assert.equal(incomplete.unavailable[0].receiptId, "incomplete");
    const scratchResponse = await fetch(
        "http://attempt-fixture.invalid/evidence-pack-scratch"
      ),
      scratch = await scratchResponse.json();
    assert.equal(scratchResponse.status, 200, JSON.stringify(scratch));
    assert.equal(scratch.calls, 1);
    assert.equal(scratch.checkpointBeforeDispatch, true);
    assert.equal(scratch.inputHash, scratch.expectedHash);
    assert.equal(scratch.captured.sha256, scratch.expectedHash);
    assert.equal(scratch.escapeDenied, true);
    assert.equal(scratch.symlinkDenied, true);
    console.log(
      "native scratch binary transfer, immutable input and replay fences: passed"
    );
    const largeResponse = await fetch(
        "http://attempt-fixture.invalid/evidence-pack-large"
      ),
      large = await largeResponse.json();
    assert.equal(largeResponse.status, 200, JSON.stringify(large));
    assert.equal(large.restored, true);
    assert.ok(large.files.every((f) => f.size <= 2 * 1024 * 1024));
    assert.ok(large.parts.every((p) => large.files.some((f) => f.path === p)));
    assert.ok(large.checkpoint.length);
    console.log(
      "native large-result evidence paths and exact Unicode bytes: passed"
    );
    const stopped = await fetch(
      "http://attempt-fixture.invalid/evidence-cancel-push"
    );
    const cancel = await stopped.json();
    assert.equal(stopped.status, 200, JSON.stringify(cancel));
    assert.ok(cancel.evidence?.commit);
    assert.equal(cancel.pushes, 1);
    assert.equal(cancel.cancelFenced, true);
    assert.equal(cancel.registrations.length, 1);
    for (const scenario of ["evidence-cancel-commit", "evidence-failed-push"]) {
      const response = await fetch(
          "http://attempt-fixture.invalid/" + scenario
        ),
        value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      assert.ok(value.registrations.length > 0);
      assert.equal(value.execution.drained, true);
      assert.equal(value.starts, 0);
      assert.ok(!value.execution.result.outputCommit);
    }
    const finalized = await fetch(
      "http://attempt-fixture.invalid/evidence-finalization"
    );
    const final = await finalized.json();
    assert.equal(finalized.status, 200, JSON.stringify(final));
    assert.equal(final.result.status, "completed", JSON.stringify(final));
    assert.equal(final.streamsOpened, 2);
    assert.equal(final.streamsStopped, 2);
    assert.deepEqual(final.operations, [
      final.initialId,
      `finalize-${final.initialId}`
    ]);
    assert.equal(final.mutationFenced, true);
    assert.equal(final.fileMutationFenced, true);
    assert.equal(final.javascriptFenced, true);
    assert.equal(final.starts, 0);
    console.log(
      "native cancellation-after-push and bounded same-session finalization: passed"
    );
    const compatResponse = await fetch(
        "http://attempt-fixture.invalid/evidence-gateway-compat"
      ),
      compat = await compatResponse.json();
    assert.equal(compatResponse.status, 200, JSON.stringify(compat));
    assert.equal(compat.pending, true);
    assert.equal(compat.starts, 0);
  });
});
