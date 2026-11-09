import { describe } from "vite-plus/test";
import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vite-plus/test";

describe("coordinator", () => {
  let coordinator, coordinators, attempts;
  const url = new URL("http://coordinator-fixture.invalid");
  const rpcResult = async (promise) => await promise;
  const deadline = async (promise, timeout) => {
    let settled = false;
    const result = promise.finally(() => {
      settled = true;
    });
    // Attach the rejection handler before polling so a failing RPC is observed.
    result.catch(() => {});
    await expect.poll(() => settled, { timeout }).toBe(true);
    return await result;
  };
  beforeEach(async () => {
    await reset();
    coordinators = env.COORDINATOR;
    coordinator = coordinators.getByName("global");
    attempts = env.ATTEMPTS;
  });
  it("concurrent lazy imports each legacy row once", async () => {
    const value = await rpcResult(coordinator.nativeStreamsScenario());
    assert.match(value.migrationFailure, /injected import rollback/);
    assert.deepEqual(value.afterFailure, { legacy: 2, cursor: 0 });
    assert.equal(
      value.importedCursor,
      2,
      "concurrent lazy imports each legacy row once"
    );
    assert.match(value.claimFailure, /injected claim rollback/);
    assert.deepEqual(value.rollback, {
      cursor: 2,
      status: "created",
      active: null
    });
    assert.match(value.fresh.text, /id: 0\ndata: /);
    assert.match(value.fresh.text, /"timestamp":100/);
    assert.match(value.fresh.text, /\[redacted\]/);
    assert.doesNotMatch(value.fresh.text, /fixture-key|event: activity/);
    assert.doesNotMatch(value.reconnect.text, /id: 0\n/);
    assert.match(value.reconnect.text, /id: 1\n/);
    assert.equal(
      value.old.status,
      410,
      "legacy global cursors require a reload onto protocol 2"
    );
    assert.equal(
      value.streaming,
      "streaming",
      "completed runs stay live for revision"
    );
    assert.equal(
      (value.revised.text.match(/"type":"run.started"/g) || []).length,
      2
    );
    assert.match(value.lateResult, /purged/);
    assert.match(value.lateAppend, /purged/);
    assert.match(value.tail, /event: done/);
    assert.match(value.purgeFailure, /injected purge commit rollback/);
    assert.deepEqual(value.failedPurge, { state: "streaming", tombstones: 0 });
    assert.equal(value.purged, null);
    assert.equal(value.legacyRemaining, 0);
    assert.equal(value.untouchedLegacy, 1);
  });
  it("native durable replay survives coordinator eviction", async () => {
    const before = await rpcResult(
      coordinator.streamRestartScenario(true, undefined)
    );
    await coordinator.abortForTest().catch(() => undefined);
    coordinator = coordinators.getByName("global");
    const after = await rpcResult(
        coordinator.streamRestartScenario(false, undefined)
      ),
      resumed = await rpcResult(coordinator.streamRestartScenario(false, "0"));
    assert.equal(
      after.text,
      before.text,
      "native durable replay survives coordinator eviction"
    );
    assert.doesNotMatch(resumed.text, /id: 0\n/);
    assert.match(resumed.text, /id: 1\n/);
  });

  it("durable heartbeat reconciles a lost completion then admits FIFO after drain", async () => {
    await rpcResult(coordinator.seed(2, "coder", true));
    await rpcResult(coordinator.fire());
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).deliveries,
      1
    );
    const candidate = await rpcResult(
      coordinator.prepareCandidate("job-0", {})
    );
    await rpcResult(coordinator.recoveryAfterReset());
    await coordinator.abortForTest().catch(() => undefined);
    coordinator = coordinators.getByName("global");
    // Persist only the remote result: no push event exists and the old completion RPC was lost.
    await attempts.getByName(candidate.id).finish(candidate);
    let next;
    await expect
      .poll(
        async () => {
          next = await rpcResult(attempts.getByName("job-1").inspect());
          return Boolean(next.deliveries === 1);
        },
        { timeout: 15000, interval: 100 }
      )
      .toBe(true);
    assert.equal(
      next.deliveries,
      1,
      "durable heartbeat reconciles a lost completion then admits FIFO after drain"
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).starts,
      1,
      "recovery consumes the settled receipt without restarting work"
    );
    const settled = await rpcResult(coordinator.snapshot());
    assert.equal(
      settled.jobs.find((job) => job.id === "job-0").status,
      "completed"
    );
    assert.equal(
      settled.records.find((row) => row.key === "run:run-0").value.headCommit,
      candidate.outputCommit
    );
    assert.equal(
      await rpcResult(coordinator.mainHead("run-0")),
      candidate.outputCommit,
      "durable recovery publishes the accepted candidate after eviction without either notification"
    );
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(coordinator.cancelRun("run-1"));
    await rpcResult(attempts.getByName("job-1").release());
  });
  it("queue snapshot never starts recovery", async () => {
    const value = await rpcResult(coordinator.readonlyQueueScenario());
    assert.deepEqual(value.cold.pending, []);
    assert.deepEqual(
      value.coldJobs,
      [],
      "queue snapshot never starts recovery"
    );
    assert.deepEqual(
      value.pending.map((job) => job.id),
      ["job-1", "job-0"],
      "pending projection follows authoritative admission order"
    );
  });
  it("native breaker sees the original rejected handoff", async () => {
    await coordinator.nativeMemoryHandoff().catch(() => undefined);
    coordinator = coordinators.getByName("global");
    let diagnostics;
    await expect
      .poll(
        async () => {
          diagnostics = await rpcResult(coordinator.diagnostics());
          return Boolean(diagnostics.coordinator.recovery);
        },
        { timeout: 2000, interval: 20 }
      )
      .toBe(true);
    assert.equal(
      diagnostics.coordinator.recovery?.sealed,
      false,
      "native breaker sees the original rejected handoff"
    );
    assert.ok(
      diagnostics.coordinator.recovery.nextTime > Date.now(),
      "native breaker persists its recovery backoff after reset"
    );
    assert.equal(
      (await rpcResult(coordinator.platformRecoverySchedules())).recover,
      1,
      "the rejected handoff retains one native wake"
    );
  });
  it("startup installs the one durable native recovery job", async () => {
    const value = await rpcResult(coordinator.nativeWakeScenario());
    assert.ok(
      value.initial,
      "startup installs the one durable native recovery job"
    );
    assert.equal(value.initial.singleflight, true);
    assert.equal(value.initial.recoveryLoop, true);
    assert.equal(value.firstPasses, 1);
    assert.equal(value.busyPasses, 1);
    assert.equal(
      value.peak,
      1,
      "same-ID wake never overlaps detached recovery"
    );
    assert.ok(
      value.busyWake.time <= value.busyRequestedAt + 1000,
      "wake while busy durably advances the existing heartbeat"
    );
    assert.ok(value.heartbeat, "busy dispatch leaves a durable heartbeat");
    assert.equal(
      value.passes,
      2,
      "heartbeat runs a fresh pass after the handoff settles"
    );
    assert.equal(
      value.rolledBack,
      true,
      "admission and native wake retime roll back together"
    );
    assert.match(value.failure, /injected alarm rearm failure/);
    assert.ok(
      value.retained,
      "rearm failure preserves the native wake for retry"
    );
  });
  it("bounty gate", async () => {
    const value = await rpcResult(coordinator.bountyGateScenario());
    assert.deepEqual(value.denied, [
      "scope.names",
      "scope.search",
      "scope.preview",
      "scope.import"
    ]);
    assert.deepEqual(
      Object.fromEntries(
        value.status.connections.map((c) => [c.platform, c.status])
      ),
      {
        hackerone: "missing",
        intigriti: "missing",
        bugcrowd: "development",
        yeswehack: "development"
      }
    );
    assert.deepEqual(value.unavailable, [
      "bugcrowd:bounty.check",
      "bugcrowd:scope.preview",
      "bugcrowd:scope.import",
      "yeswehack:bounty.check",
      "yeswehack:scope.preview",
      "yeswehack:scope.import"
    ]);
  });
  it("package-only run deletion does not require a Kali binding", async () => {
    const value = await rpcResult(
      coordinator.directDeleteScenario("tool-packs")
    );
    assert.equal(
      value.error,
      undefined,
      "package-only run deletion does not require a Kali binding"
    );
    assert.equal(value.clears, 0);
    assert.equal(
      value.before.records.find((row) => row.key === "purged:run:run-0").value
        .id,
      "run-0"
    );
  });
  it("recorded work", async () => {
    const value = await rpcResult(coordinator.recordedWorkScenario());
    assert.ok(value.crossRun && value.self && value.wrongRole && value.stopped);
    assert.equal(value.catalog.attempts.length, 1);
    assert.equal(value.catalog.attempts[0].status, "failed");
    assert.equal(value.catalog.attempts[0].error, "TOKEN=[redacted]");
    assert.match(
      value.source.messages[0].content[0].text,
      /differs from handoff/
    );
  });
  it("findings", async () => {
    const value = await rpcResult(coordinator.findingsScenario());
    assert.equal(value.legacy.bundle, undefined);
    assert.equal(value.bundle.bundle.document.findings.length, 1);
    assert.equal(value.bundle.commit, "a".repeat(40));
    assert.deepEqual(value.latest, value.bundle);
    assert.equal(value.older.jobId, "earlier-report");
    assert.equal(value.older.commit, "b".repeat(40));
    assert.equal(value.older.bundle, undefined);
    assert.match(value.wrong, /accepted reporter/);
    assert.match(value.missing, /reference/);
  });

  it("catalog works with the actual Workerd fetch implementation", async () => {
    const value = await rpcResult(
      coordinator.catalogRuntime(url.origin, false)
    );
    assert.deepEqual(
      value,
      [
        { route: "go", models: 1 },
        { route: "console", models: 1 }
      ],
      "catalog works with the actual Workerd fetch implementation"
    );
    const redirects = await rpcResult(
      coordinator.catalogRuntime(url.origin, true)
    );
    assert.ok(
      redirects.every((value) => value.error.includes("HTTP 302")),
      "catalog redirects are rejected without following or sending keys"
    );
  });
  it("preparation never advances accepted Git", async () => {
    const value = await rpcResult(
      coordinator.earlyChatScenario(false, false, false, false)
    );
    assert.deepEqual(value.before.primary, {
      prepared: true,
      preparations: 1,
      cancelled: false,
      starts: 0
    });
    assert.ok(
      value.workDenied && value.unselectedDenied && value.unknownDenied
    );
    assert.match(value.selectedRead, /Owned project configuration/);
    assert.equal(
      value.headAfterRead,
      value.before.head,
      "preparation never advances accepted Git"
    );
    assert.equal(
      value.unknownHeld.starts,
      0,
      "an unknown scanner outcome cannot be acknowledged away"
    );
    assert.equal(
      value.held.starts,
      0,
      "drained failure waits for explicit coverage acknowledgement"
    );
    assert.equal(
      value.after.starts,
      1,
      "the prepared primary is admitted once after acknowledgement"
    );
    const admitted = value.snapshot.records.find(
      (row) => row.key.startsWith("launch:") && row.value.role === "primary"
    ).value;
    assert.equal(
      admitted.targetConfig.access.headerBinding,
      "PENTCLOUD_TARGET_TEST_HEADERS",
      "admission preserves the pinned native target bindings"
    );
    const beforeRun = value.before.snapshot.records.find(
      (row) => row.key === "run:run-0"
    ).value;
    const afterRun = value.snapshot.records.find(
      (row) => row.key === "run:run-0"
    ).value;
    assert.equal(beforeRun.phase, "primary");
    assert.equal(afterRun.phase, "primary");
    assert.equal(afterRun.discoveryDrained, true);
    assert.equal(afterRun.discoveryAcknowledged, true);
  });
  for (const terminal of [false, true])
    it(`coordinator 14: earlyChatScenario (terminal=${terminal})`, async () => {
      const value = await rpcResult(
        coordinator.earlyChatScenario(true, terminal)
      );
      assert.equal(value.before.primary.preparations, 1);
      assert.equal(value.after.starts, 0);
      assert.equal(
        value.after.cancelled,
        true,
        "Stop includes the queued native conversation"
      );
    });
  it("preparation transcript remains readable after admission rejection", async () => {
    const value = await rpcResult(
      coordinator.earlyChatScenario(false, false, false, true)
    );
    const primary = value.snapshot.jobs.find((job) => job.id !== "job-0");
    assert.equal(primary.status, "invalid_result");
    assert.equal(
      primary.nativeSession,
      true,
      "preparation transcript remains readable after admission rejection"
    );
    assert.equal(
      value.after.cancelled,
      true,
      "input rejection aborts the prepared host immediately"
    );
  });
  it("never-admitted discovery has no scanner work to drain", async () => {
    const value = await rpcResult(
      coordinator.earlyChatScenario(false, false, true, false)
    );
    const discovery = value.rejected.jobs.find((job) => job.id === "job-1");
    assert.equal(discovery.status, "invalid_result");
    const run = value.rejected.records.find(
      (row) => row.key === "run:run-1"
    ).value;
    assert.equal(
      run.discoveryDrained,
      true,
      "never-admitted discovery has no scanner work to drain"
    );
    assert.equal(value.ackError, undefined);
    assert.equal(
      value.after.starts,
      1,
      "acknowledgement releases a safely rejected queued discovery"
    );
    assert.equal(
      value.input.context.materials.files[0].id,
      "preparation-file",
      "initial files reach actual execution even if discovery could not admit them"
    );
  });
  it("wrong execution mode is rejected instead of spinning forever", async () => {
    const value = await rpcResult(coordinator.mismatchedDiscovery());
    const job = value.snapshot.jobs.find((job) => job.id === "job-0");
    const run = value.snapshot.records.find(
      (row) => row.key === "run:run-0"
    ).value;
    assert.equal(
      job.status,
      "invalid_result",
      "wrong execution mode is rejected instead of spinning forever"
    );
    assert.equal(run.phase, "setup");
    assert.equal(run.discoveryDrained, true);
    assert.equal(
      value.main,
      run.inputCommit,
      "rejected output never reaches accepted main"
    );
    assert.equal(
      value.attempt.starts,
      1,
      "reconciliation never restarts discovery or inference"
    );
  });
  it("Lifecycle/API wakes honor the native backoff time", async () => {
    await rpcResult(coordinator.seed(2, "coder", false));
    await coordinator.onAlarmMemoryLimit({
      sealed: false,
      nextTime: Date.now() + 60000
    });
    await rpcResult(coordinator.repeatDelivery("job-0"));
    await rpcResult(coordinator.recoverNow());
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).deliveries,
      0,
      "Lifecycle/API wakes honor the native backoff time"
    );
    assert.equal(
      (await rpcResult(coordinator.snapshot())).records.find(
        (row) => row.key === "active"
      ),
      undefined
    );
    await rpcResult(coordinator.endPlatformBackoff());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).deliveries,
      1,
      "due backoff resumes the original FIFO attempt"
    );
  });
  it("a sealed attempt cannot relaunch its model or mutations", async () => {
    await rpcResult(coordinator.seed(2, "coder", false));
    await rpcResult(attempts.getByName("job-0").failRPC(true));
    await deadline(rpcResult(coordinator.repeatDelivery("job-0")), 2500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await attempts.getByName("job-0").platformMemory(true, 1);
    const attempt = await rpcResult(coordinator.diagnostics());
    assert.equal(attempt.active.recovery.sealed, true);
    await rpcResult(coordinator.recoverNow());
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).deliveries,
      1,
      "a sealed attempt cannot relaunch its model or mutations"
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).deliveries,
      0,
      "a sealed scanner hold keeps the global slot"
    );
    await coordinator.onAlarmMemoryLimit({ sealed: true });
    const sealed = await rpcResult(coordinator.diagnostics());
    assert.equal(sealed.coordinator.recovery.sealed, true);
    assert.equal(sealed.backlog.waiting, 1);
    assert.equal(
      (await rpcResult(coordinator.platformRecoverySchedules())).recover,
      0,
      "sealing cancels the ordinary recovery heartbeat"
    );
    const marker = sealed.coordinator.recovery.observedAt;
    assert.match(
      (
        await rpcResult(
          coordinator.rejection("rearmPlatformRecovery", [
            { scope: "coordinator", observedAt: marker - 1 }
          ])
        )
      ).error,
      /409:/,
      "stale platform recovery cannot rearm"
    );
    assert.match(
      (
        await rpcResult(
          coordinator.rejection("rearmPlatformRecovery", [
            { scope: "coordinator", observedAt: marker }
          ])
        )
      ).error,
      /409:/,
      "unknown scanner outcomes prevent platform rearm"
    );
    const held = await rpcResult(coordinator.snapshot());
    assert.equal(
      held.records.find((row) => row.key === "active").value.id,
      "job-0"
    );
    await attempts.getByName("job-0").platformMemory(true, 0);
    const resolved = await rpcResult(coordinator.diagnostics());
    assert.equal(
      (
        await rpcResult(
          coordinator.rearmPlatformRecovery({
            scope: "coordinator",
            observedAt: marker
          })
        )
      ).rearmed,
      true
    );
    assert.equal(
      (await rpcResult(coordinator.platformRecoverySchedules())).recover,
      1,
      "explicit resume restores the single native recovery job"
    );
    assert.equal(
      (await rpcResult(coordinator.diagnostics())).coordinator.recovery,
      undefined
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).deliveries,
      1,
      "Coordinator resume preserves the separate Attempt seal"
    );
    await rpcResult(attempts.getByName("job-0").failRPC(false));
    assert.equal(
      (
        await rpcResult(
          coordinator.rearmPlatformRecovery({
            scope: "attempt",
            observedAt: resolved.active.recovery.observedAt,
            attemptId: "job-0"
          })
        )
      ).rearmed,
      true
    );
    await rpcResult(coordinator.recoverNow());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).deliveries,
      2,
      "the operator resumes the same pinned attempt once"
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).deliveries,
      0,
      "resume retains serial ownership"
    );
  });
  it("immediate RPC failure waits for a durable wake instead of recursively relaunching", async () => {
    await rpcResult(coordinator.seed(2, "coder", false));
    await rpcResult(attempts.getByName("job-0").failRPC(true));
    await deadline(rpcResult(coordinator.repeatDelivery("job-0")), 2500);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const failed = await rpcResult(attempts.getByName("job-0").inspect());
    assert.equal(
      failed.deliveries,
      1,
      "immediate RPC failure waits for a durable wake instead of recursively relaunching"
    );
    const held = await rpcResult(coordinator.snapshot());
    assert.equal(
      held.records.find((row) => row.key === "active").value.id,
      "job-0",
      "RPC failure retains the durable global owner"
    );
    assert.equal(held.jobs.find((job) => job.id === "job-0").status, "running");
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).deliveries,
      0,
      "failure cannot release the toolbox slot"
    );
    await rpcResult(attempts.getByName("job-0").failRPC(false));
    await rpcResult(coordinator.recoverNow());
    let resumed;
    await expect
      .poll(
        async () => {
          resumed = await rpcResult(attempts.getByName("job-0").inspect());
          return Boolean(resumed.deliveries === 2);
        },
        { timeout: 1000, interval: 10 }
      )
      .toBe(true);
    assert.equal(
      resumed.deliveries,
      2,
      "the next explicit recovery wake retries the same owner once"
    );
    assert.deepEqual(
      resumed.input,
      failed.input,
      "retry uses the exact immutable launch input"
    );
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(attempts.getByName("job-0").release());
    await rpcResult(coordinator.cancelRun("run-1"));
  });
  it("successful completion wakes FIFO immediately without waiting for the 15-second schedule", async () => {
    await rpcResult(coordinator.seed(2, "coder", true));
    await rpcResult(coordinator.fire());
    await rpcResult(attempts.getByName("job-0").release());
    let next;
    await expect
      .poll(
        async () => {
          next = await rpcResult(attempts.getByName("job-1").inspect());
          return Boolean(next.deliveries === 1);
        },
        { timeout: 1000, interval: 10 }
      )
      .toBe(true);
    assert.equal(
      next.deliveries,
      1,
      "successful completion wakes FIFO immediately without waiting for the 15-second schedule"
    );
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(coordinator.cancelRun("run-1"));
    await rpcResult(attempts.getByName("job-1").release());
  });
  it("retains one physical execution beyond the deadman interval and recovers its owner", async () => {
    await rpcResult(coordinator.seed(2, "coder", true));
    await deadline(rpcResult(coordinator.fire()), 2500);
    const first = await rpcResult(attempts.getByName("job-0").inspect());
    assert.equal(first.deliveries, 1);
    assert.deepEqual(
      first.input.context.enabledTools,
      ["search_code", "store_code"],
      "pinned role context enables supported original memory tools"
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).deliveries,
      0
    );
    const notOwner = await rpcResult(
      coordinator.rejection("reconcileToolOutcome", ["job-1"])
    );
    assert.match(
      notOwner.error,
      /409/,
      "nonterminal queued job cannot reconcile another owner"
    );
    await deadline(rpcResult(coordinator.repeatDelivery("job-0")), 2500);
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).deliveries,
      1,
      "overlapping alarm cannot change pinned launch"
    );
    const wait = Number(process.env.PROBE_DEADMAN_WAIT_MS ?? 31000);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).starts,
      1,
      "SDK recovery/deadman wakes retain one physical execution"
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).starts,
      0,
      "unbounded work has no 30-second execution deadline"
    );
    // The persisted native wake, without a new API wake, resumes after eviction.
    await rpcResult(coordinator.recoveryAfterReset());
    // Abrupt reset represents deployment/eviction; graceful eviction waits for pending I/O.
    await coordinator.abortForTest().catch(() => undefined);
    coordinator = coordinators.getByName("global");
    let resumed;
    await expect
      .poll(
        async () => {
          resumed = await rpcResult(attempts.getByName("job-0").inspect());
          return Boolean(resumed.deliveries >= 2);
        },
        { timeout: 15000, interval: 100 }
      )
      .toBe(true);
    assert.equal(
      resumed.deliveries,
      2,
      "persisted native heartbeat resumes the same owner after reset without an API wake"
    );
    assert.deepEqual(
      resumed.input,
      first.input,
      "reset resumes byte-identical pinned input"
    );
    assert.equal(resumed.starts, 1);
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(coordinator.recoverNow());
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).deliveries,
      0,
      "cancellation holds slot until execution drains"
    );
    await rpcResult(attempts.getByName("job-0").release());
    await rpcResult(coordinator.recoverNow());
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).deliveries,
      1,
      "FIFO next run starts after drain"
    );
    assert.equal(
      (await rpcResult(coordinator.reconcileToolOutcome("job-0")))
        .alreadyDrained,
      true,
      "late successful remote reconciliation remains idempotent after slot handoff"
    );
    await rpcResult(coordinator.cancelRun("run-1"));
    await rpcResult(attempts.getByName("job-1").release());
  }, 45_000);
  it("concurrent continuation CAS admits one wave", async () => {
    await rpcResult(coordinator.seed(1, "coder", false));
    await rpcResult(coordinator.terminalize("job-0"));
    const snapshot = await rpcResult(coordinator.advanceTwice());
    assert.equal(
      snapshot.jobs.filter((job) => job.id !== "job-0").length,
      1,
      "concurrent continuation CAS admits one wave"
    );
    assert.equal(
      snapshot.records.find((row) => row.key === "run:run-0").value.wave,
      1
    );
    await rpcResult(coordinator.cancelRun("run-0"));
    await deadline(rpcResult(coordinator.repeatDelivery("job-0")), 2500);
    const cancelled = await rpcResult(coordinator.snapshot());
    assert.equal(
      cancelled.records.find((row) => row.key === "run:run-0").value.phase,
      "cancelled"
    );
    assert(
      cancelled.jobs.every(
        (job) => job.status === "failed" || job.status === "interrupted"
      ),
      "late queue notification cannot resurrect cancelled jobs"
    );
  });
  it("replayed revision keeps immutable identity at capacity", async () => {
    await rpcResult(coordinator.seed(2, "primary", true));
    await rpcResult(coordinator.fire());
    await rpcResult(coordinator.stoppedTarget("target-0", "run-0"));
    await rpcResult(coordinator.stoppedTarget("target-1", "run-1"));
    const revise = () =>
      rpcResult(
        coordinator.delegationForTest("job-0", "revise_attempt", {
          job_id: "target-0",
          instructions: "repair"
        })
      );
    const first = await revise(),
      replay = await revise();
    assert.equal(
      first.job_id,
      replay.job_id,
      "replayed revision keeps immutable identity at capacity"
    );
    const cross = await rpcResult(
      coordinator.rejection("delegationForTest", [
        "job-0",
        "revise_attempt",
        { job_id: "target-1", instructions: "repair" }
      ])
    );
    assert.match(cross.error, /same-run/);
    const full = await rpcResult(
      coordinator.rejection("delegationForTest", [
        "job-0",
        "search",
        { question: "new research", message: "research" }
      ])
    );
    assert.match(full.error, /429/);
    await rpcResult(coordinator.cancelRun("run-0"));
    const cancelled = await rpcResult(coordinator.snapshot());
    assert(
      cancelled.jobs
        .filter((job) => job.runId === "run-0")
        .every((job) => ["completed", "interrupted"].includes(job.status)),
      "cancel fences whole run before external calls"
    );
    await rpcResult(
      coordinator.revisionForTest("target-1", "first after cancellation", "one")
    );
    const capacity = await rpcResult(
      coordinator.rejection("revisionForTest", [
        "target-1",
        "second after cancellation",
        "two"
      ])
    );
    assert.match(
      capacity.error,
      /429/,
      "draining cancelled owner still counts toward global 1+2 bound"
    );
    await rpcResult(coordinator.cancelRun("run-1"));
    await rpcResult(attempts.getByName("job-0").release());
  });
  it("seed", async () => {
    await rpcResult(coordinator.seed(1, "coder", true));
    await rpcResult(coordinator.fire());
    const forbidden = await rpcResult(
      coordinator.rejection("delegationForTest", [
        "job-0",
        "pentester",
        { question: "escalate role", message: "forbidden" }
      ])
    );
    assert.match(forbidden.error, /403/);
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(attempts.getByName("job-0").release());
  });
  it("candidate acceptance linearizes before projection", async () => {
    await rpcResult(coordinator.seed(2, "coder", true));
    await rpcResult(coordinator.fire());
    const baseline = await rpcResult(coordinator.mainHead("run-0"));
    const candidate = await rpcResult(
      coordinator.prepareCandidate("job-0", {})
    );
    assert.equal(
      (await rpcResult(coordinator.snapshot())).jobs.find(
        (job) => job.id === "job-0"
      ).status,
      "running"
    );
    await rpcResult(coordinator.projectionBlock(true));
    await attempts.getByName(candidate.id).finish(candidate);
    let snapshot;
    await expect
      .poll(
        async () => {
          snapshot = await rpcResult(coordinator.snapshot());
          return Boolean(
            snapshot.jobs.find((job) => job.id === "job-0").status ===
            "completed"
          );
        },
        { timeout: 1000, interval: 10 }
      )
      .toBe(true);
    assert.equal(
      snapshot.jobs.find((job) => job.id === "job-0").status,
      "completed",
      "candidate acceptance linearizes before projection"
    );
    assert.equal(
      snapshot.records.find((row) => row.key === "run:run-0").value.headCommit,
      candidate.outputCommit
    );
    assert.equal(
      snapshot.records.find((row) => row.key === "publication:run-0").value
        .commit,
      candidate.outputCommit,
      "failed projection retains durable receipt"
    );
    assert.equal(
      await rpcResult(coordinator.mainHead("run-0")),
      baseline,
      "remote main remains old while publication is blocked"
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-1").inspect())).starts,
      0
    );
    await coordinator.abortForTest().catch(() => undefined);
    coordinator = coordinators.getByName("global");
    await rpcResult(coordinator.projectionBlock(false));
    const duplicate = await rpcResult(coordinator.acceptPrepared("job-0", {}));
    assert.equal(
      duplicate.duplicate,
      true,
      "duplicate completion repairs durable projection after reset"
    );
    await rpcResult(coordinator.recoverNow());
    snapshot = await rpcResult(coordinator.snapshot());
    assert.equal(
      await rpcResult(coordinator.mainHead("run-0")),
      candidate.outputCommit
    );
    assert.equal(
      snapshot.records.find((row) => row.key === "publication:run-0").value,
      null
    );
    assert.equal(
      snapshot.jobs.find((job) => job.id === "job-0").revision,
      2,
      "replay does not accept twice"
    );
    assert.equal(
      (await rpcResult(attempts.getByName("job-0").inspect())).starts,
      1,
      "accepted candidate never reruns model"
    );
    let next;
    await expect
      .poll(
        async () => {
          next = await rpcResult(attempts.getByName("job-1").inspect());
          return Boolean(next.starts === 1);
        },
        { timeout: 1000, interval: 10 }
      )
      .toBe(true);
    assert.equal(next.starts, 1, "publication repair allows FIFO to continue");
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(coordinator.cancelRun("run-1"));
    await rpcResult(attempts.getByName("job-1").release());
  });
  it("seed (case 27)", async () => {
    await rpcResult(coordinator.seed(1, "coder", true));
    await rpcResult(coordinator.fire());
    await rpcResult(coordinator.prepareCandidate("job-0", {}));
    for (const changes of [
      { status: "running" },
      { tool: "report_result" },
      { finishedAt: -1 }
    ]) {
      const rejected = await rpcResult(
        coordinator.rejection("acceptPrepared", ["job-0", changes])
      );
      assert.match(rejected.error, /400|Invalid/);
    }
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(attempts.getByName("job-0").release());
  });
  it("invalid settled candidate terminates explicitly instead of retrying acceptance forever", async () => {
    await rpcResult(coordinator.seed(1, "coder", true));
    await rpcResult(coordinator.fire());
    const invalid = await rpcResult(
      coordinator.prepareCandidate("job-0", { run_id: "another-run" })
    );
    const rejected = await rpcResult(
      coordinator.rejection("acceptPrepared", ["job-0", {}])
    );
    assert.match(rejected.error, /provenance mismatch/);
    await attempts.getByName(invalid.id).finish(invalid);
    let status;
    await expect
      .poll(
        async () => {
          status = (await rpcResult(coordinator.snapshot())).jobs.find(
            (job) => job.id === "job-0"
          ).status;
          return Boolean(status === "invalid_result");
        },
        { timeout: 1000, interval: 10 }
      )
      .toBe(true);
    assert.equal(
      status,
      "invalid_result",
      "invalid settled candidate terminates explicitly instead of retrying acceptance forever"
    );
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(attempts.getByName("job-0").release());
  });
  it("coordinator independently enforces role diff policy", async () => {
    await rpcResult(coordinator.seed(1, "primary", true));
    await rpcResult(coordinator.fire());
    await rpcResult(
      coordinator.prepareCandidate("job-0", { __sourceWrite: true })
    );
    const rejected = await rpcResult(
      coordinator.rejection("acceptPrepared", ["job-0", {}])
    );
    assert.match(
      rejected.error,
      /cannot change source/,
      "coordinator independently enforces role diff policy"
    );
    await rpcResult(coordinator.cancelRun("run-0"));
    await rpcResult(attempts.getByName("job-0").release());
  });
  it("last job budget slot is reserved for required reporter", async () => {
    await rpcResult(coordinator.seed(1, "primary", false));
    await rpcResult(coordinator.stoppedTarget("target-0", "run-0"));
    await rpcResult(coordinator.limit("run-0", 3));
    await rpcResult(coordinator.terminalize("job-0"));
    const snapshot = await rpcResult(coordinator.advanceTwice());
    assert.equal(snapshot.jobs.length, 3);
    assert.equal(
      snapshot.jobs.find((job) => !["job-0", "target-0"].includes(job.id)).role,
      "reporter",
      "last job budget slot is reserved for required reporter"
    );
    await rpcResult(coordinator.cancelRun("run-0"));
  });
  it("distinct concurrent admissions commit unique FIFO positions", async () => {
    const admitted = await Promise.all([
      rpcResult(
        coordinator.createRun({ run_id: "concurrent-first", task: "first" })
      ),
      rpcResult(
        coordinator.createRun({ run_id: "concurrent-second", task: "second" })
      )
    ]);
    assert.notEqual(admitted[0].rootJob.id, admitted[1].rootJob.id);
    const snapshot = await rpcResult(coordinator.snapshot());
    const ordered = admitted
      .map(({ run, rootJob }) => ({
        runId: run.id,
        id: rootJob.id,
        order: snapshot.records.find((row) => row.key === "order:" + rootJob.id)
          ?.value
      }))
      .sort((a, b) => a.order - b.order);
    assert.ok(ordered.every((job) => Number.isSafeInteger(job.order)));
    assert.ok(
      ordered[0].order < ordered[1].order,
      "distinct concurrent admissions commit unique FIFO positions"
    );
    await rpcResult(coordinator.recoverNow());
    const [first, second] = ordered;
    assert.equal(
      (await rpcResult(coordinator.snapshot())).records.find(
        (row) => row.key === "active"
      ).value.id,
      first.id
    );
    assert.equal(
      (await rpcResult(attempts.getByName(first.id).inspect())).starts,
      1,
      "first committed admission owns the physical execution"
    );
    assert.equal(
      (await rpcResult(attempts.getByName(second.id).inspect())).starts,
      0
    );
    await rpcResult(coordinator.cancelRun(first.runId));
    await rpcResult(coordinator.recoverNow());
    assert.equal(
      (await rpcResult(coordinator.snapshot())).records.find(
        (row) => row.key === "active"
      ).value.id,
      first.id
    );
    assert.equal(
      (await rpcResult(attempts.getByName(second.id).inspect())).starts,
      0,
      "cancellation cannot hand off before the first execution drains"
    );
    await rpcResult(attempts.getByName(first.id).release());
    let next;
    await expect
      .poll(
        async () => {
          next = await rpcResult(attempts.getByName(second.id).inspect());
          return Boolean(next.starts === 1);
        },
        { timeout: 2000, interval: 20 }
      )
      .toBe(true);
    assert.equal(
      next.starts,
      1,
      "the next committed admission starts after the physical owner drains"
    );
    assert.equal(
      (await rpcResult(coordinator.snapshot())).records.find(
        (row) => row.key === "active"
      ).value.id,
      second.id
    );
    assert.equal(
      (await rpcResult(attempts.getByName(first.id).inspect())).starts,
      1
    );
    await rpcResult(coordinator.cancelRun(second.runId));
    await rpcResult(attempts.getByName(second.id).release());
  });
  it("concurrent identical admission resumes one initialization and returns one immutable root receipt", async () => {
    const [first, second] = await Promise.all([
      rpcResult(coordinator.createRun({ run_id: "concurrent", task: "same" })),
      rpcResult(coordinator.createRun({ run_id: "concurrent", task: "same" }))
    ]);
    assert.equal(
      first.rootJob.id,
      second.rootJob.id,
      "concurrent identical admission resumes one initialization and returns one immutable root receipt"
    );
    const snapshot = await rpcResult(coordinator.snapshot());
    assert.equal(snapshot.jobs.length, 1);
    await rpcResult(coordinator.cancelRun("concurrent"));
    await rpcResult(attempts.getByName(first.rootJob.id).release());
  });
  it("repository-derived run IDs enforce length before remote mutation", async () => {
    const rejected = await rpcResult(
      coordinator.rejection("createRun", [
        { run_id: "a".repeat(55), task: "probe" }
      ])
    );
    assert.match(
      rejected.error,
      /400:.*run id/,
      "repository-derived run IDs enforce length before remote mutation"
    );
  });
  it("failed initialization is not admitted", async () => {
    await rpcResult(coordinator.projectionBlock(true));
    const failed = await rpcResult(
      coordinator.rejection("createRun", [
        { run_id: "initialization-retry", task: "probe" }
      ])
    );
    assert.match(failed.error, /503/);
    const first = await rpcResult(
      coordinator.initializationHead("initialization-retry")
    );
    assert.equal(
      (await rpcResult(coordinator.snapshot())).jobs.length,
      0,
      "failed initialization is not admitted"
    );
    await rpcResult(coordinator.projectionBlock(false));
    const resumed = await rpcResult(
      coordinator.createRun({ run_id: "initialization-retry", task: "probe" })
    );
    assert.equal(
      resumed.run.inputCommit,
      first,
      "initialization replay reuses durable local commit after failed push"
    );
    await rpcResult(coordinator.cancelRun("initialization-retry"));
    await rpcResult(attempts.getByName(resumed.rootJob.id).release());
  });
  it("new-run reader context comes from the saved target snapshot, not arbitrary objective URLs", async () => {
    const created = await rpcResult(
      coordinator.createRun({
        run_id: "scope-probe",
        task: "Research https://example.test/allowed/ and https://other.test/path avoid https://user:password@private.test/"
      })
    );
    await rpcResult(coordinator.fire());
    const active = await rpcResult(
      attempts.getByName(created.rootJob.id).inspect()
    );
    assert.deepEqual(
      active.input.context.browserAllowedURLs,
      ["https://owned.invalid/"],
      "new-run reader context comes from the saved target snapshot, not arbitrary objective URLs"
    );
    await rpcResult(coordinator.cancelRun("scope-probe"));
    await rpcResult(attempts.getByName(created.rootJob.id).release());
  });
  it("infrastructure failure is preserved", async () => {
    for (const kind of [
      "roles",
      "template",
      "missing-format",
      "type",
      "search-provider"
    ]) {
      const rejected = await rpcResult(
        coordinator.rejection("invalidSettings", [kind])
      );
      assert.match(
        rejected.error,
        /400:/,
        kind + " settings failure is a client validation error"
      );
    }
    const unavailable = await rpcResult(
      coordinator.rejection("invalidSettings", ["infrastructure"])
    );
    assert.match(unavailable.error, /hash backend unavailable/);
    assert.doesNotMatch(
      unavailable.error,
      /400:/,
      "infrastructure failure is preserved"
    );
  });
  it("browser auth lifecycle", async () => {
    assert.deepEqual(await rpcResult(coordinator.browserAuthLifecycle()), {
      cancelled: true,
      completed: true,
      archived: true
    });
  });
  console.log(
    "workerd coordinator: Lifecycle heartbeat/handoff/deadman/reset, cancellation drain/FIFO/capacity, continuation CAS, role/revision authority, real Git candidate validation and durable publication replay passed"
  );
});
