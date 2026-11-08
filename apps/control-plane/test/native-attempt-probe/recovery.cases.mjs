import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vite-plus/test";
import { probe } from "./runtime-fixture.mjs";

const evict = async (name) => {
  await env.ATTEMPTS.getByName(name)
    .evict()
    .catch(() => {});
};
describe("durable attempt recovery", () => {
  beforeAll(reset);
  afterAll(reset);
  it("retains a platform recovery fence until attested rearming", async () => {
    const v = await probe("platform-recovery");
    expect(v.before).toMatchObject({
      recovery: { sealed: true },
      drained: false,
      unresolvedRemote: 1
    });
    for (const key of [
      "staleRejected",
      "unknownRejected",
      "callFenced",
      "controlsFenced",
      "lifecycleStartupSkipped"
    ])
      expect(v[key]).toBeTruthy();
    expect(v.rearmed.rearmed).toBeTruthy();
    expect(v.after).not.toHaveProperty("recovery");
    expect(v.after.unresolvedRemote).toBe(0);
  });
  it("keeps controls fenced during backoff without starting the lifecycle", async () => {
    const v = await probe("platform-backoff");
    expect(v.controlsFenced).toBeTruthy();
    expect(v.lifecycleStartupSkipped).toBeTruthy();
    expect(v.after.canReply).toBeTruthy();
  });
  it("persists unresolved platform work across a real crash", async () => {
    const name = `platform-${crypto.randomUUID()}`;
    const v = await probe(`platform-recovery-held?name=${name}`);
    expect(v.lifecycleStartupSkipped).toBeTruthy();
    expect(v.controlsFenced).toBeTruthy();
    await evict(name);
    const cold = await probe(`after-platform-eviction?name=${name}`);
    expect(cold.before).toMatchObject({
      recovery: { sealed: true },
      drained: false,
      unresolvedRemote: 1
    });
    expect(cold.controlsFenced).toBeTruthy();
    expect(cold.lifecycleStartupSkipped).toBeTruthy();
    expect(cold.cancelled).toMatchObject({
      state: "cancelled",
      drained: false,
      unresolvedRemote: 1
    });
  });
  it("resumes submitted toolbox work after a crash without duplicate model turns", async () => {
    const name = `toolbox-${crypto.randomUUID()}`,
      v = await probe(`toolbox-eviction?name=${name}`);
    expect(v.users).toBe(1);
    expect(v.models).toBe(1);
    expect(v.pending).toHaveLength(1);
    await evict(name);
    const cold = await probe(`after-toolbox-eviction?name=${name}`);
    expect(cold.queued).toBe(1);
    expect(cold.afterAlarm.wakes).toBe(0);
    expect(cold.afterAlarm.models).toBe(1);
    expect(cold.modelsBefore).toBe(1);
    expect(cold.afterAlarm.readies).toBe(cold.readiesBefore);
    expect(cold.modelsAfter).toBe(2);
    expect(cold.users).toBe(1);
    expect(cold.calls).toBe(0);
  });
  it.each([
    "sdk-toolbox-cold",
    "toolbox-activity",
    "toolbox-generation-loss",
    "toolbox-cleanup-lost",
    "toolbox-upstream-conflict",
    "toolbox-legacy-session"
  ])("preserves toolbox lifecycle authority: %s", async (kind) => {
    const v = await probe(kind);
    if (kind === "sdk-toolbox-cold") {
      expect(v.before.readies).toBeGreaterThan(0);
      expect(v.before.initializes).toBe(0);
      expect(v.before.modelRequests).toBe(0);
      expect(v.after.generation).toBe("fixture-generation");
      expect(v.after.session.generation).toBe("fixture-generation");
      expect(v.after.catalog.tools).toHaveLength(126);
      expect(v.after).toMatchObject({
        modelRequests: 1,
        initializes: 2,
        deletes: 1,
        modelsAtPartial: 0,
        partialCatalogWasPinned: false
      });
    } else if (kind === "toolbox-activity")
      expect(v).toEqual({
        withoutOwnership: 0,
        active: 1,
        drained: 1,
        held: 2,
        readies: 0
      });
    else if (kind === "toolbox-generation-loss") {
      expect(v.blocked).toBe(3);
      expect(v.initializes).toBe(1);
      expect(v.firstInitializes).toBe(1);
      expect(v.execution).toMatchObject({
        unresolvedRemote: 1,
        drained: false
      });
      expect(v.receipts[0].state).toBe("unknown");
      expect(v.session.generation).toBe("fixture-generation");
      expect(v.cancelled).toMatchObject({
        drained: false,
        unresolvedRemote: 1
      });
      expect(v.reconciled.drained).toBeTruthy();
      expect(v.sessionAfterReconciled).toBeFalsy();
    } else if (kind === "toolbox-cleanup-lost") {
      expect(v.after.drained).toBeTruthy();
      expect(v.sessionHeld).toBeFalsy();
      expect(v.initializes).toBe(1);
      expect(v.deletes).toBe(0);
    } else if (kind === "toolbox-upstream-conflict") {
      expect(v.after.drained).toBe(false);
      expect(v.sessionHeld).toBeTruthy();
      expect(v.initializes).toBe(1);
      expect(v.recovered.drained).toBeTruthy();
      expect(v.sessionAfterRecovery).toBeFalsy();
    } else {
      expect(v.after.drained).toBe(false);
      expect(v.sessionHeld).toBeTruthy();
      expect(v.initializes).toBe(0);
      expect(v.readies).toBe(0);
    }
  });
  it("reconciles unknown remote mutations after a crash with exact proof", async () => {
    const name = `unknown-${crypto.randomUUID()}`,
      v = await probe(`unknown?name=${name}`);
    expect(v).toMatchObject({
      firstLost: true,
      newCallFenced: true,
      starts: 1,
      before: { drained: false },
      cancelled: { drained: false }
    });
    await evict(name);
    const cold = await probe(`after-eviction?name=${name}`);
    expect(cold).toMatchObject({
      before: { drained: false, unresolvedRemote: 1 },
      newCallFenced: true,
      starts: 1,
      wrongProofRejected: true,
      missingAttestationRejected: true,
      after: { drained: true, unresolvedRemote: 0 }
    });
  });
  it("reuses the MCP session and retires it only after remote proof across a crash", async () => {
    const name = `session-${crypto.randomUUID()}`,
      v = await probe(`session?name=${name}`);
    expect(v).toMatchObject({
      lost: true,
      savedBeforeMutation: true,
      initializes: 1,
      deletesBefore: 0,
      before: { drained: false }
    });
    await evict(name);
    const cold = await probe(`after-session-eviction?name=${name}`);
    expect(cold).toMatchObject({
      before: { drained: false },
      reusedSid: true,
      wireIdsUnique: true,
      collision: false,
      oldPendingRetained: true,
      cancelOnlyNew: true,
      initializes: 1,
      deletes: 1,
      deleteAfterProof: true,
      after: { drained: true }
    });
    expect(cold.saved).toBeFalsy();
  });
});
