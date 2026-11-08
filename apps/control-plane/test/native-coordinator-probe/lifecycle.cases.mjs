import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, it } from "vite-plus/test";
describe("run lifecycle", () => {
  beforeEach(reset);
  const COORDINATOR = env.COORDINATOR;
  const rpcResult = async (value) => await value;
  it.each(["normal", "other-active", "clear-failure"])(
    "directDeleteScenario: %s",
    async (mode) => {
      const result = await rpcResult(
        COORDINATOR.getByName("global").directDeleteScenario(mode)
      );
      const records = result.before.records;
      if (mode === "normal") {
        assert.equal(
          result.error,
          undefined,
          "confirmed deletion works directly from Recent runs"
        );
        assert.ok(records.some((r) => r.key === "purged:run:run-0"));
        assert.equal(result.clears, 1);
      } else if (mode === "other-active") {
        assert.match(result.error, /409:.*(another|other).*run/i);
        assert.equal(result.clears, 0);
        assert.equal(
          records.some((r) => r.key.startsWith("deleted:")),
          false
        );
      } else {
        assert.match(result.error, /503:.*(cleanup|clear)/i);
        assert.ok(records.some((r) => r.key === "purge:run-0"));
        assert.equal(
          records.some((r) => r.key.startsWith("deleted:")),
          false
        );
        assert.equal(
          result.blocked,
          true,
          "purge intent must fence new execution admission"
        );
        assert.deepEqual(result.after, { runId: "run-0", deleted: true });
        assert.equal(result.clears, 2);
      }
      console.log(`native direct deletion ${mode}: passed`);
    }
  );
  it.each(["normal", "retry", "unresolved", "protected"])(
    "lifecycleScenario: %s",
    async (mode) => {
      const result = await rpcResult(
        COORDINATOR.getByName("global").lifecycleScenario(mode)
      );
      assert.equal(result.archived.run.lifecycle, "archived");
      assert.equal(result.hidden.runs.length, 0);
      assert.equal(result.visible.runs.length, 1);
      assert.equal(result.restored.run.lifecycle, "active");
      assert.ok(
        result.trashed.run.lifecycleRevision >
          result.restored.run.lifecycleRevision
      );
      assert.equal(result.report.text, "# Accepted report\nExact evidence\n");
      assert.equal(result.report.commit, "a".repeat(40));
      assert.match(result.wrongReport, /404:/);
      if (mode === "unresolved" || mode === "protected") {
        assert.match(
          result.error,
          mode === "unresolved" ? /drain|unresolved/ : /repository|protected/
        );
        assert.ok(result.snapshot.records.some((r) => r.key === "run:run-0"));
        assert.equal(
          result.snapshot.records.some((r) => r.key.startsWith("deleted:")),
          false
        );
      } else {
        if (mode === "retry") assert.match(result.error, /injected/);
        assert.deepEqual(result.deleted, { runId: "run-0", deleted: true });
        assert.deepEqual(result.duplicate, result.deleted);
        assert.match(result.resurrection, /purged/);
        assert.match(result.admission, /quiesced/);
        assert.equal(result.lifecycle.safeToUninstall, true);
        assert.equal(result.quiesced.quiesced, true);
        assert.equal(
          result.snapshot.records.some((r) =>
            /^(run:|job:|order:|launch:)/.test(r.key)
          ),
          false
        );
        assert.ok(
          result.snapshot.records.some((r) => r.key === "purged:run:run-0")
        );
      }
      console.log(`native lifecycle ${mode}: passed`);
    }
  );
  it.each(["purge-race", "create-race", "create-race?mode=failure"])(
    "purgeRaceScenario: %s",
    async (mode) => {
      const coordinator = COORDINATOR.getByName("global");
      const result = await rpcResult(
        mode === "purge-race"
          ? coordinator.purgeRaceScenario()
          : coordinator.createRaceScenario(
              mode.includes("failure") ? "failure" : "normal"
            )
      );
      if (mode === "purge-race") {
        assert.match(result.outcome.error, /409:.*changed/);
        const before = result.before.records,
          after = result.after.records;
        assert.ok(
          before.find((row) => row.key === "active")?.value,
          "revision must hold the serial execution slot"
        );
        for (const key of [
          "run:run-0",
          "active",
          "job:job-0",
          `job:${result.revision.job.id}`
        ])
          assert.deepEqual(
            after.find((row) => row.key === key),
            before.find((row) => row.key === key)
          );
        assert.equal(
          after.some((row) => row.key.startsWith("deleted:")),
          false
        );
      } else {
        assert.equal(result.before.preparingInput, true);
        assert.equal(result.pendingCreation.input.run_id, "creation-race");
        assert.equal(result.pendingCreation.input.target_id, "probe-target");
        assert.match(result.discard, /409:/);
        assert.match(result.uninstall, /409:/);
        if (mode.includes("failure")) {
          assert.match(result.outcome.error, /injected/);
          assert.equal(result.after.safeToUninstall, false);
          assert.match(result.failedUninstall, /409:/);
          assert.deepEqual(result.repositories, []);
          assert.equal(result.final.safeToUninstall, false);
          assert.equal(result.final.canDeleteOnboarding, true);
          assert.equal(result.final.onboarding.targets, 1);
        } else {
          assert.equal(result.outcome.error, "");
          assert.deepEqual(result.repositories, ["run-creation-race"]);
          assert.equal(result.outcome.value.run.id, "creation-race");
        }
      }
      console.log(`native lifecycle ${mode}: passed`);
    }
  );
  it.each(["same", "objective", "uploads"])(
    "duplicateCreateScenario: %s",
    async (mode) => {
      const result = await rpcResult(
        COORDINATOR.getByName("global").duplicateCreateScenario(mode)
      );
      assert.equal(result.faster.run.id, "duplicate-create");
      if (mode === "same") {
        assert.equal(result.duplicate.run.id, result.faster.run.id);
        assert.equal(result.duplicate.rootJob.id, result.faster.rootJob.id);
        assert.equal(result.duplicateError, "");
      } else {
        assert.match(
          result.duplicateError,
          /409: Run creation identity reused with changed input/
        );
        assert.equal(result.duplicate, undefined);
      }
      assert.equal(result.jobs.length, 1);
      assert.equal(
        result.setupAfterDuplicate.draft.revision,
        1,
        "a slower duplicate cannot reset the admitted setup"
      );
      assert.equal(result.setupAfterDuplicate.draft.publicAPI, false);
      assert.equal(result.admitted.ownedProjects, 0);
      assert.equal(
        result.afterDuplicate.ownedProjects,
        0,
        "duplicate preparation must not leave a draft receipt for an admitted run"
      );
      assert.deepEqual(result.deleted, {
        runId: "duplicate-create",
        deleted: true
      });
      assert.equal(result.afterPurge.safeToUninstall, false);
      assert.equal(result.afterPurge.onboarding.targets, 1);
      assert.equal(result.afterPurge.canDeleteOnboarding, true);
      assert.equal(result.uninstallError, "");
      assert.equal(result.quiesced.quiesced, true);
      assert.equal(
        result.snapshot.records.some((row) =>
          row.key.startsWith("project:owned:")
        ),
        false
      );
      console.log(`native lifecycle duplicate-create ${mode}: passed`);
    }
  );
  it("prepareTrashGate", async () => {
    const coordinator = COORDINATOR.getByName("global");
    await rpcResult(coordinator.prepareTrashGate());
    const trash = rpcResult(coordinator.trashRun("run-0"));
    await rpcResult(coordinator.waitTrashGate());
    const marked = await rpcResult(coordinator.snapshot());
    assert.equal(
      marked.records.find((row) => row.key === "run:run-0").value.phase,
      "cancelled"
    );
    assert.equal(
      marked.records.find((row) => row.key === "job:job-0").value.status,
      "interrupted"
    );
    await rpcResult(coordinator.restoreRun("run-0"));
    const revision = await rpcResult(
      coordinator.revisionForTest("job-0", "New revision", "trash-race")
    );
    await rpcResult(coordinator.releaseTrashGate());
    await trash;
    const after = await rpcResult(coordinator.snapshot());
    assert.equal(
      after.records.find((row) => row.key === "run:run-0").value.lifecycle,
      "active"
    );
    assert.equal(
      after.records.find((row) => row.key === "run:run-0").value.phase,
      "specialists"
    );
    assert.notEqual(
      after.records.find((row) => row.key === `job:${revision.job.id}`).value
        .status,
      "interrupted"
    );
    console.log("native lifecycle blocked trash restore revision: passed");
  });
  it("onboardingLifecycle", async () => {
    const result = await rpcResult(
      COORDINATOR.getByName("global").onboardingLifecycle()
    );
    assert.equal(result.before.safeToUninstall, false);
    assert.equal(result.before.onboarding.targets, 1);
    assert.equal(result.before.onboarding.credentials, 1);
    assert.match(result.retained, /409:/);
    assert.equal(result.secretExported, false);
    assert.equal(result.credential.id, "library-key");
    assert.equal(
      result.credential.missing,
      true,
      "historical credential metadata stays exportable without restoring its vault"
    );
    assert.equal(result.after.safeToUninstall, true);
    assert.equal(result.after.quiesced, true);
    assert.deepEqual(result.rows, []);
    console.log("native lifecycle onboarding library/vault cleanup: passed");
  });
});
