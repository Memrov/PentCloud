import { catalogFixture } from "./fixture-services";
import {
  evidenceBytesHash,
  evidenceManifestPath,
  type EvidenceManifest
} from "../../src/native/evidence";
import { DurableObject } from "cloudflare:workers";
import { Coordinator } from "../../src/native/coordinator";
import {
  OnboardingStore,
  type OnboardingIO
} from "../../src/native/onboarding";
import { materialSelection } from "../../src/native/materials";
import { recordedWorkPage } from "../../src/native/recorded-work";
import { assertPreparationPromotion } from "../../src/native/preparation";
import type {
  AttemptInput,
  AttemptRecord,
  AttemptResult,
  NativeEnv,
  RunRecord
} from "../../src/native/types";

type Bindings = {
  COORDINATOR: DurableObjectNamespace<ProbeCoordinator>;
  ATTEMPTS: DurableObjectNamespace<FakeAttempt>;
};
export class FakeAttempt extends DurableObject<Bindings> {
  async recordedWork(runId: string, offset = 0) {
    return recordedWorkPage(
      {
        run_id: runId,
        messages: [
          {
            type: "assistant",
            content: [
              { type: "text", text: "Raw observation differs from handoff" }
            ]
          }
        ],
        remoteCalls: [{ name: "ffuf", state: "completed" }]
      },
      offset
    );
  }
  async prepareConversation(input: AttemptInput) {
    // The real NativeAttempt normalizes a queued record to immutable input.
    const {
      status: _status,
      revision: _revision,
      fingerprint: _fingerprint,
      materialUploadIds: _uploads,
      conversation: _conversation,
      ...prepared
    } = input as AttemptRecord;
    await this.ctx.storage.put("preparation", prepared);
    await this.ctx.storage.put(
      "preparations",
      ((await this.ctx.storage.get<number>("preparations")) ?? 0) + 1
    );
  }
  async conversationInfo() {
    return {
      prepared: !!(await this.ctx.storage.get("preparation")),
      preparations: (await this.ctx.storage.get<number>("preparations")) ?? 0,
      cancelled: !!(await this.ctx.storage.get("cancelled")),
      starts: (await this.ctx.storage.get<number>("starts")) ?? 0
    };
  }
  private readinessGate?: {
    entered: Promise<void>;
    enter: () => void;
    released: Promise<void>;
    release: () => void;
  };
  private running: Promise<AttemptResult> | undefined;
  private resolve?: (value: AttemptResult) => void;
  async run(input: AttemptInput): Promise<AttemptResult> {
    const preparation = await this.ctx.storage.get<AttemptInput>("preparation");
    if (preparation) assertPreparationPromotion(preparation, input);
    const prior = await this.ctx.storage.get<AttemptInput>("input");
    if (prior && JSON.stringify(prior) !== JSON.stringify(input))
      throw new Error("immutable input changed");
    await this.ctx.storage.put("input", input);
    await this.ctx.storage.put(
      "deliveries",
      ((await this.ctx.storage.get<number>("deliveries")) ?? 0) + 1
    );
    // Bound the injected failures so a regressed hot loop remains cheap to test.
    if (
      (await this.ctx.storage.get<boolean>("fail-rpc")) &&
      (await this.ctx.storage.get<number>("deliveries"))! <= 2
    )
      throw new Error("Injected immediate Attempt RPC failure");
    const result = await this.ctx.storage.get<AttemptResult>("result");
    if (result) return result;
    if (!this.running)
      await this.ctx.storage.put(
        "starts",
        ((await this.ctx.storage.get<number>("starts")) ?? 0) + 1
      );
    return (this.running ??= new Promise<AttemptResult>((resolve) => {
      this.resolve = resolve;
    }).finally(() => {
      this.running = undefined;
    }));
  }
  async unresolved(value: number) {
    await this.ctx.storage.put("unresolvedRemote", value);
  }
  async failRPC(enabled: boolean) {
    await this.ctx.storage.put("fail-rpc", enabled);
  }
  async platformMemory(sealed: boolean, unresolvedRemote: number) {
    await this.ctx.storage.put("recovery", {
      reason: "alarm_memory_limit",
      sealed,
      observedAt: Date.now(),
      purgedJobs: 0
    });
    await this.ctx.storage.put("unresolvedRemote", unresolvedRemote);
  }
  async rearmPlatformRecovery(observedAt: number) {
    const recovery = await this.ctx.storage.get<{ observedAt: number }>(
      "recovery"
    );
    if (recovery?.observedAt !== observedAt)
      throw new Error("409: platform recovery marker changed");
    if (await this.ctx.storage.get<number>("unresolvedRemote"))
      throw new Error("409: remote scanner outcome is unresolved");
    await this.ctx.storage.delete("recovery");
    return { rearmed: true };
  }
  async execution() {
    return {
      state: (await this.ctx.storage.get("cancelled"))
        ? "cancelled"
        : (await this.ctx.storage.get("result"))
          ? "settled"
          : (await this.ctx.storage.get("input"))
            ? "running"
            : "absent",
      drained:
        !this.running &&
        !(await this.ctx.storage.get<number>("unresolvedRemote")),
      unresolvedRemote:
        (await this.ctx.storage.get<number>("unresolvedRemote")) ?? 0,
      recovery: await this.ctx.storage.get("recovery"),
      result: await this.ctx.storage.get<AttemptResult>("result")
    };
  }
  async cancel() {
    await this.ctx.storage.put("cancelled", true);
  }
  async purge(runId: string) {
    const input = await this.ctx.storage.get<AttemptInput>("input");
    if (input && input.runId !== runId)
      throw new Error("409: wrong purge owner");
    if (!(await this.execution()).drained)
      throw new Error("409: attempt is draining");
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("purged", runId);
    return { purged: true };
  }
  async holdPurgeReadiness() {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    this.readinessGate = { entered, enter, released, release };
  }
  async waitPurgeReadiness() {
    await this.readinessGate!.entered;
  }
  async releasePurgeReadiness() {
    this.readinessGate!.release();
  }
  async purgeReadiness(_runId: string) {
    if (this.readinessGate) {
      this.readinessGate.enter();
      await this.readinessGate.released;
    }
    return { ...(await this.execution()), sessionCleanupPending: false };
  }
  async finish(result: AttemptResult) {
    await this.ctx.storage.put("result", result);
    this.resolve?.(result);
  }
  async release() {
    const input = await this.ctx.storage.get<AttemptInput>("input");
    if (!input) return;
    const result: AttemptResult = {
      id: input.id,
      runId: input.runId,
      status: "interrupted",
      inputCommit: input.inputCommit,
      promptDigest: "c".repeat(64),
      settingsRevision: input.settingsRevision,
      model: input.execution ? null : input.settings.model,
      ...(input.execution ? { executionKind: "discovery" as const } : {}),
      finishedAt: Date.now()
    };
    await this.ctx.storage.put("result", result);
    this.resolve?.(result);
  }
  async inspect() {
    return {
      ...(await this.execution()),
      deliveries: (await this.ctx.storage.get("deliveries")) ?? 0,
      starts: (await this.ctx.storage.get("starts")) ?? 0,
      input: await this.ctx.storage.get("input")
    };
  }
  async inputReady() {
    return !!(await this.ctx.storage.get("input"));
  }
}
export class ProbeCoordinator extends Coordinator {
  async bountyCheckErrorForTest() {
    const priorToken = Reflect.get(this.env, "CONTROL_TOKEN");
    const priorConnections = Reflect.get(this, "bountyConnections");
    const marker = "private-bounty-rejection";
    Reflect.set(this.env, "CONTROL_TOKEN", marker);
    Reflect.set(this, "bountyConnections", {
      check: async () => {
        throw new Error(`403: provider rejected ${marker}`);
      }
    });
    try {
      await this.onboardingAction(
        "bounty.check",
        { platform: "hackerone" },
        "fixture"
      );
      throw new Error("Expected provider rejection");
    } catch (error) {
      return { error: String(error) };
    } finally {
      Reflect.set(this, "bountyConnections", priorConnections);
      if (priorToken === undefined)
        Reflect.deleteProperty(this.env, "CONTROL_TOKEN");
      else Reflect.set(this.env, "CONTROL_TOKEN", priorToken);
    }
  }

  // Wrangler's Node bridge loses rejected DO RPC messages; keep negative assertions in workerd.
  async rejection(
    method:
      | "rearmPlatformRecovery"
      | "reconcileToolOutcome"
      | "delegationForTest"
      | "revisionForTest"
      | "acceptPrepared"
      | "createRun"
      | "invalidSettings",
    args: unknown[]
  ) {
    try {
      await Reflect.apply(Reflect.get(this, method), this, args);
    } catch (error) {
      return { error: String(error) };
    }
    throw new Error("Expected probe call to reject");
  }
  async streamRestartScenario(seed: boolean, after?: string) {
    const internal = this as unknown as {
      activityWriter(
        id: string
      ): Promise<import("agents/streams").StreamWriter>;
      activity(
        writer: import("agents/streams").StreamWriter,
        id: string,
        type: string
      ): void;
    };
    if (seed) {
      await this.seed(1, "coder", false);
      for (const [key, patch] of [
        ["run:run-0", { phase: "completed", status: "completed" }],
        ["job:job-0", { status: "completed" }]
      ] as const) {
        const row = this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one();
        this.write(key, { ...JSON.parse(row.value), ...patch });
      }
      const writer = await internal.activityWriter("run-0");
      internal.activity(writer, "run-0", "run.started");
      internal.activity(writer, "run-0", "run.completed");
    }
    const response = await this.stream(
      "run-0",
      new Request(
        "https://probe/workflow-events?protocol=2",
        after === undefined ? {} : { headers: { "Last-Event-ID": after } }
      )
    );
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: up-to-date")) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    await reader.cancel();
    return { text };
  }
  async nativeStreamsScenario() {
    await this.seed(1, "coder", false);
    const internal = this as unknown as {
      activityWriter(
        id: string
      ): Promise<import("agents/streams").StreamWriter>;
      activity(
        writer: import("agents/streams").StreamWriter,
        id: string,
        type: string,
        role?: string,
        job?: string,
        error?: string
      ): void;
      claimNext(): Promise<void>;
    };
    const read = <T>(key: string) =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      ) as T;
    const legacy = [
      {
        instanceId: "run-0",
        eventId: 101,
        timestamp: 100,
        type: "run.started"
      },
      {
        instanceId: "run-0",
        eventId: 205,
        timestamp: 200,
        type: "run.completed"
      }
    ];
    for (const event of legacy)
      this.ctx.storage.sql.exec(
        "INSERT INTO native_activity(id,run_id,value) VALUES(?,?,?)",
        event.eventId,
        event.instanceId,
        JSON.stringify(event)
      );
    this.ctx.storage.sql.exec(
      "INSERT INTO native_activity(run_id,value) VALUES(?,?)",
      "untouched-run",
      JSON.stringify({ ...legacy[0], instanceId: "untouched-run" })
    );
    // Fail halfway through import: native chunks and legacy deletion must roll back together.
    const open = this.streams.open.bind(this.streams);
    let injected = false;
    this.streams.open = async (...args) => {
      const writer = await open(...args),
        append = writer.append;
      writer.append = (chunk) => {
        if ((chunk as { timestamp?: number }).timestamp === 200 && !injected) {
          injected = true;
          throw new Error("injected import rollback");
        }
        return append(chunk);
      };
      return writer;
    };
    let migrationFailure = "";
    try {
      await internal.activityWriter("run-0");
    } catch (error) {
      migrationFailure = String(error);
    }
    this.streams.open = open;
    const afterFailure = {
      legacy: this.ctx.storage.sql
        .exec("SELECT * FROM native_activity WHERE run_id='run-0'")
        .toArray().length,
      cursor: (await this.streams.status("activity:v2:run-0"))?.cursor
    };
    const [writer, other] = await Promise.all([
      internal.activityWriter("run-0"),
      internal.activityWriter("run-0")
    ]);
    const importedCursor = writer.cursor;
    // Failure after append during a real claim must also roll back job/active authority.
    const activity = internal.activity.bind(this);
    internal.activity = (...args) => {
      activity(...args);
      throw new Error("injected claim rollback");
    };
    let claimFailure = "";
    try {
      await internal.claimNext();
    } catch (error) {
      claimFailure = String(error);
    }
    internal.activity = activity;
    const rollback = {
      cursor: writer.cursor,
      status: read<AttemptRecord>("job:job-0").status,
      active:
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            "active"
          )
          .toArray()
          .map((row) => JSON.parse(row.value))[0] ?? null
    };
    internal.activity(
      other,
      "run-0",
      "phase.started",
      "coder",
      "job-0",
      "probe fixture-key"
    );
    const replay = async (request: Request) => {
      const response = await this.stream("run-0", request);
      if (response.status !== 200)
        return { status: response.status, text: await response.text() };
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("event: up-to-date")) {
        const part = await reader.read();
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
      await reader.cancel();
      return { status: response.status, text };
    };
    const fresh = await replay(
      new Request("https://probe/workflow-events?protocol=2")
    );
    const reconnect = await replay(
      new Request("https://probe/workflow-events?protocol=2", {
        headers: { "Last-Event-ID": "0" }
      })
    );
    const old = await replay(
      new Request("https://probe/workflow-events?cursor=205")
    );
    this.write("job:job-0", {
      ...read<AttemptRecord>("job:job-0"),
      status: "completed"
    });
    this.write("run:run-0", {
      ...read<RunRecord>("run:run-0"),
      phase: "completed",
      status: "completed",
      repo: "run-run-0"
    });
    await this.revisionForTest(
      "job-0",
      "Revise completed work",
      "stream-revise"
    );
    const revised = await replay(
      new Request("https://probe/workflow-events?protocol=2")
    );
    const streaming = (await this.streams.status(writer.streamId))?.state;
    await this.cancelRun("run-0");
    // A writer open held before native open completes must not recreate data after purge.
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
    let pause = true;
    this.streams.open = async (...args) => {
      if (pause) {
        pause = false;
        entered();
        await held;
      }
      return open(...args);
    };
    const late = internal.activityWriter("run-0").then(
      () => "unexpected writer",
      (error) => String(error)
    );
    await reached;
    const live = await this.stream(
      "run-0",
      new Request("https://probe/workflow-events?protocol=2")
    );
    const reader = live.body!.getReader();
    let liveText = "";
    while (!liveText.includes("event: up-to-date")) {
      const part = await reader.read();
      liveText += new TextDecoder().decode(part.value);
    }
    const store = this as unknown as { put(key: string, value: unknown): void },
      put = store.put.bind(this);
    store.put = (key, value) => {
      put(key, value);
      if (key === "purged:run:run-0")
        throw new Error("injected purge commit rollback");
    };
    let purgeFailure = "";
    try {
      await this.purgeRun("run-0", "run-0");
    } catch (error) {
      purgeFailure = String(error);
    }
    const failedPurge = {
      state: (await this.streams.status(writer.streamId))?.state,
      tombstones: this.ctx.storage.sql
        .exec("SELECT key FROM native_records WHERE key='purged:run:run-0'")
        .toArray().length
    };
    store.put = put;
    await this.purgeRun("run-0", "run-0");
    release();
    const lateResult = await late;
    let tail = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      tail += new TextDecoder().decode(part.value);
    }
    this.streams.open = open;
    let lateAppend = "";
    try {
      internal.activity(writer, "run-0", "run.started");
    } catch (error) {
      lateAppend = String(error);
    }
    return {
      migrationFailure,
      afterFailure,
      importedCursor,
      claimFailure,
      rollback,
      fresh,
      reconnect,
      old,
      revised,
      streaming,
      purgeFailure,
      failedPurge,
      untouchedLegacy: this.ctx.storage.sql
        .exec("SELECT * FROM native_activity WHERE run_id='untouched-run'")
        .toArray().length,
      lateResult,
      lateAppend,
      tail,
      purged: (await this.streams.status(writer.streamId))?.state ?? null,
      legacyRemaining: this.ctx.storage.sql
        .exec("SELECT * FROM native_activity WHERE run_id='run-0'")
        .toArray().length
    };
  }
  async bountyGateScenario() {
    const target = (await this.onboardingAction(
      "target.save",
      {
        id: "bounty-gate-target",
        kind: "website",
        name: "Owned fixture",
        url: "https://owned.invalid/",
        revision: null
      },
      "fixture"
    )) as { id: string; revision: number };
    const denied: string[] = [];
    for (const [name, value] of [
      ["scope.names", {}],
      ["scope.search", { query: "fixture" }],
      ["scope.preview", { programId: "hackerone:fixture" }],
      [
        "scope.import",
        {
          id: target.id,
          revision: target.revision,
          programId: "hackerone:fixture"
        }
      ]
    ] as const) {
      try {
        await this.onboardingAction(name, value, "fixture");
      } catch (e) {
        if (String(e).includes("Bug bounty")) denied.push(name);
      }
    }
    const unavailable: string[] = [];
    for (const platform of ["bugcrowd", "yeswehack"])
      for (const [name, value] of [
        ["bounty.check", { platform }],
        ["scope.preview", { programId: platform + ":fixture" }],
        [
          "scope.import",
          {
            id: target.id,
            revision: target.revision,
            programId: platform + ":fixture"
          }
        ]
      ] as const) {
        try {
          await this.onboardingAction(name, value, "fixture");
        } catch (e) {
          if (String(e).includes("in development"))
            unavailable.push(platform + ":" + name);
        }
      }
    return {
      denied,
      unavailable,
      status: await this.onboardingAction("bounty.status", {}, "fixture")
    };
  }
  override async createRun(
    input: import("../../src/native/types").NewRunInput
  ) {
    if (
      this.ctx.storage.sql
        .exec(
          "SELECT key FROM native_records WHERE key IN (?,?)",
          "lifecycle:quiesced",
          "purged:run:" + input.run_id
        )
        .toArray().length
    )
      return super.createRun(input);
    // Test fixtures provide an already verified owned target; never perform a network check.
    const target = {
      id: "probe-target",
      name: "Owned fixture",
      kind: "website",
      url: "https://owned.invalid/",
      revision: 1,
      archived: false,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: "fixture",
      objective: "",
      exclusions: ""
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO native_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      "onboarding:target:probe-target",
      JSON.stringify(target)
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO native_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      "onboarding:target-proof:probe-target",
      JSON.stringify({
        targetId: target.id,
        targetRevision: 1,
        url: target.url,
        status: 200,
        classification: "reachable",
        checkedAt: Date.now(),
        expiresAt: Date.now() + 300000
      })
    );
    return super.createRun({
      ...input,
      target_id: target.id,
      target_revision: 1,
      authorized: true,
      actor: "fixture"
    });
  }

  constructor(ctx: DurableObjectState, bindings: Bindings) {
    const artifacts = {
      get: async (name: string) => ({
        log: async () => {
          const row = ctx.storage.sql
            .exec<{
              value: string;
            }>(
              "SELECT value FROM native_records WHERE key=?",
              `remote:${name.replace(/^(?:pentcloud|run)-/, "")}`
            )
            .toArray()[0];
          return row ? [{ hash: JSON.parse(row.value) }] : [];
        },
        readCommit: async (hash: string) => {
          const row = ctx.storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM native_records WHERE key=?",
              `evidence-commit:${hash}`
            )
            .toArray()[0];
          return row ? JSON.parse(row.value) : { treeHash: hash };
        },
        readTree: async (hash: string) => {
          const row = ctx.storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM native_records WHERE key=?",
              `evidence-tree:${hash}`
            )
            .toArray()[0];
          return row
            ? JSON.parse(row.value)
            : ctx.storage.sql
                .exec<{ key: string }>(
                  "SELECT key FROM native_records WHERE key LIKE ?",
                  `blob:${hash}:%`
                )
                .toArray()
                .map((row) => ({
                  name: row.key.slice(`blob:${hash}:`.length),
                  type: "blob",
                  hash
                }));
        },
        createToken: async (scope: "read" | "write") => ({
          plaintext: `probe-token-${scope}`
        }),
        readFile: async ({ ref, path }: { ref: string; path: string }) => {
          const row = ctx.storage.sql
            .exec<{
              value: string;
            }>(
              "SELECT value FROM native_records WHERE key=?",
              `blob:${ref}:${path}`
            )
            .toArray()[0];
          if (!row) return null;
          const value = JSON.parse(row.value);
          return new Blob([
            Array.isArray(value) ? new Uint8Array(value) : value
          ]);
        },
        [Symbol.dispose]() {}
      })
    };
    super(ctx, {
      ...bindings,
      ARTIFACTS: artifacts,
      CONTROL_TOKEN: "probe",
      OPENCODE_GO_API_KEY: "fixture-key",
      TOOLBOX: {
        clear: async () => {
          await ctx.storage.put(
            "probe:scannerClears",
            ((await ctx.storage.get<number>("probe:scannerClears")) ?? 0) + 1
          );
          return (await ctx.storage.get("probe:scannerClearFailure"))
            ? { error: "unavailable" }
            : { state: "stopped" };
        }
      }
    } as unknown as NativeEnv);
    this.workspace.artifacts.get = async (name: string) =>
      ({ name, remote: `https://example.invalid/${name}.git` }) as never;
    this.workspace.artifacts.delete = async (name: string) => {
      if (
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            "probe:delete-failure"
          )
          .toArray()[0]?.value === "true"
      ) {
        this.write("probe:delete-failure", false);
        throw new Error("503: injected repository delete failure");
      }
      this.write(`deleted:${name}`, true);
      return true;
    };
    this.workspace.git.fetch = async (options) => {
      if (
        options?.headers?.Authorization !==
        `Basic ${btoa("x:probe-token-read")}`
      )
        throw new Error("Git fetch must receive a read-only repository token");
      return {} as never;
    };
    this.workspace.git.push = async (options) => {
      if (
        options?.headers?.Authorization !==
        `Basic ${btoa("x:probe-token-write")}`
      )
        throw new Error("Git push must receive a write repository token");
      const row = ctx.storage.sql
        .exec<{
          value: string;
        }>("SELECT value FROM native_records WHERE key=?", "probe:pushes")
        .toArray()[0];
      this.write("probe:pushes", (row ? JSON.parse(row.value) : 0) + 1);
      const blocked = ctx.storage.sql
        .exec<{
          value: string;
        }>(
          "SELECT value FROM native_records WHERE key=?",
          "probe:block-projection"
        )
        .toArray()[0];
      const ok =
        options.ref !== "main" || !blocked || !JSON.parse(blocked.value);
      if (ok && options.dir && options.ref?.startsWith("inputs/")) {
        if (
          ctx.storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM native_records WHERE key=?",
              "probe:interrupt-material"
            )
            .toArray()[0]?.value === "true"
        ) {
          this.write("probe:interrupt-material", false);
          await this.interrupt("job-0");
        }
        const commit = await this.workspace.git.revParse({
          dir: options.dir,
          ref: options.ref
        });
        for (const path of await this.workspace.git.lsFiles({
          dir: options.dir
        })) {
          const stream = await this.workspace.fs.readFile(
            `${options.dir}/${path}`
          );
          this.write(
            `blob:${commit}:${path}`,
            Array.from(new Uint8Array(await new Response(stream).arrayBuffer()))
          );
        }
      }
      if (ok && options?.dir)
        this.write(
          `remote:${options.dir.split("/").at(-1)}`,
          await this.workspace.git.revParse({ dir: options.dir, ref: "main" })
        );
      return { ok, error: null, refs: {} };
    };
  }
  private write(key: string, value: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO native_records(key,value) VALUES(?,?)",
      key,
      JSON.stringify(value)
    );
  }
  async onboardingLifecycle() {
    await this.onboardingAction(
      "target.save",
      {
        id: "library-target",
        kind: "api",
        name: "Owned API",
        url: "https://owned.invalid/v1/",
        revision: null
      },
      "fixture"
    );
    this.write("onboarding:credential:library-key", {
      id: "library-key",
      purpose: "api",
      targetId: "library-target",
      audienceURL: "https://owned.invalid/v1/",
      targetRevision: 1,
      scheme: "bearer",
      header: "Authorization",
      label: "API",
      version: 1,
      revoked: false,
      missing: true,
      updatedAt: 0,
      updatedBy: "fixture"
    });
    const before = await this.lifecycleStatus(),
      exported = await this.onboardingExport();
    let retained = "";
    try {
      await this.prepareUninstall();
    } catch (error) {
      retained = String(error);
    }
    const after = await this.prepareUninstall(true);
    const rows = this.ctx.storage.sql
      .exec<{ key: string }>(
        "SELECT key FROM native_records WHERE key LIKE 'onboarding:%'"
      )
      .toArray();
    return {
      before,
      retained,
      after,
      rows,
      credential: exported.credentials.find(
        (credential) => credential.id === "library-key"
      ),
      secretExported: exported.credentials.some(
        (credential) => "value" in credential
      )
    };
  }
  async findingsScenario() {
    await this.seed(1, "coder", false);
    const read = <T>(key: string): T =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      );
    const commit = "a".repeat(40),
      job = {
        ...read<AttemptRecord>("job:job-0"),
        role: "reporter" as const,
        status: "completed" as const,
        outputCommit: commit,
        terminal: { tool: "report_result", arguments: { report: "Reviewed" } }
      };
    this.write("job:job-0", job);
    const legacy = await this.findings("run-0", "job-0");
    const doc = {
      version: 1,
      coverage: "complete",
      summary: "Owned fixture",
      reportPath: ".pentagi/evidence/job-0/report.md",
      findings: [
        {
          id: "f1",
          title: "Owned marker",
          severity: "high",
          status: "confirmed",
          target: "https://owned.invalid/",
          summary: "Owned fixture",
          evidence: "Recorded output",
          report: "## Remediation\nCheck ownership",
          evidencePaths: ["proof.txt"]
        }
      ]
    };
    this.write(
      `blob:${commit}:.pentagi/evidence/job-0/findings.json`,
      JSON.stringify(doc)
    );
    this.write(`blob:${commit}:${doc.reportPath}`, "# Owned report");
    this.write(`blob:${commit}:proof.txt`, "Owned proof");
    this.write("job:job-0", { ...job, findingsVersion: 1, finishedAt: 2 });
    const bundle = await this.findings("run-0", "job-0");
    this.write("job:earlier-report", {
      ...job,
      id: "earlier-report",
      outputCommit: "b".repeat(40),
      finishedAt: 1
    });
    this.write("job:failed-report", {
      ...job,
      id: "failed-report",
      status: "failed",
      finishedAt: 3
    });
    const latest = await this.findings("run-0", "");
    const older = await this.findings("run-0", "earlier-report");
    let wrong: string | undefined;
    try {
      await this.findings("run-0", "other");
    } catch (e) {
      wrong = String(e);
    }
    this.write("job:job-0", { ...job, findingsVersion: 1 });
    this.write(
      `blob:${commit}:.pentagi/evidence/job-0/findings.json`,
      JSON.stringify({
        ...doc,
        findings: [{ ...doc.findings[0], evidencePaths: ["missing.txt"] }]
      })
    );
    let missing: string | undefined;
    try {
      await this.findings("run-0", "job-0");
    } catch (e) {
      missing = String(e);
    }
    return { legacy, bundle, latest, older, wrong, missing };
  }
  async directDeleteScenario(mode: string) {
    if (mode === "tool-packs") {
      delete this.env.TOOLBOX;
      this.env.TOOL_PACKS = {
        ready: async () => ({}),
        run: async () => ({}),
        stop: async () => ({ stopped: true })
      };
    }
    await this.seed(1, "coder", false);
    const read = <T>(key: string) =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      ) as T;
    const job = read<AttemptRecord>("job:job-0"),
      run = read<RunRecord>("run:run-0");
    this.write("run:run-0", {
      ...run,
      repo: "run-run-0",
      phase: "completed",
      status: "completed"
    });
    this.write("job:job-0", { ...job, status: "completed" });
    this.write("active", null);
    if (mode === "other-active")
      this.write("active", {
        id: "other-job",
        input: { ...job, id: "other-job", runId: "other-run" }
      });
    if (mode === "clear-failure") {
      await this.trashRun("run-0");
      await this.ctx.storage.put("probe:scannerClearFailure", true);
    }
    let error: string | undefined;
    try {
      await this.purgeRun("run-0", "run-0");
    } catch (e) {
      error = String(e);
    }
    const before = await this.snapshot();
    let blocked = false,
      after: unknown;
    if (mode === "clear-failure") {
      this.write("run:other-run", {
        ...run,
        id: "other-run",
        phase: "specialists"
      });
      this.write("job:other-job", {
        ...job,
        id: "other-job",
        runId: "other-run",
        status: "created"
      });
      await (this as unknown as { claimNext(): Promise<void> }).claimNext();
      blocked = read<unknown>("active") === null;
      await this.ctx.storage.put("probe:scannerClearFailure", false);
      after = await this.purgeRun("run-0", "run-0");
    }
    return {
      error,
      before,
      blocked,
      after,
      clears: (await this.ctx.storage.get<number>("probe:scannerClears")) ?? 0
    };
  }
  async lifecycleScenario(mode: string) {
    await this.seed(1, "coder", false);
    const read = <T>(key: string): T =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      );
    this.write("run:run-0", {
      ...read<RunRecord>("run:run-0"),
      repo: mode === "protected" ? "fixture-protected-source" : "run-run-0",
      phase: "completed",
      status: "completed"
    });
    this.write("job:job-0", {
      ...read<AttemptRecord>("job:job-0"),
      status: "completed"
    });
    const archived = await this.archiveRun("run-0"),
      hidden = await this.listRuns(),
      visible = await this.listRuns("archived");
    const restored = await this.restoreRun("run-0");
    const acceptedCommit = "a".repeat(40),
      reportArgs = { report: "# Accepted report\nExact evidence\n" };
    this.write("job:job-0", {
      ...read<AttemptRecord>("job:job-0"),
      role: "reporter",
      outputCommit: acceptedCommit,
      terminal: { tool: "report_result", arguments: reportArgs }
    });
    this.write(
      `blob:${acceptedCommit}:.pentagi/jobs/job-0/result.json`,
      JSON.stringify({
        run_id: "run-0",
        job_id: "job-0",
        role: "reporter",
        tool: "report_result",
        arguments: reportArgs
      })
    );
    const reportResponse = await this.report("run-0", "job-0");
    const report = {
      text: await reportResponse.text(),
      commit: reportResponse.headers.get("X-Source-Commit")
    };
    let wrongReport: string | undefined;
    try {
      await this.report("run-0", "other-job");
    } catch (e) {
      wrongReport = String(e);
    }
    const trashed = await this.trashRun("run-0");
    if (mode === "unresolved")
      await (
        this.env.ATTEMPTS.getByName(
          "job-0"
        ) as unknown as DurableObjectStub<FakeAttempt>
      ).platformMemory(false, 1);
    if (mode === "retry") this.write("probe:delete-failure", true);
    let error: string | undefined;
    try {
      await this.purgeRun("run-0", "run-0");
    } catch (e) {
      error = String(e);
    }
    if (mode === "unresolved" || mode === "protected")
      return {
        archived,
        hidden,
        visible,
        restored,
        trashed,
        error,
        report,
        wrongReport,
        snapshot: await this.snapshot()
      };
    const deleted = await this.purgeRun("run-0", "run-0");
    const duplicate = await this.purgeRun("run-0", "run-0");
    let resurrection: string | undefined;
    try {
      await this.createRun({ run_id: "run-0", task: "late" });
    } catch (e) {
      resurrection = String(e);
    }
    const lifecycle = await this.lifecycleStatus();
    const quiesced = await this.prepareUninstall();
    let admission: string | undefined;
    try {
      await this.createRun({ run_id: "new", task: "late" });
    } catch (e) {
      admission = String(e);
    }
    return {
      archived,
      hidden,
      visible,
      restored,
      trashed,
      error,
      report,
      wrongReport,
      deleted,
      duplicate,
      resurrection,
      lifecycle,
      quiesced,
      admission,
      snapshot: await this.snapshot()
    };
  }
  private trashGate?: { entered: Promise<void>; release: () => void };
  async prepareTrashGate() {
    await this.seed(1, "coder", false);
    let entered!: () => void,
      release!: () => void,
      used = false;
    const reached = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    this.trashGate = { entered: reached, release };
    const pause = async () => {
      if (!used) {
        used = true;
        entered();
        await held;
      }
    };
    const internal = this as unknown as { start: () => Promise<void> };
    const start = internal.start.bind(this);
    internal.start = async () => {
      await pause();
      await start();
    };
  }
  async waitTrashGate() {
    await this.trashGate!.entered;
  }
  async releaseTrashGate() {
    this.trashGate!.release();
  }
  async purgeRaceScenario() {
    await this.seed(1, "coder", false);
    const read = <T>(key: string): T =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      );
    this.write("run:run-0", {
      ...read<RunRecord>("run:run-0"),
      repo: "run-run-0",
      phase: "completed",
      status: "completed"
    });
    this.write("job:job-0", {
      ...read<AttemptRecord>("job:job-0"),
      status: "completed"
    });
    await this.trashRun("run-0");
    const attempt = this.env.ATTEMPTS.getByName(
      "job-0"
    ) as unknown as DurableObjectStub<FakeAttempt>;
    await attempt.holdPurgeReadiness();
    const purge = this.purgeRun("run-0", "run-0").then(
      (value) => ({ value, error: "" }),
      (error) => ({ error: String(error) })
    );
    await attempt.waitPurgeReadiness();
    await this.restoreRun("run-0");
    const revision = await this.revise(
      "job-0",
      "New work during readiness",
      "purge-race"
    );
    await this.recoverNow();
    await this.trashRun("run-0");
    const before = await this.snapshot();
    await attempt.releasePurgeReadiness();
    return {
      revision,
      before,
      outcome: await purge,
      after: await this.snapshot()
    };
  }
  async createRaceScenario(mode: string) {
    await this.lifecycle.start();
    const repositories: string[] = [];
    this.workspace.artifacts.get = async (name) => {
      if (!repositories.includes(name))
        throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
      return { name, remote: `https://example.invalid/${name}.git` } as never;
    };
    this.workspace.artifacts.create = async (name) => {
      repositories.push(name);
      return {} as never;
    };
    this.workspace.artifacts.delete = async (name) => {
      repositories.splice(repositories.indexOf(name), 1);
      return true;
    };
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const original = crypto.subtle.digest;
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (algorithm: AlgorithmIdentifier, bytes: BufferSource) => {
        if (
          new TextDecoder().decode(bytes) ===
          '{"initial":true,"run":"creation-race"}'
        ) {
          reached();
          await gate;
          if (mode === "failure")
            throw new Error("injected post-project preparation failure");
        }
        return original.call(crypto.subtle, algorithm, bytes);
      }
    });
    const creation = this.createRun({
      run_id: "creation-race",
      task: "Hold admission after repository creation"
    }).then(
      (value) => ({ value, error: "" }),
      (error) => ({ error: String(error) })
    );
    try {
      await entered;
      const before = await this.lifecycleStatus(),
        pendingCreation = await this.creationSnapshot("creation-race");
      let discard = "",
        uninstall = "";
      try {
        await this.discardDraft("creation-race");
      } catch (error) {
        discard = String(error);
      }
      try {
        await this.prepareUninstall();
      } catch (error) {
        uninstall = String(error);
      }
      release();
      const outcome = await creation;
      const after = await this.lifecycleStatus();
      let failedUninstall = "";
      if (mode === "failure") {
        try {
          await this.prepareUninstall();
        } catch (error) {
          failedUninstall = String(error);
        }
        await this.discardDraft("creation-race");
      }
      return {
        before,
        pendingCreation,
        discard,
        uninstall,
        outcome,
        after,
        failedUninstall,
        repositories,
        final: await this.lifecycleStatus()
      };
    } finally {
      release();
      Object.defineProperty(crypto.subtle, "digest", {
        configurable: true,
        value: original
      });
    }
  }
  async duplicateCreateScenario(mode = "same") {
    await this.settings();
    const uploadIds: string[] = [];
    if (mode === "uploads") {
      const bytes = new TextEncoder().encode(
        "# Duplicate request attachment\n"
      );
      const sha = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
      ]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      const upload = await this.stageUpload({
        runId: "duplicate-create",
        id: "duplicate-upload",
        name: "evidence.md",
        sha256: sha,
        body: new Blob([bytes]).stream(),
        uploadedBy: "probe"
      });
      uploadIds.push(upload.id);
    }
    const original = this.settings.bind(this);
    let held = false,
      entered!: () => void,
      release!: () => void;
    const reached = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    this.settings = async () => {
      const current = await original();
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return current;
    };
    const input = {
      run_id: "duplicate-create",
      task: "One admitted run from overlapping creates"
    };
    const slower = this.createRun({
      ...input,
      ...(mode === "objective" ? { task: "Conflicting objective" } : {}),
      ...(uploadIds.length ? { upload_ids: uploadIds } : {})
    }).then(
      (value) => ({ value, error: "" }),
      (error) => ({ value: undefined, error: String(error) })
    );
    try {
      await reached;
      const faster = await this.createRun(input);
      const admitted = await this.lifecycleStatus();
      await this.onboardingAction(
        "setup.save",
        { runId: input.run_id, revision: 0, draft: { publicAPI: false } },
        "second-operator"
      );
      release();
      const outcome = await slower,
        duplicate = outcome.value,
        duplicateError = outcome.error;
      const afterDuplicate = await this.lifecycleStatus(),
        setupAfterDuplicate = await this.onboardingSnapshot(input.run_id);
      const jobs = (await this.getRun(input.run_id)).jobs;
      await this.trashRun(input.run_id);
      await (
        this.env.ATTEMPTS.getByName(
          faster.rootJob.id
        ) as unknown as DurableObjectStub<FakeAttempt>
      ).release();
      await this.recoverNow();
      const deleted = await this.purgeRun(input.run_id, input.run_id);
      const afterPurge = await this.lifecycleStatus();
      let uninstallError = "",
        quiesced;
      try {
        quiesced = await this.prepareUninstall(true);
      } catch (error) {
        uninstallError = String(error);
      }
      return {
        faster,
        duplicate,
        duplicateError,
        admitted,
        afterDuplicate,
        setupAfterDuplicate,
        jobs,
        deleted,
        afterPurge,
        quiesced,
        uninstallError,
        snapshot: await this.snapshot()
      };
    } finally {
      release();
      this.settings = original;
    }
  }
  async materialScenario(mode = "initial") {
    await this.lifecycle.start();
    const bytes = new TextEncoder().encode("# Evidence\nconfig = ß\n");
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const receipt = await this.stageUpload({
      runId: "run-0",
      id: "upload-1",
      name: "config.md",
      sha256: sha,
      body: new Blob([bytes]).stream(),
      uploadedBy: "probe"
    });
    const initialIds = [receipt.id];
    if (mode === "capacity" || mode === "rejected")
      for (let index = 2; index <= 9; index++) {
        const next = await this.stageUpload({
          runId: "run-0",
          id: `upload-${index}`,
          name: `config-${index}.md`,
          sha256: sha,
          body: new Blob([bytes]).stream(),
          uploadedBy: "probe"
        });
        if (index <= 7) initialIds.push(next.id);
      }
    await this.seed(mode === "interrupted" ? 2 : 1, "coder", false);
    const readRecord = <T>(key: string): T =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      );
    const initial = readRecord<RunRecord>("run:run-0");
    if (mode === "advanced-head") {
      // Accepted publication advances the ref without updating this cached index.
      const dir = "/accepted/run-0";
      await this.workspace.git.branch({
        dir,
        name: "accepted-attempt",
        checkout: true
      });
      await this.workspace.fs.writeFile(
        `${dir}/accepted-proof.txt`,
        "Retain accepted evidence\n"
      );
      await this.workspace.git.add({ dir, paths: ["accepted-proof.txt"] });
      const accepted = await this.workspace.git.commit({
        dir,
        message: "accepted discovery"
      });
      await this.workspace.git.checkout({ dir, ref: "main" });
      await this.workspace.git.updateRef({
        dir,
        ref: "refs/heads/main",
        value: accepted.oid,
        force: true
      });
      this.write("run:run-0", { ...initial, headCommit: accepted.oid });
    }
    if (mode === "active") {
      await this.recoverNow();
      const before = readRecord<{ input: AttemptInput }>("active");
      const revision = await this.revise(
        "job-0",
        "Review the attached file",
        "file-revision",
        undefined,
        [receipt.id]
      );
      const duplicate = await this.revise(
        "job-0",
        "Review the attached file",
        "file-revision",
        undefined,
        [receipt.id]
      );
      const after = readRecord<{ input: AttemptInput }>("active");
      return {
        before,
        after,
        revision,
        duplicate,
        head: readRecord<RunRecord>("run:run-0").headCommit
      };
    }
    const job = readRecord<AttemptRecord>("job:job-0");
    this.write("job:" + job.id, { ...job, materialUploadIds: initialIds });
    if (mode === "projection") await this.projectionBlock(true);
    if (mode === "interrupted") this.write("probe:interrupt-material", true);
    let error: string | undefined;
    try {
      await this.recoverNow();
    } catch (e) {
      error = String(e);
    }
    if (mode === "interrupted") {
      await this.recoverNow();
      return { error, snapshot: await this.snapshot() };
    }
    if (
      mode === "advanced-head" &&
      !(await this.snapshot()).records.find((row) => row.key === "active")
        ?.value
    )
      return {
        error: readRecord<AttemptRecord>("job:job-0").inputError,
        snapshot: await this.snapshot()
      };
    const prepared = readRecord<RunRecord>("run:run-0");
    const held = (await this.snapshot()).records.find(
      (row) => row.key === "active"
    )?.value;
    if (mode === "projection") {
      await this.projectionBlock(false);
      await this.recoverNow();
    }
    const settled = readRecord<RunRecord>("run:run-0");
    const launch = readRecord<{ input: AttemptInput }>("active");
    if (mode === "rejected") {
      const revision = await this.revise(
        "job-0",
        "Add eighth",
        "capacity-1",
        undefined,
        ["upload-8"]
      );
      const queued = readRecord<AttemptRecord>(`job:${revision.job.id}`);
      this.write(`job:${queued.id}`, {
        ...queued,
        materialUploadIds: ["upload-8", "upload-9"]
      });
      this.write("job:job-0", {
        ...readRecord<AttemptRecord>("job:job-0"),
        status: "interrupted"
      });
      this.write("active", null);
      await this.recoverNow();
      return {
        rejected: (await this.queueSnapshot()).jobs.find(
          (j) => j.id === queued.id
        ),
        snapshot: await this.snapshot()
      };
    }
    if (mode === "capacity") {
      const revision = await this.revise(
        "job-0",
        "Add eighth",
        "capacity-1",
        undefined,
        ["upload-8"]
      );
      let rejected: string | undefined;
      try {
        await this.revise("job-0", "Add ninth", "capacity-2", undefined, [
          "upload-9"
        ]);
      } catch (e) {
        rejected = String(e);
      }
      const duplicate = await this.revise(
        "job-0",
        "Add eighth",
        "capacity-1",
        undefined,
        ["upload-8"]
      );
      return { rejected, revision, duplicate, snapshot: await this.snapshot() };
    }
    if (mode === "metadata") {
      const later = await materialSelection(undefined, [
        {
          ...settled.materials!.files[0]!,
          id: "renamed-upload",
          name: "renamed.md"
        }
      ]);
      this.write("input:receipt:later", {
        runId: "run-0",
        jobId: "later",
        baseCommit: settled.headCommit,
        commit: "f".repeat(40),
        branch: "inputs/later",
        uploadIds: [],
        selection: later
      });
      this.write("run:run-0", {
        ...settled,
        headCommit: "f".repeat(40),
        materials: later
      });
      const listing = await this.files("run-0", "job-0");
      const download = await this.file(
        "run-0",
        settled.headCommit,
        receipt.sourcePath,
        false
      );
      return {
        listing,
        disposition: download.headers.get("Content-Disposition")
      };
    }
    const file = await this.file(
      "run-0",
      settled.headCommit,
      receipt.sourcePath,
      false
    );
    const acceptedProof =
      mode === "advanced-head"
        ? await this.workspace.fs.readFile(
            "/accepted/run-0/accepted-proof.txt",
            "utf8"
          )
        : undefined;
    return {
      initial,
      prepared,
      settled,
      launch,
      held,
      error,
      receipt,
      acceptedProof,
      content: await file.text(),
      snapshot: await this.snapshot()
    };
  }
  async recordedWorkScenario() {
    await this.seed(1, "coder", false);
    await this.recoverNow();
    const read = <T>(key: string) =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      ) as T;
    const requester = read<AttemptRecord>("job:job-0");
    this.write("job:job-0", { ...requester, role: "reporter" });
    this.write("job:source", {
      ...requester,
      id: "source",
      role: "pentester",
      status: "failed",
      inputError: "TOKEN=private-assignment",
      finishedAt: Date.now()
    });
    this.write("job:foreign", {
      ...requester,
      id: "foreign",
      runId: "other-run",
      status: "completed"
    });
    const catalog = JSON.parse((await this.readRunWork(requester.id)).text),
      source = JSON.parse(
        (await this.readRunWork(requester.id, "source")).text
      );
    let crossRun = false,
      self = false,
      wrongRole = false,
      stopped = false;
    try {
      await this.readRunWork(requester.id, "foreign");
    } catch {
      crossRun = true;
    }
    try {
      await this.readRunWork(requester.id, requester.id);
    } catch {
      self = true;
    }
    this.write("job:job-0", requester);
    try {
      await this.readRunWork(requester.id, "source");
    } catch {
      wrongRole = true;
    }
    this.write("job:job-0", {
      ...requester,
      role: "reporter",
      status: "interrupted"
    });
    try {
      await this.readRunWork(requester.id, "source");
    } catch {
      stopped = true;
    }
    return { catalog, source, crossRun, self, wrongRole, stopped };
  }
  async evidenceScenario() {
    await this.seed(1, "coder", false);
    await this.recoverNow();
    const read = <T>(key: string) =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      ) as T;
    const job = read<AttemptRecord>("job:job-0"),
      path = ".pentagi/evidence/job-0/captured/known/result.json",
      body = '{"status":"completed","evidence":"retained on stop"}';
    const manifest: EvidenceManifest = {
      version: 1,
      runId: job.runId,
      jobId: job.id,
      inputCommit: job.inputCommit,
      promptDigest: "c".repeat(64),
      sequence: 1,
      files: [
        {
          path,
          size: new TextEncoder().encode(body).length,
          sha256: await evidenceBytesHash(new TextEncoder().encode(body)),
          tool: "fixture",
          receiptId: "call-one",
          source: "tool-result"
        }
      ]
    };
    const text = JSON.stringify(manifest) + "\n",
      manifestPath = evidenceManifestPath(job.id),
      commit = "e".repeat(40),
      before = "1".repeat(40),
      after = "2".repeat(40),
      p = "3".repeat(40),
      e = "4".repeat(40),
      owned = "5".repeat(40),
      captured = "6".repeat(40),
      known = "7".repeat(40);
    this.write(`evidence-commit:${job.inputCommit}`, {
      parents: [],
      treeHash: before
    });
    this.write(`evidence-commit:${commit}`, {
      parents: [job.inputCommit],
      treeHash: after
    });
    const trees: Record<string, unknown> = {
      [before]: [],
      [after]: [{ name: ".pentagi", type: "tree", hash: p }],
      [p]: [{ name: "evidence", type: "tree", hash: e }],
      [e]: [{ name: job.id, type: "tree", hash: owned }],
      [owned]: [
        { name: "manifest.json", type: "blob", hash: "8".repeat(40) },
        { name: "captured", type: "tree", hash: captured }
      ],
      [captured]: [{ name: "known", type: "tree", hash: known }],
      [known]: [{ name: "result.json", type: "blob", hash: "9".repeat(40) }]
    };
    for (const [key, value] of Object.entries(trees))
      this.write(`evidence-tree:${key}`, value);
    this.write(`blob:${commit}:${path}`, body);
    this.write(`blob:${commit}:${manifestPath}`, text);
    const receipt = {
      commit,
      parentCommit: job.inputCommit,
      manifestPath,
      manifestDigest: await evidenceBytesHash(new TextEncoder().encode(text)),
      sequence: 1
    };
    await this.recordEvidence(job.id, receipt);
    await this.recordEvidence(job.id, receipt);
    const listing = await this.files(job.runId, job.id),
      content = await (await this.readEvidence(job.id, job.id, path)).text();
    let forged = false;
    try {
      await this.file(job.runId, "f".repeat(40), path);
    } catch {
      forged = true;
    }
    this.write("job:foreign-job", {
      ...job,
      id: "foreign-job",
      runId: "other-run",
      evidence: receipt
    });
    let crossRun = false;
    try {
      await this.readEvidence(job.id, "foreign-job", path);
    } catch {
      crossRun = true;
    }
    // Simulate a push whose registration reply was lost before Stop arrived.
    const beforeCancel = read<AttemptRecord>("job:" + job.id);
    delete beforeCancel.evidence;
    delete beforeCancel.evidenceCommits;
    delete beforeCancel.evidenceFiles;
    this.write("job:" + job.id, beforeCancel);
    await this.cancelRun(job.runId);
    await this.assertEvidenceOwner(job.id);
    await this.recordEvidence(job.id, receipt);
    const afterStop = await this.files(job.runId, job.id),
      stoppedContent = await (await this.file(job.runId, commit, path)).text();
    return {
      listing,
      content,
      forged,
      crossRun,
      afterStop,
      stoppedContent,
      mainUnchanged:
        read<{ headCommit: string }>("run:" + job.runId).headCommit ===
        job.inputCommit,
      job: read<AttemptRecord>("job:" + job.id)
    };
  }
  async browserAuthLifecycle() {
    await this.seed(1, "coder", false);
    const key = "browser-auth:run-0",
      entry = {
        expiresAt: Date.now() + 1800000,
        state: { cookies: [], origins: [] }
      };
    const exists = () =>
      !!this.ctx.storage.sql
        .exec("SELECT key FROM native_records WHERE key=?", key)
        .toArray().length;
    this.write(key, entry);
    await this.cancelRun("run-0");
    const cancelled = !exists();
    for (const value of [
      { id: "run-0", phase: "completed" },
      { id: "run-0", phase: "setup", lifecycle: "archived" }
    ]) {
      this.write(key, entry);
      (this as unknown as { put(k: string, v: unknown): void }).put(
        "run:run-0",
        value
      );
      if (exists())
        throw Error("Terminal/lifecycle update retained browser login");
    }
    return { cancelled, completed: true, archived: true };
  }
  async seed(count = 2, role: "primary" | "coder" = "coder", notify = true) {
    await this.lifecycle.start();
    await this.lifecycle.jobs.reschedule(
      "pentcloud:recover",
      Date.now() + 60000
    );
    const settings = {
      promptTemplate: "probe",
      upstreamPromptDigest: "b".repeat(64),
      model: "opencode-go:deepseek-v4-pro",
      reasoningEffort: "default" as const
    };
    for (let index = 0; index < count; index++) {
      const id = `job-${index}`,
        runId = `run-${index}`,
        dir = `/accepted/${runId}`;
      await this.workspace.fs.mkdir(dir, { recursive: true });
      await this.workspace.git.init({ dir, defaultBranch: "main" });
      await this.workspace.fs.writeFile(`${dir}/README.md`, "baseline\n");
      await this.workspace.git.add({ dir, paths: ["README.md"] });
      const base = await this.workspace.git.commit({
        dir,
        message: "baseline"
      });
      this.write(`remote:${runId}`, base.oid);
      const run = {
        target: {
          id: "seed-" + runId,
          name: "Owned fixture",
          kind: "website",
          url: "https://owned.invalid/",
          revision: 1,
          archived: false,
          createdAt: 0,
          updatedAt: 0,
          updatedBy: "fixture",
          objective: "",
          exclusions: ""
        },
        id: runId,
        task: "probe",
        status: "created",
        repo: "probe",
        remote: "https://example.invalid/repo.git",
        inputCommit: base.oid,
        headCommit: base.oid,
        settingsRevision: "s",
        settings: {
          revision: "s",
          roles: Object.fromEntries(
            [
              "primary",
              "adviser",
              "coder",
              "maintenance",
              "memorist",
              "pentester",
              "searcher"
            ].map((role) => [role, settings])
          )
        },
        createdAt: index,
        wave: 0,
        phase: "specialists",
        maxDepth: 4,
        maxJobs: 48
      } as RunRecord;
      const job: AttemptRecord = {
        id,
        runId,
        role,
        tool: role,
        args: { task: "probe", message: "probe" },
        task: "probe",
        inputCommit: run.headCommit,
        repo: run.repo,
        remote: run.remote,
        settingsRevision: "s",
        settings,
        depth: 0,
        attempt: 1,
        logicalThreadId: id,
        context: {},
        createdAt: index,
        status: "created",
        revision: 0,
        fingerprint: id
      };
      this.write(`run:${runId}`, run);
      this.write(`job:${id}`, job);
      this.write(`order:${id}`, index + 1);
      this.write("queue:sequence", index + 1);
      if (notify)
        await (this as unknown as { wake(): Promise<unknown> }).wake();
    }
    return { seeded: count };
  }
  async invalidSettings(kind: string) {
    const current = await this.settings(),
      roles = structuredClone(current.settings.roles);
    if (kind === "roles")
      return this.saveSettings(
        {} as typeof roles,
        current.casRevision,
        "probe"
      );
    if (kind === "template") {
      roles.primary.promptTemplate = "{{if}}";
      roles.primary.promptFormat = "pentagi-template";
    }
    if (kind === "missing-format") delete roles.primary.promptFormat;
    if (kind === "search-provider")
      roles.primary.searchProvider = "random" as NonNullable<
        typeof roles.primary.searchProvider
      >;
    if (kind === "type")
      roles.primary.promptTemplate = 123 as unknown as string;
    if (kind === "infrastructure") {
      const original = crypto.subtle.digest;
      Object.defineProperty(crypto.subtle, "digest", {
        configurable: true,
        value: async () => {
          throw new Error("hash backend unavailable");
        }
      });
      try {
        return await this.saveSettings(roles, current.casRevision, "probe");
      } finally {
        Object.defineProperty(crypto.subtle, "digest", {
          configurable: true,
          value: original
        });
      }
    }
    return this.saveSettings(roles, current.casRevision, "probe");
  }
  async initializationHead(id: string) {
    return this.workspace.git.revParse({ dir: `/projects/${id}`, ref: "main" });
  }
  async limit(runId: string, maxJobs: number) {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM native_records WHERE key=?", `run:${runId}`)
      .one();
    this.write(`run:${runId}`, { ...JSON.parse(row.value), maxJobs });
    return { maxJobs };
  }
  async projectionBlock(blocked: boolean) {
    this.write("probe:block-projection", blocked);
    return { blocked };
  }
  async prepareCandidate(
    id: string,
    recordChanges: Record<string, unknown> = {}
  ) {
    const row = this.ctx.storage.sql
        .exec<{
          value: string;
        }>("SELECT value FROM native_records WHERE key=?", `job:${id}`)
        .one(),
      job = JSON.parse(row.value) as AttemptRecord,
      dir = `/accepted/${job.runId}`;
    const tool = job.role === "primary" ? "done" : "code_result",
      args =
        job.role === "primary"
          ? { success: true, result: "completed", message: "done" }
          : { result: "completed", message: "done" };
    const result: AttemptResult = {
      id,
      runId: job.runId,
      inputCommit: job.inputCommit,
      promptDigest: "c".repeat(64),
      settingsRevision: job.settingsRevision,
      model: job.settings.model,
      status: "completed",
      tool,
      arguments: args,
      finishedAt: Date.now()
    };
    const record = {
      version: 1,
      job_id: id,
      run_id: job.runId,
      role: job.role,
      input_commit: job.inputCommit,
      prompt_digest: result.promptDigest,
      settings_revision: result.settingsRevision,
      model: result.model,
      status: result.status,
      tool,
      arguments: args,
      finished_at: result.finishedAt,
      ...recordChanges
    };
    const path = `.pentagi/jobs/${id}/result.json`;
    await this.workspace.fs.mkdir(`${dir}/.pentagi/jobs/${id}`, {
      recursive: true
    });
    await this.workspace.fs.writeFile(`${dir}/${path}`, JSON.stringify(record));
    if (recordChanges.__sourceWrite)
      await this.workspace.fs.writeFile(
        `${dir}/README.md`,
        "unauthorized source change\n"
      );
    await this.workspace.git.add({
      dir,
      paths: recordChanges.__sourceWrite ? [path, "README.md"] : [path]
    });
    const commit = await this.workspace.git.commit({
      dir,
      message: "candidate"
    });
    result.outputCommit = commit.oid;
    this.write(`blob:${commit.oid}:${path}`, JSON.stringify(record));
    this.write(`probe:result:${id}`, result);
    return result;
  }
  async acceptPrepared(id: string, changes: Record<string, unknown> = {}) {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM native_records WHERE key=?", `probe:result:${id}`)
      .one();
    return this.accept({ ...JSON.parse(row.value), ...changes });
  }
  async mainHead(runId: string): Promise<string> {
    return JSON.parse(
      this.ctx.storage.sql
        .exec<{
          value: string;
        }>("SELECT value FROM native_records WHERE key=?", `remote:${runId}`)
        .one().value
    );
  }
  async stoppedTarget(id: string, runId: string) {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>(
        "SELECT value FROM native_records WHERE key=?",
        `job:${runId === "run-0" ? "job-0" : "job-1"}`
      )
      .one();
    const old = JSON.parse(row.value) as AttemptRecord;
    this.write(`job:${id}`, {
      ...old,
      id,
      role: "coder",
      tool: "coder",
      depth: 1,
      parentJobId: old.id,
      status: "completed",
      finishedAt: Date.now(),
      logicalThreadId: id
    });
    return { id };
  }
  async advanceTwice() {
    const internal = this as unknown as { advance(): Promise<void> };
    await Promise.all([internal.advance(), internal.advance()]);
    return this.snapshot();
  }
  async terminalize(id: string) {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM native_records WHERE key=?", `job:${id}`)
      .one();
    this.write(`job:${id}`, {
      ...JSON.parse(row.value),
      status: "failed",
      finishedAt: Date.now()
    });
    return { stopped: true };
  }
  async revisionForTest(id: string, instructions: string, requestId: string) {
    return this.revise(id, instructions, requestId);
  }
  async delegationForTest(
    parentId: string,
    tool: string,
    args: Record<string, unknown>
  ) {
    return this.delegate(parentId, tool, args);
  }
  async abortForTest() {
    this.ctx.abort("coordinator recovery probe");
  }
  async fire() {
    await this.lifecycle.alarm();
    return { fired: true };
  }
  async recoverNow() {
    await this.lifecycle.start();
    const internal = this as unknown as {
      wake(): Promise<unknown>;
      recovering?: Promise<void>;
    };
    await internal.wake();
    await this.lifecycle.alarm();
    await internal.recovering;
    return this.queueSnapshot();
  }
  async catalogRuntime(origin: string, redirect = false) {
    const values = new Map<string, unknown>();
    const store = new OnboardingStore({
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key, value) => {
        values.set(key, value);
      },
      list: <T>() => [] as T[],
      remove: (key) => {
        values.delete(key);
      },
      fetcher: async (input, init) => {
        const response = await fetch(
          new URL(
            "/catalog-upstream?route=" +
              (String(input).includes("/go/") ? "go" : "console"),
            origin
          ),
          init
        );
        if (redirect) {
          await response.body?.cancel();
          return new Response(null, {
            status: 302,
            headers: { Location: "https://must-not-follow.invalid/" }
          });
        }
        return response;
      }
    });
    const results = [];
    for (const route of ["go", "console"] as const) {
      try {
        const value = await store.catalog(route, true);
        results.push({ route, models: value.models.length });
      } catch (error) {
        results.push({ route, error: String(error) });
      }
    }
    return results;
  }
  async earlyChatScenario(
    stop = false,
    terminalPreparation = false,
    queuedRejected = false,
    rejectedPrimary = false
  ) {
    await this.seed(queuedRejected ? 2 : 1, "coder", false);
    if (queuedRejected) await this.recoverNow();
    const read = <T>(key: string) =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      ) as T;
    const job = read<AttemptRecord>(queuedRejected ? "job:job-1" : "job:job-0"),
      run = read<RunRecord>(queuedRejected ? "run:run-1" : "run:run-0");
    const bytes = new TextEncoder().encode(
        "# Project notes\nOwned project configuration\n"
      ),
      sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    const file = await this.stageUpload({
      runId: run.id,
      id: "preparation-file",
      name: "project.md",
      sha256: sha,
      body: new Blob([bytes]).stream(),
      uploadedBy: "fixture"
    });
    this.write("job:" + job.id, {
      ...job,
      materialUploadIds: [file.id],
      tool: "native_discovery",
      execution: {
        kind: "discovery",
        url: run.target!.url,
        profile: "whatweb-polite-v1"
      }
    });
    this.write("run:" + run.id, {
      ...run,
      target: {
        ...run.target!,
        access: {
          headers: [],
          headerBinding: "PENTCLOUD_TARGET_TEST_HEADERS",
          login: {
            url: run.target!.url,
            usernameBinding: "PENTCLOUD_TARGET_TEST_USERNAME",
            passwordBinding: "PENTCLOUD_TARGET_TEST_PASSWORD"
          }
        }
      },
      initialUploadIds: [file.id],
      phase: "discovery"
    });
    await this.recoverNow();
    const store = (this as unknown as { onboarding: OnboardingStore })
        .onboarding,
      io = (store as unknown as { io: OnboardingIO }).io;
    io.boundGoKey = () => "fixture-key";
    io.probe = async () => {};
    io.fetcher = async () =>
      Response.json({
        data: [
          {
            id: "deepseek-v4-pro",
            name: "Fixture",
            type: "chat",
            capabilities: { tools: { supported: true } },
            api: {
              "chat-completions": {
                base_url: "https://opencode.ai/inference/go/openai/v1"
              }
            }
          }
        ]
      });
    await store.catalog("go");
    const choice = {
      model: "opencode-go:deepseek-v4-pro",
      credentialId: "bound-go",
      credentialVersion: 0
    };
    await store.testModel(choice, "fixture-model", "fixture");
    const draft = store.saveDraft(
      run.id,
      { publicAPI: true, profile: { default: choice, overrides: {} } },
      0,
      "fixture"
    );
    const opened = await this.activateAnalysis(
      run.id,
      draft.revision,
      "fixture-open"
    );
    await this.activateAnalysis(run.id, draft.revision, "fixture-open");
    const primary = (this.env as unknown as Bindings).ATTEMPTS.getByName(
      opened.rootJob.id
    );
    const before = {
      snapshot: await this.snapshot(),
      primary: await primary.conversationInfo(),
      head: await this.mainHead(run.id)
    };
    const selectedRead = await (
      await this.readPreparationFile(opened.rootJob.id, file.sourcePath)
    ).text();
    let unselectedDenied = false;
    try {
      await this.readPreparationFile(opened.rootJob.id, "README.md");
    } catch {
      unselectedDenied = true;
    }
    const headAfterRead = await this.mainHead(run.id);
    if (queuedRejected) {
      const fetch = this.workspace.git.fetch;
      this.workspace.git.fetch = async (options) => {
        const pending = this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key='input:preparing'"
          )
          .toArray()[0];
        if (pending && JSON.parse(pending.value)?.jobId === job.id)
          throw new Error("409: Injected discovery input read conflict");
        return fetch(options);
      };
      await this.cancelRun("run-0");
      await (this.env as unknown as Bindings).ATTEMPTS.getByName(
        "job-0"
      ).release();
      await this.recoverNow();
      await this.recoverNow();
      const rejected = await this.snapshot();
      let ackError: string | undefined;
      try {
        await this.onboardingAction(
          "discovery.acknowledge",
          { runId: run.id },
          "fixture"
        );
      } catch (error) {
        ackError = String(error);
      }
      await this.recoverNow();
      for (let n = 0; n < 100 && !(await primary.inputReady()); n++) {
        await this.recoverNow();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        before,
        rejected,
        ackError,
        after: await primary.conversationInfo(),
        input: (
          (await primary.inspect()) as unknown as { input?: AttemptInput }
        ).input,
        final: await this.snapshot()
      };
    }
    if (stop) {
      if (terminalPreparation) {
        const queued = read<AttemptRecord>("job:" + opened.rootJob.id),
          current = read<RunRecord>("run:" + run.id);
        this.write("job:" + queued.id, {
          ...queued,
          status: "invalid_result",
          inputError: "409: file input rejected",
          revision: queued.revision + 1
        });
        this.write("run:" + run.id, {
          ...current,
          phase: "completed",
          status: "failed"
        });
        await this.trashRun(run.id);
      } else await this.cancelRun(run.id);
      return { before, after: await primary.conversationInfo() };
    }
    const internal = this as unknown as {
      assertConversation(id: string): Promise<void>;
    };
    await internal.assertConversation(opened.rootJob.id);
    let workDenied = false;
    try {
      await this.assertActive(opened.rootJob.id);
    } catch {
      workDenied = true;
    }
    const scanner = (this.env as unknown as Bindings).ATTEMPTS.getByName(
      job.id
    );
    await scanner.unresolved(1);
    await scanner.release();
    await this.recoverNow();
    let unknownDenied = false;
    try {
      await this.onboardingAction(
        "discovery.acknowledge",
        { runId: run.id },
        "fixture"
      );
    } catch {
      unknownDenied = true;
    }
    const unknownHeld = await primary.conversationInfo();
    await scanner.unresolved(0);
    await this.recoverNow();
    await this.recoverNow();
    const held = await primary.conversationInfo();
    if (rejectedPrimary) {
      const queued = read<AttemptRecord>("job:" + opened.rootJob.id);
      this.write("job:" + queued.id, {
        ...queued,
        materialUploadIds: [file.id]
      });
      this.workspace.git.fetch = async () => {
        throw new Error("409: Injected primary input rejection");
      };
    }
    await this.onboardingAction(
      "discovery.acknowledge",
      { runId: run.id },
      "fixture"
    );
    await this.recoverNow();
    for (
      let n = 0;
      n < 100 &&
      !(await primary.inputReady()) &&
      !(await primary.conversationInfo()).cancelled;
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      before,
      workDenied,
      selectedRead,
      unselectedDenied,
      headAfterRead,
      unknownDenied,
      unknownHeld,
      held,
      after: await primary.conversationInfo(),
      snapshot: await this.snapshot()
    };
  }
  async mismatchedDiscovery() {
    await this.seed(1, "coder", false);
    const read = <T>(key: string) =>
      JSON.parse(
        this.ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM native_records WHERE key=?",
            key
          )
          .one().value
      ) as T;
    const job = read<AttemptRecord>("job:job-0"),
      run = read<RunRecord>("run:run-0");
    this.write("job:job-0", {
      ...job,
      tool: "native_discovery",
      execution: {
        kind: "discovery",
        url: run.target!.url,
        profile: "whatweb-polite-v1"
      }
    });
    this.write("run:run-0", { ...run, phase: "discovery" });
    await this.recoverNow();
    const stub = (this.env as unknown as Bindings).ATTEMPTS.getByName(job.id);
    for (let n = 0; n < 100 && !(await stub.inputReady()); n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await stub.finish({
      id: job.id,
      runId: job.runId,
      inputCommit: job.inputCommit,
      settingsRevision: job.settingsRevision,
      status: "completed",
      model: job.settings.model,
      promptDigest: "c".repeat(64),
      outputCommit: "f".repeat(40),
      finishedAt: Date.now()
    });
    await this.recoverNow();
    await this.recoverNow();
    return {
      snapshot: await this.snapshot(),
      attempt: await stub.inspect(),
      main: await this.mainHead(job.runId)
    };
  }
  async recoveryAfterReset() {
    await this.lifecycle.jobs.reschedule(
      "pentcloud:recover",
      Date.now() + 1000
    );
    return { armed: true };
  }
  async nativeMemoryHandoff() {
    await this.lifecycle.start();
    const internal = this as unknown as {
      wake(): Promise<unknown>;
      recover(): Promise<void>;
      recovering?: Promise<void>;
    };
    await internal.recovering;
    internal.recover = async () => {
      throw new Error(
        "Durable Object's isolate exceeded its memory limit and was reset."
      );
    };
    await internal.wake();
    await this.lifecycle.alarm();
    return { handedOff: true };
  }
  async readonlyQueueScenario() {
    // Public snapshots must not start capabilities or create a recovery wake.
    const cold = await this.queueSnapshot(),
      coldJobs = this.lifecycle.jobs.list();
    await this.seed(2, "coder", false);
    this.write("order:job-0", 20);
    this.write("order:job-1", 10);
    const pending = (await this.queueSnapshot()).pending;
    return { cold, coldJobs, pending };
  }
  async nativeWakeScenario() {
    await this.lifecycle.start();
    const internal = this as unknown as {
      wake(): Promise<unknown>;
      recover(): Promise<void>;
      recovering?: Promise<void>;
    };
    await internal.recovering;
    const initial = this.lifecycle.jobs.get("pentcloud:recover");
    if (!initial) return { initial: null };
    let release!: () => void,
      passes = 0,
      concurrent = 0,
      peak = 0;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      recover = internal.recover.bind(this);
    internal.recover = async () => {
      passes++;
      peak = Math.max(peak, ++concurrent);
      try {
        if (passes === 1) await held;
      } finally {
        concurrent--;
      }
    };
    await internal.wake();
    await this.lifecycle.alarm();
    const firstPasses = passes,
      busyRequestedAt = Date.now();
    const pushedBusy = internal.wake();
    const busyWake = this.lifecycle.jobs.get(initial.id);
    await pushedBusy;
    await this.lifecycle.alarm();
    const busyPasses = passes;
    release();
    await internal.recovering;
    const heartbeat = this.lifecycle.jobs.get(initial.id);
    await this.lifecycle.jobs.reschedule(initial.id, Date.now());
    await this.lifecycle.alarm();
    await internal.recovering;
    internal.recover = recover;
    const future = Date.now() + 60000;
    await this.lifecycle.jobs.reschedule(initial.id, future);
    let pushed: Promise<unknown> | undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        this.write("probe:rollback", true);
        pushed = internal.wake();
        throw new Error("rollback admission");
      });
    } catch {}
    await pushed;
    const rolledBack =
      this.ctx.storage.sql
        .exec("SELECT key FROM native_records WHERE key='probe:rollback'")
        .toArray().length === 0 &&
      this.lifecycle.jobs.get(initial.id)?.time === future;
    const rearm = this.lifecycle.rearmAlarm.bind(this.lifecycle);
    this.lifecycle.rearmAlarm = async () => {
      throw new Error("injected alarm rearm failure");
    };
    let failure = "";
    try {
      await internal.wake();
    } catch (error) {
      failure = String(error);
    } finally {
      this.lifecycle.rearmAlarm = rearm;
    }
    const retained = this.lifecycle.jobs.get(initial.id);
    await this.lifecycle.jobs.rearm();
    return {
      initial,
      firstPasses,
      busyRequestedAt,
      busyWake,
      busyPasses,
      heartbeat,
      passes,
      peak,
      rolledBack,
      failure,
      retained
    };
  }
  async platformRecoverySchedules() {
    return {
      recover: this.lifecycle.jobs.list().filter((job) => job.fn === "recover")
        .length,
      legacy: (await this.scheduler.list()).filter(
        (schedule) => schedule.callback === "recover"
      ).length
    };
  }
  async endPlatformBackoff() {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM native_records WHERE key=?",
        "platform:recovery"
      )
      .one();
    this.write("platform:recovery", {
      ...JSON.parse(row.value),
      nextTime: Date.now() - 1
    });
    return this.recoverNow();
  }
  async snapshot() {
    return {
      ...(await this.queueSnapshot()),
      records: this.ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key,value FROM native_records"
        )
        .toArray()
        .map((row) => ({ key: row.key, value: JSON.parse(row.value) }))
    };
  }
  async repeatDelivery(_id: string) {
    await (this as unknown as { wake(): Promise<unknown> }).wake();
    await this.lifecycle.alarm();
    return { fired: true };
  }
}
// Keep only the actual WebSocket and upstream HTTP boundaries; test controls use native RPC.
export default {
  async fetch(request: Request, env: Bindings) {
    const url = new URL(request.url);
    if (url.pathname === "/agents/coordinator/global")
      return env.COORDINATOR.getByName("global").fetch(request);
    return catalogFixture(request);
  }
};
