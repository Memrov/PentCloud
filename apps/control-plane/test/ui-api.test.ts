import { describe, expect, it, vi } from "vitest";

import {
  archiveRun,
  trashRun,
  restoreRun,
  permanentlyDeleteRun,
  reportDownloadUrl,
  parseRun,
  createRun,
  getRunJobs,
  getRuntimeDiagnostics,
  getSettings,
  listRuns,
  listSettingsModels,
  parseActivityEvent,
  parseJob,
  rearmRuntimeRecovery,
  saveSettings,
  steerJob
} from "../src/ui/api";
import { SETTINGS_ROLES, type SettingsRoles } from "../src/ui/settings/model";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

describe("operator UI API client", () => {
  it("parses lifecycle metadata, preserves legacy active runs and rejects unknown lifecycle values", () => {
    const run = {
      id: "run/a",
      status: "completed",
      baselineRepo: "repo",
      inputCommit: "abc",
      maxDepth: 4,
      maxJobs: 32
    };
    for (const lifecycle of ["active", "archived", "trashed", "purging"])
      expect(parseRun({ ...run, lifecycle })).toMatchObject({ lifecycle });
    expect(parseRun(run)).not.toHaveProperty("lifecycle");
    expect(() => parseRun({ ...run, lifecycle: "erased" })).toThrow(
      "invalid run projection"
    );
  });
  it("routes lifecycle operations with encoded IDs, explicit delete identity and visible drain conflicts", async () => {
    const run = {
      id: "run/a",
      status: "completed",
      baselineRepo: "repo",
      inputCommit: "abc",
      maxDepth: 4,
      maxJobs: 32
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ runs: [{ ...run, lifecycle: "archived" }] })
      )
      .mockResolvedValueOnce(json({ run: { ...run, lifecycle: "archived" } }))
      .mockResolvedValueOnce(
        json({ run: { ...run, lifecycle: "trashed" }, jobs: [] })
      )
      .mockResolvedValueOnce(json({ run: { ...run, lifecycle: "active" } }))
      .mockResolvedValueOnce(
        json({ error: "Remote scanner outcomes must be reconciled" }, 409)
      )
      .mockResolvedValueOnce(json({ runId: run.id, deleted: true }));
    await expect(listRuns(fetcher, "archived")).resolves.toMatchObject([
      { lifecycle: "archived" }
    ]);
    await expect(archiveRun(run.id, fetcher)).resolves.toMatchObject({
      run: { lifecycle: "archived" }
    });
    await trashRun(run.id, fetcher);
    await restoreRun(run.id, fetcher);
    await expect(permanentlyDeleteRun(run.id, fetcher)).rejects.toMatchObject({
      status: 409,
      message: "Remote scanner outcomes must be reconciled"
    });
    await permanentlyDeleteRun(run.id, fetcher);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/v1/ui/runs?view=archived",
      "/v1/ui/runs/run%2Fa/archive",
      "/v1/ui/runs/run%2Fa/trash",
      "/v1/ui/runs/run%2Fa/restore",
      "/v1/ui/runs/run%2Fa",
      "/v1/ui/runs/run%2Fa"
    ]);
    expect(fetcher.mock.calls[5]?.[1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ confirm: run.id })
    });
    expect(reportDownloadUrl("run/a", "job/b")).toBe(
      "/v1/ui/runs/run%2Fa/report?job=job%2Fb"
    );
  });
  it("loads safe runtime recovery metadata and sends the selected marker without retrying conflicts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          coordinator: {
            recovery: {
              reason: "alarm_memory_limit",
              sealed: true,
              observedAt: 100,
              purgedJobs: 2
            }
          },
          backlog: { waiting: 1, oldestWaitingMs: 2000 },
          payload: "secret"
        })
      )
      .mockResolvedValueOnce(
        json(
          {
            error: "reconcile remote scanner outcomes before platform recovery"
          },
          409
        )
      );
    const diagnostics = await getRuntimeDiagnostics(fetcher);
    expect(diagnostics.coordinator.recovery?.observedAt).toBe(100);
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
    await expect(
      rearmRuntimeRecovery({ scope: "coordinator", observedAt: 100 }, fetcher)
    ).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith("/v1/ui/runtime-recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"scope":"coordinator","observedAt":100}'
    });
  });
  it("retains sealed platform recovery notices and rejects payload-shaped markers", () => {
    const job = { id: "job", runId: "run", status: "running", revision: 1 };
    expect(
      parseJob({
        ...job,
        recovery: {
          reason: "alarm_memory_limit",
          sealed: true,
          observedAt: 100,
          purgedJobs: 2,
          payload: "secret"
        }
      })
    ).toMatchObject({
      recovery: {
        reason: "alarm_memory_limit",
        sealed: true,
        observedAt: 100,
        purgedJobs: 2
      }
    });
    expect(
      JSON.stringify(
        parseJob({
          ...job,
          recovery: {
            reason: "alarm_memory_limit",
            sealed: true,
            observedAt: 100,
            purgedJobs: 2,
            payload: "secret"
          }
        })
      )
    ).not.toContain("secret");
    expect(
      parseJob({
        ...job,
        recovery: {
          reason: "payload",
          sealed: true,
          observedAt: 100,
          purgedJobs: 2
        }
      })
    ).not.toHaveProperty("recovery");
  });
  it("preserves explicit native session capability without inferring it from archive metadata", () => {
    const job = { id: "job", runId: "run", status: "completed", revision: 1 };
    expect(parseJob({ ...job, nativeSession: true })).toMatchObject({
      nativeSession: true
    });
    for (const value of [
      { ...job, archiveStatus: "complete" },
      job,
      { ...job, nativeSession: "true" }
    ])
      expect(parseJob(value)).not.toHaveProperty("nativeSession");
  });
  it("parses browser-safe run and job projections", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          runs: [
            {
              id: "run-1",
              status: "running",
              baselineRepo: "baseline",
              inputCommit: "abc",
              maxDepth: 4,
              maxJobs: 32
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        json({
          run: {
            id: "run-1",
            status: "running",
            baselineRepo: "baseline",
            inputCommit: "abc",
            maxDepth: 4,
            maxJobs: 32
          },
          jobs: [
            {
              id: "job-1",
              runId: "run-1",
              role: "primary",
              tool: "primary",
              depth: 0,
              status: "running",
              revision: 2,
              task: "Inspect"
            }
          ]
        })
      );

    await expect(listRuns(fetcher)).resolves.toMatchObject([
      { id: "run-1", status: "running" }
    ]);
    await expect(getRunJobs("run-1", fetcher)).resolves.toMatchObject({
      jobs: [{ id: "job-1", task: "Inspect" }]
    });
  });

  it("sends a client-generated id and stable launch time when creating a run", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          run: {
            id: "run-new",
            status: "running",
            baselineRepo: "baseline",
            inputCommit: "abc",
            maxDepth: 4,
            maxJobs: 32
          },
          rootJob: {
            id: "run-new-primary-1",
            runId: "run-new",
            role: "primary",
            status: "created",
            revision: 1
          }
        },
        201
      )
    );

    await createRun(
      { runId: "run-new", task: "Inspect", launchTime: "2026-10-30T00:00:00Z" },
      fetcher
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/ui/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          run_id: "run-new",
          task: "Inspect",
          launch_time: "2026-10-30T00:00:00Z"
        })
      })
    );
  });

  it("rejects malformed safe projections and preserves steer conflicts", async () => {
    await expect(
      listRuns(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            json({ runs: [{ id: "run-1", remote: "secret" }] })
          )
      )
    ).rejects.toThrow("invalid run projection");
    const conflict = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ error: "specialist is no longer running" }, 409)
      );
    await expect(steerJob("job-1", "Continue", conflict)).rejects.toMatchObject(
      {
        status: 409,
        message: "specialist is no longer running"
      }
    );
  });

  it("parses only activity event fields used by the dashboard timeline", () => {
    expect(
      parseActivityEvent({
        instanceId: "run-1",
        eventId: 0,
        timestamp: 0,
        type: "input.committed"
      })
    ).toMatchObject({ eventId: 0, type: "input.committed" });
    expect(() =>
      parseActivityEvent({
        instanceId: "run-1",
        eventId: -1,
        timestamp: 0,
        type: "run.started"
      })
    ).toThrow("invalid activity event");
    expect(
      parseActivityEvent({
        instanceId: "run-1",
        eventId: 8,
        timestamp: 2100,
        type: "platform.memory_recovery_sealed",
        jobId: "job-1"
      })
    ).toMatchObject({
      type: "platform.memory_recovery_sealed",
      jobId: "job-1"
    });
    expect(
      parseActivityEvent({
        instanceId: "job-1",
        eventId: 7,
        timestamp: 2_000,
        type: "phase.failed",
        stepName: "run specialist",
        error: { name: "Error", message: "temporary" },
        output: "must be ignored"
      })
    ).toEqual({
      instanceId: "job-1",
      eventId: 7,
      timestamp: 2_000,
      type: "phase.failed",
      stepName: "run specialist",
      error: { name: "Error", message: "temporary" }
    });
    expect(() =>
      parseActivityEvent({
        instanceId: "job-1",
        eventId: 1,
        timestamp: 0,
        type: "unknown"
      })
    ).toThrow("invalid activity event");
    expect(() =>
      parseActivityEvent({
        instanceId: "job-1",
        eventId: "1",
        timestamp: 0,
        type: "run.started"
      })
    ).toThrow("invalid activity event");
  });

  it("parses settings/model projections and saves with optimistic concurrency", async () => {
    const roles = Object.fromEntries(
      SETTINGS_ROLES.map(({ id }) => [
        id,
        {
          promptTemplate: `${id} prompt`,
          upstreamPromptDigest: "a".repeat(64),
          model: "openai/gpt-6-sol",
          reasoningEffort: "max"
        }
      ])
    ) as SettingsRoles;
    roles.primary.promptFormat = "pentagi-template";
    roles.searcher.searchProvider = "exa";
    const settings = {
      settings: {
        schemaVersion: 1,
        revision: "b".repeat(64),
        upstreamManifestDigest: "c".repeat(64),
        savedAt: "2026-10-30T00:00:00.000Z",
        savedBy: "operator@example.com",
        roles
      },
      casRevision: 3,
      locked: false,
      blockingRunIds: [],
      upstreamRoles: Object.fromEntries(
        SETTINGS_ROLES.map(({ id }) => [
          id,
          {
            promptTemplate: `${id} upstream`,
            upstreamPromptDigest: "a".repeat(64)
          }
        ])
      )
    };
    const models = {
      models: [
        {
          id: "openai/gpt-6-sol",
          name: "GPT-6 Sol",
          provider: "openai",
          contextLength: 1_048_576,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportedParameters: ["tools"],
          reasoningEfforts: ["max"]
        }
      ],
      fetchedAt: "2026-10-30T00:00:00.000Z",
      stale: false
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json({ ...settings, casRevision: 4 }));

    const historical = await getSettings(fetcher);
    expect(historical.settings).toEqual(settings.settings);
    expect(historical.settings.roles.primary.promptFormat).toBe(
      "pentagi-template"
    );
    expect(historical.settings.roles.coder).not.toHaveProperty("promptFormat");
    expect(historical.settings.roles.coder).not.toHaveProperty(
      "searchProvider"
    );
    expect(historical.settings.roles.searcher.searchProvider).toBe("exa");
    await expect(listSettingsModels(true, fetcher)).resolves.toMatchObject({
      models: [{ provider: "openai" }]
    });
    await expect(saveSettings(roles, 3, fetcher)).resolves.toMatchObject({
      casRevision: 4
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/v1/ui/settings/models?refresh=1",
      {}
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/v1/ui/settings",
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": "3" },
        body: JSON.stringify({ roles })
      })
    );
  });
  it("rejects unsupported per-role search providers in settings projections", async () => {
    const roles = Object.fromEntries(
      SETTINGS_ROLES.map(({ id }) => [
        id,
        {
          promptTemplate: `${id} prompt`,
          upstreamPromptDigest: "a".repeat(64),
          model: "opencode-go:deepseek-v4-pro",
          reasoningEffort: "default",
          ...(id === "searcher" ? { searchProvider: "random" } : {})
        }
      ])
    );
    await expect(
      getSettings(
        vi.fn<typeof fetch>().mockResolvedValue(
          json({
            settings: {
              schemaVersion: 1,
              revision: "b".repeat(64),
              upstreamManifestDigest: "c".repeat(64),
              savedAt: "2026-10-30T00:00:00.000Z",
              savedBy: "operator",
              roles
            },
            casRevision: 1,
            locked: false,
            blockingRunIds: [],
            upstreamRoles: roles
          })
        )
      )
    ).rejects.toThrow("invalid searcher settings");
  });
});
