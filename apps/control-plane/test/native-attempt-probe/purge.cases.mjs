import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vite-plus/test";
import { probe, fixtureResponse } from "./runtime-fixture.mjs";

describe("passive durable purge", () => {
  beforeAll(reset);
  afterAll(reset);
  it("fences nine conflicts and keeps the purge fence across a crash", async () => {
    const name = `purge-${crypto.randomUUID()}`,
      v = await probe(`purge?name=${name}`);
    for (const key of [
      "wrongRun",
      "running",
      "persistedPublishing",
      "unknown",
      "inflight",
      "localRunning",
      "publishing",
      "session",
      "reused"
    ])
      expect(v[key]).toContain("409:");
    expect(v.purged).toEqual({ runId: "local-run", purged: true });
    expect(v.repeat).toEqual(v.purged);
    expect(v.keys).toEqual([["purgedRunId", "local-run"]]);
    expect(v.finalKeys).toEqual(v.keys);
    expect(v.alarm).toBeNull();
    expect(v.tables).not.toContain("purge_probe");
    for (const table of v.tables)
      expect(table).toMatch(/^(?:_cf|__cf|sqlite_)/);
    for (const key of ["replay", "controls", "events"])
      expect(v[key]).toContain("410:");
    expect(v.execution).toEqual({
      state: "absent",
      drained: true,
      unresolvedRemote: 0,
      sessionCleanupPending: false
    });
    await env.ATTEMPTS.getByName(name)
      .evict()
      .catch(() => {});
    const cold = await probe(`after-purge?name=${name}`);
    expect(cold.keys).toEqual([["purgedRunId", "local-run"]]);
    expect(cold.alarm).toBeNull();
    expect(cold.replay).toContain("410:");
    expect(cold.inspect).toContain("410:");
    expect(cold.browser).toEqual({ available: false });
    expect(cold.readiness.drained).toBeTruthy();
  });
  it("purges an attempt that was never initialized", async () => {
    expect(await probe("purge-absent?name=purge-never-initialized")).toEqual({
      runId: "local-run",
      purged: true
    });
  });
  it("retains the fence after interrupted cleanup and finishes idempotently", async () => {
    const failure = await fixtureResponse(
      "purge-failure?name=purge-interrupted"
    );
    expect(failure.status).toBe(500);
    expect(await failure.text()).toContain("LOCAL_PURGE_CLEANUP_INTERRUPTED");
    const v = await probe("after-purge?name=purge-interrupted");
    expect(v.keys).toContainEqual(["purgedRunId", "local-run"]);
    expect(v.replay).toContain("410:");
    expect(await probe("purge-absent?name=purge-interrupted")).toEqual({
      runId: "local-run",
      purged: true
    });
    expect((await probe("after-purge?name=purge-interrupted")).keys).toEqual([
      ["purgedRunId", "local-run"]
    ]);
  });
});
