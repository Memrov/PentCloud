import { attemptScenario, scenarioRole } from "./scenario-registry";
import {
  probePreparation,
  probePromptCompatibility,
  probePackageOnly
} from "./scenarios-preparation";

import { fixtureServices } from "./fixture-services";
import { evidenceBytesHash } from "../../src/native/evidence";
import { ToolboxMCP } from "../../src/native/tools";
import { supportedOptionalTools } from "../../src/native/tool-policy";
import { NativeAttempt } from "../../src/native/attempt";

import { pinToolSkill } from "../../src/native/skills";
import { recordedWorkPage } from "../../src/native/recorded-work";
import { redact } from "../../src/native/tool-policy";
import { digest } from "../../src/native/domain";
import { type PinnedModel } from "../../src/native/opencode-models";
import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";

import { Plugin } from "@opencode/plugin";
import { OpenCodeConnectionTest } from "../../src/native/model-test";
import type { AttemptInput, NativeEnv } from "../../src/native/types";
import type {
  ToolboxReadiness,
  ToolboxActivity,
  ToolboxFailure
} from "../../../../shared/toolbox-rpc";
import stockCatalog from "../fixtures/stock-kali-catalog.json";
export { WorkspaceServiceProxy } from "@cloudflare/computer";
export { NativeDynamicWorkerTail } from "../../src/native/dynamic-worker-tail";
export { TargetEgress } from "../../src/native/target-egress";

// Synthetic network response; production transport, injection and projection stay real.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
    headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
  return new URL(url).hostname === "example.com" &&
    headers.get("X-Researcher") === "private-header-marker"
    ? new Response("private-header-marker")
    : originalFetch(input, init);
};

async function fixtureReady(
  ctx: DurableObjectState,
  expected?: string
): Promise<ToolboxReadiness | ToolboxFailure> {
  const generation =
    (await ctx.storage.get<string>("fixture:generation")) ??
    "fixture-generation";
  await ctx.storage.put(
    "fixture:readies",
    ((await ctx.storage.get<number>("fixture:readies")) ?? 0) + 1
  );
  if (expected !== undefined && expected !== generation)
    return { error: "generation_lost", generation };
  return {
    state: (await ctx.storage.get("fixture:readyBlocked"))
      ? "booting"
      : "ready",
    generation
  };
}
async function fixtureActivity(
  ctx: DurableObjectState,
  expected: string
): Promise<ToolboxActivity | ToolboxFailure> {
  const generation =
    (await ctx.storage.get<string>("fixture:generation")) ??
    "fixture-generation";
  await ctx.storage.put(
    "fixture:activities",
    ((await ctx.storage.get<number>("fixture:activities")) ?? 0) + 1
  );
  return expected === generation
    ? { state: "running", generation }
    : { error: "generation_lost", generation };
}
async function sessionMCP(
  ctx: DurableObjectState,
  request: Request
): Promise<Response> {
  const response = await sessionMCPResponse(ctx, request);
  response.headers.set(
    "X-Pentcloud-Toolbox-Generation",
    (await ctx.storage.get<string>("fixture:generation")) ??
      "fixture-generation"
  );
  return response;
}
async function sessionMCPResponse(
  ctx: DurableObjectState,
  request: Request
): Promise<Response> {
  const generation =
    (await ctx.storage.get<string>("fixture:generation")) ??
    "fixture-generation";
  const pinned = request.headers.get("X-Pentcloud-Toolbox-Generation");
  if (pinned !== generation)
    return Response.json({ state: "lost", generation }, { status: 409 });
  if (request.method === "GET")
    return new Response("No standalone SSE", { status: 405 });
  const sid = request.headers.get("Mcp-Session-Id");
  const stateless = !!(await ctx.storage.get("fixture:stateless"));
  if (request.method === "DELETE") {
    await ctx.storage.put(
      "fixture:deleteAttempts",
      ((await ctx.storage.get<number>("fixture:deleteAttempts")) ?? 0) + 1
    );
    const failure = await ctx.storage.get<boolean | number>(
      "fixture:failDelete"
    );
    if (failure)
      return new Response("Deletion unavailable", {
        status: typeof failure === "number" ? failure : 503
      });
    if (!sid || !(await ctx.storage.get(`fixture:server:${sid}`)))
      return new Response("Session missing", { status: 404 });
    const receipt = await ctx.storage.get<{ state: string }>(
      "remote:session-lost"
    );
    await ctx.storage.put(
      "fixture:deleteAfterProof",
      !receipt ||
        receipt.state === "reconciled" ||
        receipt.state === "completed"
    );
    await ctx.storage.delete(`fixture:server:${sid}`);
    await ctx.storage.put(
      "fixture:deletes",
      ((await ctx.storage.get<number>("fixture:deletes")) ?? 0) + 1
    );
    return new Response(null, { status: 204 });
  }
  const rpc = (await request.json()) as {
    id?: string | number;
    method: string;
    params?: {
      name?: string;
      arguments?: Record<string, unknown>;
      requestId?: string | number;
    };
  };
  if (rpc.method === "initialize") {
    await ctx.storage.put(
      "fixture:initializes",
      ((await ctx.storage.get<number>("fixture:initializes")) ?? 0) + 1
    );
    const newSid = `probe-${crypto.randomUUID()}`;
    if (await ctx.storage.get("fixture:partialWarmup")) {
      await ctx.storage.put(`fixture:partial:${newSid}`, true);
      await ctx.storage.put("fixture:partialWarmup", false);
    }
    if (!stateless) {
      await ctx.storage.put(`fixture:server:${newSid}`, true);
      await ctx.storage.put("fixture:originalSid", newSid);
    }
    return Response.json(
      {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "stateful-stock-fixture", version: "1" }
        }
      },
      stateless ? {} : { headers: { "Mcp-Session-Id": newSid } }
    );
  }
  if (!stateless && (!sid || !(await ctx.storage.get(`fixture:server:${sid}`))))
    return new Response("Wrong session", { status: 404 });
  if (rpc.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (rpc.method === "notifications/cancelled") {
    await ctx.storage.put("fixture:cancelledWireId", rpc.params?.requestId);
    return new Response(null, { status: 202 });
  }
  if (rpc.id !== undefined) {
    const seen =
      (await ctx.storage.get<Array<string | number>>("fixture:wireIds")) ?? [];
    seen.push(rpc.id);
    await ctx.storage.put("fixture:wireIds", seen);
    if (await ctx.storage.get(`fixture:pending:${rpc.id}`))
      await ctx.storage.put("fixture:idCollision", true);
  }

  let result: object;
  if (rpc.method === "tools/list") {
    if (sid && (await ctx.storage.get(`fixture:partial:${sid}`))) {
      await ctx.storage.put(
        "fixture:modelsAtPartialCatalog",
        (await ctx.storage.get("fixture:modelRequests")) ?? 0
      );
      await ctx.storage.put(
        "fixture:partialCatalogWasPinned",
        !!(await ctx.storage.get("remoteCatalog"))
      );
    }
    result = {
      tools:
        sid && (await ctx.storage.get(`fixture:partial:${sid}`))
          ? stockCatalog.tools.slice(0, 100)
          : stockCatalog.tools
    };
  } else if (rpc.method === "tools/call") {
    await ctx.storage.put(
      "fixture:toolCalls",
      ((await ctx.storage.get<number>("fixture:toolCalls")) ?? 0) + 1
    );
    if (rpc.params?.name === "whatweb_whatweb_scan")
      await ctx.storage.put("fixture:whatwebArguments", rpc.params.arguments);
    if (rpc.params?.name === "nmap_port_scan") {
      const durable = await ctx.storage.get<{
        sessionId: string;
        protocolVersion?: string;
      }>("mcpSession");
      await ctx.storage.put(
        "fixture:persistedBeforeMutation",
        stateless ||
          (durable?.sessionId === sid &&
            durable.protocolVersion === "2025-03-26")
      );
      await ctx.storage.put("fixture:scanSid", sid ?? "stateless");
      if (await ctx.storage.get("fixture:dropSessionReply")) {
        await ctx.storage.put("fixture:oldWireId", rpc.id);
        await ctx.storage.put(`fixture:pending:${rpc.id}`, true);
        await ctx.storage.put("fixture:dropSessionReply", false);
        throw new Error(
          "Injected domain response loss after persistent remote scan"
        );
      }
    }
    if (
      rpc.params?.name === "nmap_get_scan_results" &&
      rpc.params.arguments?.scan_id === "cancel-probe"
    ) {
      await ctx.storage.put("fixture:newHeldWireId", rpc.id);
      return new Promise<Response>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () =>
            resolve(
              Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32000, message: "Transport closed" }
              })
            ),
          { once: true }
        )
      );
    }
    const oldId = await ctx.storage.get<string | number>("fixture:oldWireId");
    if ((await ctx.storage.get("fixture:completeOld")) && oldId !== undefined)
      await ctx.storage.delete(`fixture:pending:${oldId}`);
    const operationStatus =
      oldId !== undefined && (await ctx.storage.get(`fixture:pending:${oldId}`))
        ? "running"
        : "completed";
    const original = await ctx.storage.get<string>("fixture:scanSid");
    if (
      rpc.params?.name === "nmap_get_scan_results" &&
      original !== (sid ?? "stateless")
    )
      result = {
        content: [{ type: "text", text: "Scan not found in this session" }]
      };
    else
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              scan_id: "session-scan",
              http_status: rpc.params?.name?.startsWith("whatweb_")
                ? (await ctx.storage.get("fixture:whatwebEmpty"))
                  ? null
                  : 200
                : undefined,
              target:
                (rpc.params?.name?.startsWith("whatweb_")
                  ? await ctx.storage.get("fixture:whatwebTarget")
                  : undefined) ?? "127.0.0.1",
              scan_type: "port",
              status:
                rpc.params?.name?.startsWith("whatweb_") &&
                (await ctx.storage.get("fixture:whatwebFailed"))
                  ? "failed"
                  : operationStatus
            })
          }
        ],
        isError: false
      };
  } else result = {};
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
}

/** Local fixture: Workspace, Git, shell, JS and guarded RPC are real; only external authorities are substitutes. */
type ProbeInternals = {
  initialize(input: AttemptInput): Promise<unknown>;
  preflightToolbox(state: object): Promise<void>;
  packCall(
    input: import("../../../../shared/tool-packs").ToolPackRequest,
    id: string
  ): Promise<unknown>;
  safe(value: unknown): unknown;
  apiRequest(input: unknown, id: string): Promise<unknown>;
  cloudflareTools(): Promise<
    import("../../src/native/cloudflare-tools").CloudflareTool[]
  >;
  callCloudflareTool(
    tool: import("../../src/native/cloudflare-tools").CloudflareTool,
    args: unknown,
    id: string,
    signal: AbortSignal
  ): Promise<unknown>;
  publish(proposal: object): Promise<unknown>;
  callTool(name: string, args: object, callId: string): Promise<unknown>;
  captureToolEvidence(
    tool: string,
    args: Record<string, unknown>,
    id: string,
    result: unknown
  ): Promise<void>;
  checkpointEvidence(): Promise<
    import("../../src/native/evidence").EvidenceCheckpoint | undefined
  >;
};
export type ProbeScenarioContext = ReturnType<ProbeAttempt["scenarioContext"]>;

export class ProbeAttempt extends NativeAttempt {
  private readonly published: Array<{ ref?: string; remoteRef?: string }> = [];
  constructor(ctx: DurableObjectState, bindings: { LOADER: WorkerLoader }) {
    const fakeArtifacts = {
      get: async () => ({
        createToken: async (scope: "read" | "write") => ({
          plaintext: `local-probe-token-${scope}`
        }),
        readFile: async ({ ref, path }: { ref: string; path: string }) => {
          if (
            ref !==
            (await this.workspace.git.revParse({
              dir: this.directory,
              ref: "HEAD"
            }))
          )
            throw new Error("Wrong candidate commit");
          return new Blob([
            await this.workspace.fs.readFile(
              `${this.directory}/${path}`,
              "utf8"
            )
          ]);
        },
        [Symbol.dispose]() {}
      })
    };
    super(ctx, {
      ...bindings,
      ARTIFACTS: fakeArtifacts,
      CONTROL_TOKEN: "local-probe-control",
      OPENCODE_GO_API_KEY: "local-probe-go",
      PENTCLOUD_TARGET_HEADERS: {
        get: async () =>
          JSON.stringify({ "X-Researcher": "private-header-marker" })
      },
      CF_VERSION_METADATA: { id: "probe-terminal", tag: "fixture" },
      COORDINATOR: {
        getByName: () => ({
          assertActive: async () => {},
          apiCredential: async () => ({ targetURL: "https://example.com/" }),
          assertConversation: async () => {},
          assertEvidenceOwner: async () => {},
          readEvidence: async (
            requester: string,
            job: string,
            path: string
          ) => {
            if (
              requester !== job ||
              !path.startsWith(`.pentagi/evidence/${job}/`)
            )
              throw new Error("Fixture evidence ownership mismatch");
            const published =
              (await ctx.storage.get<Record<string, string>>(
                "fixture:publishedEvidence"
              )) ?? {};
            const bytes = new Uint8Array(
              await new Response(
                await this.workspace.fs.readFile(`${this.directory}/${path}`)
              ).arrayBuffer()
            );
            if (
              !published[path] ||
              (await evidenceBytesHash(bytes)) !== published[path]
            )
              throw new Error(
                "Fixture evidence has not been published and verified"
              );
            return new Response(bytes);
          },
          recordEvidence: async (_id: string, receipt: unknown) => {
            const { manifestPath } = receipt as { manifestPath: string };
            const manifest = JSON.parse(
              await this.workspace.fs.readFile(
                `${this.directory}/${manifestPath}`,
                "utf8"
              )
            ) as { files: Array<{ path: string; sha256: string }> };
            await ctx.storage.put(
              "fixture:publishedEvidence",
              Object.fromEntries(
                manifest.files.map((file) => [file.path, file.sha256])
              )
            );
            const values =
              (await ctx.storage.get<unknown[]>("fixture:evidenceReceipts")) ??
              [];
            if (
              !values.some((x) => JSON.stringify(x) === JSON.stringify(receipt))
            )
              await ctx.storage.put("fixture:evidenceReceipts", [
                ...values,
                receipt
              ]);
          },
          getContext: async () =>
            (await ctx.storage.get<Record<string, unknown>>(
              "fixture:liveContext"
            )) ?? {},
          readRunWork: async (_requester: string, _job?: string, offset = 0) =>
            recordedWorkPage(
              redact(
                {
                  messages: [
                    {
                      text:
                        "TOKEN=private-assignment\n" +
                        "recorded source evidence 🧪 ".repeat(3000)
                    }
                  ]
                },
                []
              ),
              offset
            )
        })
      },
      TOOLBOX: {
        putFile: async (
          scope: { attemptId: string },
          file: { path: string; size: number; sha256: string },
          body: ReadableStream<Uint8Array>
        ) => {
          const bytes = new Uint8Array(await new Response(body).arrayBuffer());
          if (
            bytes.length !== file.size ||
            (await evidenceBytesHash(bytes)) !== file.sha256
          )
            throw new Error("fixture byte mismatch");
          const path = `/fixture-kali/${ctx.id}/${file.path}`;
          await this.workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), {
            recursive: true
          });
          await this.workspace.fs.writeFile(path, bytes);
          return {
            ...file,
            path: `/work/pentcloud/local-run/${scope.attemptId}/${file.path}`
          };
        },
        getFile: async (_scope: unknown, path: string) => {
          const bytes = await this.workspace.fs.readFile(
            `/fixture-kali/${ctx.id}/${path}`
          );
          const value = new Uint8Array(await new Response(bytes).arrayBuffer());
          return new Response(value, {
            headers: { "X-Content-SHA256": await evidenceBytesHash(value) }
          });
        },
        listFiles: async () => ({
          root: "/fixture-kali",
          files: [],
          unavailable: [],
          truncated: false
        }),
        ready: (expected?: string) => fixtureReady(ctx, expected),
        activity: (expected: string) => fixtureActivity(ctx, expected),
        status: async () => ({
          state: "running",
          generation:
            (await ctx.storage.get<string>("fixture:generation")) ??
            "fixture-generation",
          inactivityTimeoutMs: 1800000
        }),
        fetch: async (request: Request) => sessionMCP(ctx, request)
      }
    } as unknown as NativeEnv);
    this.workspace.git.push = async (options) => {
      if (
        options?.headers?.Authorization !==
        `Basic ${btoa("x:local-probe-token-write")}`
      )
        throw new Error("Candidate push must receive a write repository token");
      this.published.push({
        ...(options?.ref ? { ref: options.ref } : {}),
        ...(options?.remoteRef ? { remoteRef: options.remoteRef } : {})
      });
      return { ok: true, error: null, refs: {} };
    };
    // Cancellation exercises the durable runtime fence; model transport is scripted.
    this.harness.abort = async () => true;
    const setup = this.plugin.setup;
    (this.plugin as { setup: typeof setup }).setup = async (context) => {
      await setup(context);
      const pinnedModelOrigin = await this.ctx.storage.get<string>(
        "fixture:pinnedModelOrigin"
      );
      if (pinnedModelOrigin) {
        await context.session.hook("retry", (event) => {
          event.decision = { retry: false };
        });
        await context.session.hook("http.request", async (event) => {
          const body = (await event.request.clone().json()) as {
            model: string;
            reasoning_effort?: string;
          };
          await this.ctx.storage.put("fixture:pinnedModelRequest", {
            model: body.model,
            ...(body.reasoning_effort
              ? { reasoningEffort: body.reasoning_effort }
              : {}),
            authenticated:
              event.request.headers.get("authorization") ===
              "Bearer fixture-model-key"
          });
          await this.ctx.storage.put(
            "fixture:modelRequests",
            ((await this.ctx.storage.get<number>("fixture:modelRequests")) ??
              0) + 1
          );
          event.request = new Request(
            pinnedModelOrigin + "/fake-provider",
            event.request
          );
        });
      }
      if (await this.ctx.storage.get("fixture:holdModel"))
        await context.session.hook("model.request", async (event) => {
          await this.ctx.storage.put("fixture:modelKinds", [
            ...((await this.ctx.storage.get<string[]>("fixture:modelKinds")) ??
              []),
            event.kind
          ]);
          // OpenCode prepares a title request too. Only primary execution is the
          // operation being evicted; auxiliary preparation must never reach HTTP.
          if (event.kind !== "primary")
            throw new Error("LOCAL_AUXILIARY_PROBE_NO_MODEL_HTTP");
          await this.ctx.storage.put(
            "fixture:modelRequests",
            ((await this.ctx.storage.get<number>("fixture:modelRequests")) ??
              0) + 1
          );
          await this.ctx.storage.put("fixture:modelHeld", true);
          await new Promise((resolve) => setTimeout(resolve, 120000));
          throw new Error("LOCAL_EVICTION_PROBE_NO_MODEL_HTTP");
        });
      if (await this.ctx.storage.get("fixture:stopBeforeModel"))
        await context.session.hook("model.request", async (event) => {
          await this.ctx.storage.put("fixture:modelKinds", [
            ...((await this.ctx.storage.get<string[]>("fixture:modelKinds")) ??
              []),
            event.kind
          ]);
          if (event.kind === "primary")
            await this.ctx.storage.put(
              "fixture:modelRequests",
              ((await this.ctx.storage.get<number>("fixture:modelRequests")) ??
                0) + 1
            );
          throw new Error("LOCAL_STARTUP_PROBE_NO_MODEL_HTTP");
        });
      if (await this.ctx.storage.get("fixture:inspectProviderTools"))
        await context.session.hook("http.request", async (event) => {
          const body = (await event.request.clone().json()) as {
            tools?: Array<{
              type: string;
              function?: { name: string; parameters: unknown };
              name?: string;
            }>;
          };
          const tools = body.tools ?? [];
          await this.ctx.storage.put("fixture:providerTools", {
            names: tools.map((tool) => tool.function?.name ?? tool.name),
            browser:
              tools.find((tool) => tool.function?.name === "browser")?.function
                ?.parameters ?? null
          });
          const origin = await this.ctx.storage.get<string>(
            "fixture:scriptedOrigin"
          );
          if (
            origin &&
            (await this.ctx.storage.get<{ preparation?: true }>("attempt"))
              ?.preparation
          ) {
            event.request = new Request(
              origin +
                "/fake-provider" +
                ((await this.ctx.storage.get("fixture:question"))
                  ? "?question=1"
                  : ""),
              event.request
            );
            return;
          }
          throw new Error("LOCAL_TOOL_ASSEMBLY_PROBE_NO_MODEL_HTTP");
        });
    };
  }
  async configurePreparation(
    origin: string,
    question = false,
    failure: string | null = null
  ) {
    await this.ctx.storage.put("fixture:scriptedOrigin", origin);
    await this.ctx.storage.put("fixture:question", question);
    if (failure)
      await this.ctx.storage.put("fixture:promotionFailure", failure);
  }
  private scenarioContext(
    kind: string,
    input: AttemptInput,
    id: string,
    base: { oid: string },
    origin?: string
  ) {
    const internal = this as unknown as ProbeInternals;
    const computer = async (name: string, args: unknown) => {
      const tool = (await internal.cloudflareTools()).find(
        (tool) => tool.name === name
      )!;
      return internal.callCloudflareTool(
        tool,
        args,
        crypto.randomUUID(),
        new AbortController().signal
      ) as Promise<{ content: string }>;
    };
    const exec = async (command: string, backend = "native-shell") =>
      JSON.parse(
        (await computer("computer_exec", { command, backend })).content
      ).value;
    return {
      attempt: this,
      ctx: this.ctx,
      env: this.env,
      published: this.published,
      installRemoteFixture: () => this.installRemoteFixture(),
      fixtureReady,
      fixtureActivity,
      sessionMCP,
      sessionMCPResponse,
      kind,
      input,
      id,
      base,
      origin,
      internal,
      computer,
      exec,
      shell: (command: string) => exec(command),
      checks: {} as Record<string, unknown>
    };
  }
  async probe(kind: string, origin?: string): Promise<Record<string, unknown>> {
    const id = "local-attempt";
    await this.workspace.fs.mkdir(this.directory, { recursive: true });
    await this.workspace.fs.mkdir("/workspace/scratch", { recursive: true });
    await this.workspace.git.init({
      dir: this.directory,
      defaultBranch: "main"
    });
    await this.workspace.fs.writeFile(
      `${this.directory}/README.md`,
      "accepted baseline\n"
    );
    await this.workspace.git.add({ dir: this.directory, paths: ["README.md"] });
    const base = await this.workspace.git.commit({
      dir: this.directory,
      message: "probe baseline"
    });
    if (!kind.startsWith("preparation-"))
      await this.workspace.git.branch({
        dir: this.directory,
        name: `attempts/${id}`,
        checkout: true
      });
    const input: AttemptInput = {
      id,
      runId: "local-run",
      role: scenarioRole(kind),
      tool: "primary",
      args: { task: "probe" },
      task: "probe",
      inputCommit: base.oid,
      repo: "local-probe",
      remote: "https://example.invalid/repo.git",
      settingsRevision: "a".repeat(64),
      settings: {
        promptFormat: "markdown",
        promptTemplate: "Probe",
        upstreamPromptDigest: "b".repeat(64),
        model: "opencode-go:deepseek-v4-pro",
        reasoningEffort: "default"
      },
      depth: 0,
      attempt: 1,
      logicalThreadId: id,
      context: {},
      createdAt: Date.now()
    };
    input.context = {
      enabledTools: supportedOptionalTools(input.role),
      browserAllowedURLs: ["https://example.com/"]
    };
    const context = this.scenarioContext(kind, input, id, base, origin);
    if (kind === "preparation-chat" || kind === "preparation-stop")
      return probePreparation(context);
    if (kind.startsWith("native-discovery")) {
      input.execution = {
        kind: "discovery",
        url: "http://127.0.0.1/",
        profile: kind.startsWith("native-discovery-http")
          ? "http-probes-v3"
          : kind === "native-discovery-legacy"
            ? "whatweb-polite-v1"
            : "whatweb-stealthy-v2"
      };
      input.context.target = {
        id: "owned-target",
        kind: "website",
        url: input.execution.url
      };
      input.tool = "native_discovery";
      Object.assign(this.env, { OPENCODE_GO_API_KEY: "" });
      await this.ctx.storage.put("fixture:whatwebTarget", input.execution.url);
      if (kind === "native-discovery-failed")
        await this.ctx.storage.put("fixture:whatwebFailed", true);
      if (kind === "native-discovery-empty")
        await this.ctx.storage.put("fixture:whatwebEmpty", true);
    }
    if (
      kind === "native-pinned-model" ||
      kind === "native-pinned-model-max" ||
      kind === "sdk-terminal-cold"
    ) {
      input.modelConfig = {
        id: "opencode:fixture-console",
        modelId: "fixture-console",
        provider: "opencode",
        route: "console",
        adapter: "chat-completions",
        name: "Fixture Console",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "https://opencode.ai/inference/openai/v1",
        contextLength: 128000,
        outputLimit: 8192,
        compatibility: { reasoning_field: "reasoning_content" },
        reasoningEfforts:
          kind === "native-pinned-model-max" ? ["default", "max"] : ["default"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportedParameters: [],
        credentialId: "fixture-key",
        credentialVersion: 1,
        catalogDigest: "a".repeat(64),
        testedAt: Date.now()
      };
      input.settings.model = input.modelConfig.id;
      Object.assign(this.env.COORDINATOR, {
        getByName: () => ({
          assertActive: async () => {},
          getContext: async () => ({}),
          modelCredential: async () => {
            await this.ctx.storage.put(
              "fixture:credentialReads",
              ((await this.ctx.storage.get<number>(
                "fixture:credentialReads"
              )) ?? 0) + 1
            );
            if (await this.ctx.storage.get("fixture:credentialDenied"))
              throw new Error(
                "409: Conversation is not available for this queued primary"
              );
            return "fixture-model-key";
          }
        })
      });
      if (kind === "native-pinned-model-max")
        input.settings.reasoningEffort = "max";
      if (kind.startsWith("native-pinned-model")) {
        if (!origin) throw new Error("Scripted model origin is required");
        // The adviser publishes a text answer through the real execution path.
        input.role = "adviser";
        input.context.enabledTools = supportedOptionalTools(input.role);
        await this.ctx.storage.put("fixture:pinnedModelOrigin", origin);
      } else {
        await this.ctx.storage.put("fixture:stopBeforeModel", true);
      }
    }
    if (kind === "finding-contract") input.findingsVersion = 1;
    if (kind === "header-redaction")
      input.targetConfig = {
        id: "echo-site",
        url: "https://example.com/",
        name: "Echo",
        kind: "website",
        revision: 1,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
        updatedBy: "fixture",
        objective: "",
        exclusions: "",
        access: { headers: [], headerBinding: "PENTCLOUD_TARGET_HEADERS" }
      };

    await this.ctx.storage.put("attempt", {
      input,
      fingerprint:
        kind === "toolbox-eviction" ||
        kind.startsWith("native-discovery") ||
        kind.startsWith("native-pinned-model")
          ? await digest(input)
          : "local-probe",
      prompt: "Probe",
      promptDigest: "c".repeat(64),
      ...(kind.startsWith("codex-role-") ? { toolPacks: true } : {}),
      ...(kind.startsWith("sdk-managed-specialist")
        ? { toolSkill: await pinToolSkill() }
        : {}),
      status: "running",
      prepared: true,
      startedAt: Date.now(),
      runtimeVersion: { id: "probe-initialized", tag: "fixture" }
    });

    if (kind === "prompt-compatibility")
      return probePromptCompatibility(context);
    if (kind.startsWith("package-only")) return probePackageOnly(context);
    if (kind.startsWith("codex-role-")) {
      const catalog = await this.codexToolCatalog();
      const names = catalog.map((tool) => tool.name);
      const read = await this.codexToolCall(
        "computer_read",
        { path: "README.md" },
        "codex-read"
      );
      const forbidden =
        input.role === "reporter" ? "hack_result" : "report_result";
      if (names.includes(forbidden))
        throw new Error("Cross-role result tool leaked");
      let crossRoleDenied = false;
      try {
        await this.codexToolCall(forbidden, {}, "codex-cross-role");
      } catch {
        crossRoleDenied = true;
      }
      await this.cancel();
      let lateCallDenied = false;
      try {
        await this.codexToolCall(
          "computer_read",
          { path: "README.md" },
          "codex-after-cancel"
        );
      } catch {
        lateCallDenied = true;
      }
      return { names, read, crossRoleDenied, lateCallDenied };
    }

    const scenario = attemptScenario(kind);
    if (!scenario) throw new Error("Unknown probe");
    return scenario(context);
  }
  private async installRemoteFixture() {
    await this.ctx.storage.put("remoteCatalog", {
      tools: [
        {
          name: "nmap_get_scan_results",
          inputSchema: {
            type: "object",
            properties: { scan_id: { type: "string" } },
            required: ["scan_id"]
          }
        },
        {
          name: "nmap_list_active_scans",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    });
    (this as unknown as { remote(): Promise<object> }).remote = async () => ({
      call: async (name: string, _args: object) => {
        if (name === "nmap_port_scan") {
          await this.ctx.storage.put(
            "fakeRemoteStarts",
            ((await this.ctx.storage.get<number>("fakeRemoteStarts")) ?? 0) + 1
          );
          if (!(await this.ctx.storage.get("fakeKnownRunning")))
            throw new Error("Injected response lost after remote mutation");
        }
        const status =
          (await this.ctx.storage.get("fakeKnownRunning")) &&
          !(await this.ctx.storage.get("fakeKnownFinished"))
            ? "running"
            : "completed";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                scan_id: "probe-scan",
                target: "127.0.0.1",
                scan_type: "port",
                status
              })
            }
          ],
          isError: false
        };
      }
    });
  }
  async afterSessionEviction() {
    const before = await this.execution();
    const sid = await this.ctx.storage.get<{ sessionId: string }>("mcpSession");
    const original = await this.ctx.storage.get<string>("fixture:originalSid");
    const native = this as unknown as { remote(): Promise<ToolboxMCP> };
    const remote = await native.remote();
    for (let index = 0; index < 6; index++)
      await this.inspectRemote("nmap_get_scan_results", {
        scan_id: "session-scan"
      });
    await this.ctx.storage.delete("fixture:cancelledWireId");
    const cancellation = new AbortController();
    const waiting = remote.call(
      "nmap_get_scan_results",
      { scan_id: "cancel-probe" },
      cancellation.signal,
      5000
    );
    for (
      let tick = 0;
      tick < 100 && !(await this.ctx.storage.get("fixture:newHeldWireId"));
      tick++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    cancellation.abort("Only the new inspection is cancelled");
    await waiting.catch(() => undefined);
    for (
      let tick = 0;
      tick < 100 && !(await this.ctx.storage.get("fixture:cancelledWireId"));
      tick++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const oldId = await this.ctx.storage.get<string | number>(
      "fixture:oldWireId"
    );
    const oldPendingRetained =
      oldId !== undefined &&
      !!(await this.ctx.storage.get(`fixture:pending:${oldId}`));
    const newId = await this.ctx.storage.get("fixture:newHeldWireId");
    const cancelledId = await this.ctx.storage.get("fixture:cancelledWireId");
    const ids =
      (await this.ctx.storage.get<Array<string | number>>("fixture:wireIds")) ??
      [];
    const wireIdsUnique =
      new Set(ids).size === ids.length &&
      ids.every((id) => typeof id === "string");
    const collision = !!(await this.ctx.storage.get("fixture:idCollision"));
    await this.ctx.storage.put("fixture:completeOld", true);
    const resolution = await this.reconcileRemote("session-lost", {
      inspectionTool: "nmap_get_scan_results",
      scanId: "session-scan",
      identityEvidence: {
        source: "captured-response",
        reference: "Fixture exact lost session-scan original response",
        confirmedExactOperation: true
      }
    });
    return {
      wireIdsUnique,
      collision,
      oldPendingRetained,
      cancelOnlyNew: cancelledId === newId && cancelledId !== oldId,
      before,
      resolution,
      reusedSid: sid?.sessionId === original,
      after: await this.execution(),
      initializes: await this.ctx.storage.get("fixture:initializes"),
      deletes: await this.ctx.storage.get("fixture:deletes"),
      deleteAfterProof: await this.ctx.storage.get("fixture:deleteAfterProof"),
      saved: !!(await this.ctx.storage.get("mcpSession"))
    };
  }
  async purgedSnapshot() {
    const checks: Record<string, unknown> = {
      keys: [...(await this.ctx.storage.list())],
      alarm: await this.ctx.storage.getAlarm(),
      readiness: await this.purgeReadiness("local-run")
    };
    try {
      await this.run({} as AttemptInput);
      checks.replay = "allowed";
    } catch (error) {
      checks.replay = String(error);
    }
    try {
      await this.inspect();
      checks.inspect = "allowed";
    } catch (error) {
      checks.inspect = String(error);
    }
    checks.browser = await this.browserLiveView();
    checks.execution = await this.execution();
    return checks;
  }
  async evict(): Promise<void> {
    await this.ctx.storage.sync();
    this.ctx.abort("Unknown receipt eviction regression");
  }
  async afterPlatformEviction() {
    const before = await this.execution();
    let controlsFenced = false;
    try {
      await this.sessionControls();
    } catch (error) {
      controlsFenced = String(error).includes("409:");
    }
    await this.lifecycle.start();
    await this.lifecycle.alarm();
    const lifecycleStartupSkipped = !(await this.ctx.storage.get("startup"));
    await this.cancel();
    return {
      before,
      controlsFenced,
      lifecycleStartupSkipped,
      cancelled: await this.execution()
    };
  }
  async afterToolboxEviction(): Promise<object> {
    const input = (await this.ctx.storage.get<AttemptInput>(
      "fixture:replayInput"
    ))!;
    await this.ctx.storage.put("fixture:holdModel", false);
    await this.ctx.storage.put("fixture:stopBeforeModel", true);
    const modelsBefore = await this.ctx.storage.get("fixture:modelRequests");
    const readiesBefore = await this.ctx.storage.get("fixture:readies");
    await this.lifecycle.start();
    const queued = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM cf_agents_jobs WHERE id LIKE 'opencode-wake:%'"
      )
      .one().count;
    // Accelerate the existing SDK wake; there is no additional recovery job.
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_jobs SET time=0, running=0, execution_started_at=NULL WHERE id LIKE 'opencode-wake:%'"
    );
    await this.lifecycle.alarm();
    const afterAlarm = {
      models: await this.ctx.storage.get("fixture:modelRequests"),
      readies: await this.ctx.storage.get("fixture:readies"),
      wakes: this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM cf_agents_jobs WHERE id LIKE 'opencode-wake:%'"
        )
        .one().count
    };
    const result = await this.run(input);
    const users = (await this.harness.session().history()).filter(
      (message) => message.type === "user"
    ).length;
    const modelsAfter = await this.ctx.storage.get("fixture:modelRequests");
    const calls = (await this.ctx.storage.get("fixture:toolCalls")) ?? 0;
    await this.harness.dispose();
    await this.ctx.storage.deleteAlarm();
    return {
      queued,
      modelsBefore,
      readiesBefore,
      afterAlarm,
      result,
      users,
      modelsAfter,
      calls
    };
  }
  async afterEviction() {
    await this.installRemoteFixture();
    const before = await this.execution();
    const remote = this as unknown as {
      executeRemoteTool(
        name: string,
        args: object,
        id: string
      ): Promise<unknown>;
    };
    let newCallFenced = false;
    try {
      await remote.executeRemoteTool(
        "nmap_port_scan",
        { target: "127.0.0.1", ports: "8081" },
        "after-eviction-new"
      );
    } catch {
      newCallFenced = true;
    }
    const identityEvidence = {
      source: "captured-response" as const,
      reference:
        "Fixture captured response for exactly lost-first with probe-scan",
      confirmedExactOperation: true as const
    };
    let missingAttestationRejected = false;
    try {
      await this.reconcileRemote("lost-first", {
        inspectionTool: "nmap_get_scan_results",
        scanId: "probe-scan"
      });
    } catch {
      missingAttestationRejected = true;
    }
    let wrongProofRejected = false;
    try {
      await this.reconcileRemote("lost-first", {
        inspectionTool: "nmap_get_scan_results",
        scanId: "different-scan",
        identityEvidence
      });
    } catch {
      wrongProofRejected = true;
    }
    const resolution = await this.reconcileRemote("lost-first", {
      inspectionTool: "nmap_get_scan_results",
      scanId: "probe-scan",
      identityEvidence
    });
    return {
      missingAttestationRejected,
      before,
      newCallFenced,
      wrongProofRejected,
      resolution,
      after: await this.execution(),
      starts: await this.ctx.storage.get("fakeRemoteStarts")
    };
  }
}
export class ProbeModelTest extends OpenCodeConnectionTest {
  private requests: Array<{
    native: boolean;
    authenticated: boolean;
    model: string;
    tools: number;
  }> = [];
  private origin = "";
  protected override create(options: OpenCodeWorkerd.CreateOptions) {
    const owner = this;
    // Preserve the production handler's dynamic import of the embedded engine.
    return super.create({
      ...options,
      plugins: [
        ...(options.plugins ?? []),
        Plugin.define({
          id: "fixture.http",
          async setup(ctx) {
            await ctx.session.hook("retry", (event) => {
              event.decision = { retry: false };
            });
            await ctx.session.hook("http.request", async (event) => {
              const request = event.request,
                body = (await request.clone().json()) as {
                  model: string;
                  tools?: unknown[];
                };
              owner.requests.push({
                native:
                  !!request.headers.get("x-opencode-client") &&
                  !!request.headers.get("x-opencode-session-id"),
                authenticated:
                  request.headers.get("authorization") ===
                  "Bearer fixture-model-key",
                model: body.model,
                tools: body.tools?.length ?? 0
              });
              event.request = new Request(
                owner.origin + "/fake-provider",
                request
              );
            });
          }
        })
      ]
    });
  }
  async check(origin: string) {
    this.origin = origin;
    const model: PinnedModel = {
      id: "opencode:fixture-console",
      modelId: "fixture-console",
      provider: "opencode",
      route: "console",
      adapter: "chat-completions",
      name: "Fixture Console",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "https://opencode.ai/inference/openai/v1",
      contextLength: 128000,
      outputLimit: 8192,
      compatibility: { reasoning_field: "reasoning_content" },
      reasoningEfforts: ["default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: [],
      credentialId: "fixture-key",
      credentialVersion: 1,
      catalogDigest: "a".repeat(64),
      testedAt: Date.now()
    };
    try {
      await this.probeModel(model, "fixture-model-key");
    } catch (error) {
      return { error: String(error), requests: this.requests };
    }
    return {
      requests: this.requests,
      empty: (await this.ctx.storage.list()).size === 0
    };
  }
}
export default {
  async fetch(
    request: Request,
    env: {
      ATTEMPTS: DurableObjectNamespace<ProbeAttempt>;
      MODEL_TESTS: DurableObjectNamespace<ProbeModelTest>;
    }
  ) {
    const url = new URL(request.url);
    const kind = url.pathname.slice(1);
    const fixture = await fixtureServices(request);
    if (fixture) return fixture;
    if (kind === "native-model-probe")
      return Response.json(
        await env.MODEL_TESTS.getByName(crypto.randomUUID()).check(url.origin)
      );
    const attempt = env.ATTEMPTS.getByName(
      url.searchParams.get("name") ?? `${kind}-${crypto.randomUUID()}`
    );
    try {
      if (kind.startsWith("preparation-"))
        await attempt.configurePreparation(
          url.origin,
          kind === "preparation-chat",
          url.searchParams.get("failure")
        );
      if (kind === "after-purge")
        return Response.json(await attempt.purgedSnapshot());
      if (kind === "purge-absent")
        return Response.json(await attempt.purge("local-run"));
      if (kind === "evict") {
        await attempt.evict();
        return Response.json({ evicted: true });
      }
      if (kind === "after-session-eviction")
        return Response.json(await attempt.afterSessionEviction());
      if (kind === "after-platform-eviction")
        return Response.json(await attempt.afterPlatformEviction());
      if (kind === "after-toolbox-eviction")
        return Response.json(await attempt.afterToolboxEviction());
      if (kind === "after-eviction")
        return Response.json(await attempt.afterEviction());
      return Response.json(await attempt.probe(kind, url.origin));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.stack : String(error) },
        { status: 500 }
      );
    }
  }
};
