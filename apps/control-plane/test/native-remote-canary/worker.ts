import { createParser } from "eventsource-parser";
import {
  CallToolResultSchema,
  JSONRPCMessageSchema
} from "@modelcontextprotocol/sdk/types.js";
import { NativeAttempt } from "../../src/native/attempt";
import { remoteResultObject } from "../../src/native/tool-policy";
import type { AttemptInput, NativeEnv } from "../../src/native/types";
import type { ToolboxService } from "../../../../shared/toolbox-rpc";

interface CanaryEnv {
  ATTEMPTS: DurableObjectNamespace<RemoteCanaryAttempt>;
  TOOLBOX: ToolboxService;
  CANARY_TOKEN?: string;
}
interface Internals {
  remote(): Promise<{ list(): Promise<unknown[]> }>;
  remoteTools(remote: unknown): Promise<unknown[]>;
  executeRemoteTool(
    name: string,
    args: Record<string, unknown>,
    id: string
  ): Promise<unknown>;
}
const scanArguments = {
  target: "127.0.0.1",
  ports: "8081",
  timing: 4,
  timeout: 30
};
interface WireRecord {
  method: string;
  rpc?: string | undefined;
  tool?: string | undefined;
  time: number;
  responseStatus: number;
  requestSessionDigest?: string;
  responseSessionDigest?: string;
  requestIdDigest?: string;
}
async function sha(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    )
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Fixture-only observation of a completed HTTP response; stock MCP framing uses its standard parser and SDK schemas. */
async function observedReply(
  response: Response,
  requestId: unknown
): Promise<{ raw: string; result: Record<string, unknown> }> {
  let result: Record<string, unknown> | undefined;
  const observe = (frame: unknown) => {
    const message = JSONRPCMessageSchema.parse(frame);
    if ("id" in message && message.id === requestId && "result" in message)
      result = remoteResultObject(CallToolResultSchema.parse(message.result));
  };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const raw = await response.text();
    observe(JSON.parse(raw));
    assert(result, "Fixture could not identify completed JSON scan reply");
    return { raw, result };
  }
  assert(response.body, "Stock scan reply has no body");
  const parser = createParser({
    onEvent: (event) => observe(JSON.parse(event.data))
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let raw = "";
  try {
    while (!result) {
      const { done, value } = await reader.read();
      const text = decoder.decode(value, { stream: !done });
      raw += text;
      parser.feed(text);
      assert(
        raw.length < 4 * 1024 * 1024,
        "Fixture stock scan response exceeds bound"
      );
      if (done) break;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  assert(result, "Fixture could not identify completed SSE scan reply");
  return { raw, result };
}

/** Temporary live fixture. Actual NativeAttempt receipts and stock MCP transport; no model, Artifacts or user runs. */
export class RemoteCanaryAttempt extends NativeAttempt {
  private readonly boot = crypto.randomUUID();
  constructor(ctx: DurableObjectState, bindings: CanaryEnv) {
    const toolbox = {
      ready: (expected?: string) => bindings.TOOLBOX.ready(expected),
      status: () => bindings.TOOLBOX.status(),
      activity: (generation: string) => bindings.TOOLBOX.activity(generation),
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request && !init ? input : new Request(input, init);
        const payload =
          request.method === "POST"
            ? ((await request
                .clone()
                .json()
                .catch(() => undefined)) as
                | { id?: unknown; method?: string; params?: { name?: string } }
                | undefined)
            : undefined;
        const wireKey = `fixture:wire:${crypto.randomUUID()}`;
        const record: WireRecord = {
          method: request.method,
          rpc: payload?.method,
          tool: payload?.params?.name,
          time: Date.now(),
          responseStatus: 0,
          ...(payload?.id !== undefined
            ? { requestIdDigest: await sha(JSON.stringify(payload.id)) }
            : {}),
          ...(request.headers.get("mcp-session-id")
            ? {
                requestSessionDigest: await sha(
                  request.headers.get("mcp-session-id")!
                )
              }
            : {})
        };
        await ctx.storage.put(wireKey, record);
        const mutation =
          payload?.method === "tools/call" &&
          payload.params?.name === "nmap_port_scan";
        if (mutation)
          await ctx.storage.put(
            "fixture:mutationRequests",
            ((await ctx.storage.get<number>("fixture:mutationRequests")) ?? 0) +
              1
          );
        const response = await bindings.TOOLBOX.fetch(request);
        record.responseStatus = response.status;
        if (response.headers.get("mcp-session-id"))
          record.responseSessionDigest = await sha(
            response.headers.get("mcp-session-id")!
          );
        await ctx.storage.put(wireKey, record);
        if (mutation && (await ctx.storage.get<boolean>("fixture:dropReply"))) {
          await ctx.storage.put("fixture:dropReply", false);
          assert(
            response.ok,
            "Stock scan HTTP response failed before fault injection"
          );
          const { raw, result: completed } = await observedReply(
            response,
            payload?.id
          );
          assert(
            completed.status === "completed" &&
              completed.target === "127.0.0.1" &&
              completed.scan_type === "port" &&
              typeof completed.scan_id === "string",
            "Stock loopback scan did not complete"
          );
          const responseDigest = await sha(raw);
          await ctx.storage.put("fixture:observed", {
            responseDigest,
            scanId: completed.scan_id,
            status: completed.status,
            target: completed.target,
            scanType: completed.scan_type,
            responseBytes: new TextEncoder().encode(raw).byteLength
          });
          throw new Error(
            "Injected loss after actual stock scan completed, before official client received its HTTP response"
          );
        }
        return response;
      }
    };
    super(ctx, {
      TOOLBOX: toolbox,
      CONTROL_TOKEN: "nonsecret-canary-sentinel",
      ARTIFACTS: {},
      COORDINATOR: {
        getByName: () => ({
          assertActive: async () => {},
          getContext: async () => ({})
        })
      }
    } as unknown as NativeEnv);
    this.harness.abort = async () => true;
  }
  async setup() {
    assert(
      !(await this.ctx.storage.get("attempt")),
      "Canary identity is already initialized"
    );
    const id = "native-remote-canary";
    const input: AttemptInput = {
      id,
      runId: "native-remote-canary",
      role: "pentester",
      tool: "pentester",
      args: { task: "Loopback response-loss proof" },
      task: "Loopback response-loss proof",
      inputCommit: "a".repeat(40),
      repo: "unused-canary",
      remote: "https://invalid.example/unused.git",
      settingsRevision: "b".repeat(64),
      settings: {
        promptTemplate: "No model calls",
        upstreamPromptDigest: "c".repeat(64),
        model: "opencode-go:deepseek-v4-pro",
        reasoningEffort: "default"
      },
      depth: 0,
      attempt: 1,
      logicalThreadId: id,
      context: {},
      createdAt: Date.now()
    };
    await this.ctx.storage.put("attempt", {
      input,
      fingerprint: "fixture",
      prompt: "No model calls",
      promptDigest: "d".repeat(64),
      status: "running",
      prepared: true,
      startedAt: Date.now()
    });
    const native = this as unknown as Internals;
    const tools = await native.remoteTools(await native.remote());
    await this.ctx.storage.put("fixture:dropReply", true);
    return { catalogCount: tools.length, boot: this.boot, modelCalls: 0 };
  }
  async loseReply() {
    const native = this as unknown as Internals;
    let lost = "",
      fenced = "";
    try {
      await native.executeRemoteTool("nmap_port_scan", scanArguments, "lost-1");
    } catch (error) {
      lost = String(error);
    }
    assert(
      lost.includes("Injected loss"),
      "Expected injection was not observed by NativeAttempt"
    );
    try {
      await native.executeRemoteTool("nmap_port_scan", scanArguments, "lost-2");
    } catch (error) {
      fenced = String(error);
    }
    assert(
      fenced.includes("unresolved"),
      "New call identity bypassed unresolved mutation fence"
    );
    const state = await this.status();
    assert(
      state.mutationRequests === 1 && state.execution.drained === false,
      "Lost remote response released execution or repeated mutation"
    );
    return { ...state, lostReplyRejected: true, newCallIdFenced: true };
  }
  async cancelProof() {
    await this.cancel();
    const state = await this.status();
    assert(
      !state.execution.drained && state.execution.state === "cancelled",
      "Cancellation released unresolved remote operation"
    );
    return state;
  }
  async resetProof(): Promise<never> {
    await this.ctx.storage.put("fixture:resetRequested", true);
    this.ctx.abort("Deliberate temporary canary eviction");
    throw new Error("Unreachable after eviction");
  }
  async status() {
    return {
      boot: this.boot,
      execution: await this.execution(),
      receipts: await this.remoteReceipts(),
      mutationRequests:
        (await this.ctx.storage.get<number>("fixture:mutationRequests")) ?? 0,
      observed: await this.ctx.storage.get("fixture:observed"),
      wire: [
        ...(
          await this.ctx.storage.list<WireRecord>({ prefix: "fixture:wire:" })
        ).values()
      ].sort((a, b) => a.time - b.time)
    };
  }
  async lookup(scanId: string) {
    return remoteResultObject(
      await this.inspectRemote("nmap_get_scan_results", { scan_id: scanId })
    );
  }
  async reconcileProof() {
    const observed = await this.ctx.storage.get<{
      scanId: string;
      responseDigest: string;
    }>("fixture:observed");
    assert(observed, "Missing fixture-only scan observation");
    let mismatched = "";
    try {
      await this.reconcileRemote("lost-1", {
        inspectionTool: "masscan_get_scan_results",
        scanId: observed.scanId
      });
    } catch (error) {
      mismatched = String(error);
    }
    assert(
      !!mismatched && !(await this.execution()).drained,
      "Mismatched backend reconciliation released hold"
    );
    const inspection = remoteResultObject(
      await this.inspectRemote("nmap_get_scan_results", {
        scan_id: observed.scanId
      })
    );
    assert(
      inspection.scan_id === observed.scanId &&
        inspection.target === "127.0.0.1" &&
        inspection.status === "completed",
      "Live inspector did not return matching terminal scan"
    );
    let unattested = "";
    try {
      await this.reconcileRemote("lost-1", {
        inspectionTool: "nmap_get_scan_results",
        scanId: observed.scanId
      });
    } catch (error) {
      unattested = String(error);
    }
    assert(
      !!unattested && !(await this.execution()).drained,
      "Unknown-ID reconciliation omitted exact-operation attestation"
    );
    const identityEvidence = {
      source: "captured-response" as const,
      reference: `Exact lost-1 response sha256:${observed.responseDigest}; stock scan_id:${observed.scanId}`,
      confirmedExactOperation: true as const
    };
    const reconciliation = await this.reconcileRemote("lost-1", {
      inspectionTool: "nmap_get_scan_results",
      scanId: observed.scanId,
      identityEvidence
    });
    const replay = await this.reconcileRemote("lost-1", {
      inspectionTool: "nmap_get_scan_results",
      scanId: observed.scanId
    });
    const state = await this.status();
    assert(
      state.execution.drained && state.mutationRequests === 1,
      "Positive terminal reconciliation failed to release hold"
    );
    const initialize = state.wire.filter((entry) => entry.rpc === "initialize");
    assert(
      initialize.length === 1 && initialize[0]?.responseSessionDigest,
      "Eviction created another MCP session instead of resuming"
    );
    assert(
      state.wire
        .filter((entry) => entry.requestSessionDigest)
        .every(
          (entry) =>
            entry.requestSessionDigest === initialize[0]!.responseSessionDigest
        ),
      "MCP session identity changed after eviction"
    );
    const requestIds = state.wire.flatMap((entry) =>
      entry.requestIdDigest ? [entry.requestIdDigest] : []
    );
    assert(
      new Set(requestIds).size === requestIds.length,
      "Eviction reused an MCP request ID"
    );
    return {
      ...state,
      requestIdsUniqueAcrossEviction: true,
      sameSessionResumed: true,
      initializeCount: initialize.length,
      mismatchedBackendRejected: true,
      missingIdentityAttestationRejected: true,
      inspection: {
        scanId: inspection.scan_id,
        target: inspection.target,
        status: inspection.status,
        scanType: inspection.scan_type
      },
      reconciliation,
      replay
    };
  }
  async clean() {
    let cleanupError: string | undefined;
    try {
      await (
        this as unknown as { toolbox?: { close(): Promise<void> } }
      ).toolbox?.close();
    } catch (error) {
      cleanupError = String(error);
    }
    const wire = (await this.status()).wire;
    const established = wire.some(
      (entry) => entry.rpc === "initialize" && entry.responseSessionDigest
    );
    const teardown = wire.filter((entry) => entry.method === "DELETE");
    const terminated = teardown.some(
      (entry) => entry.responseStatus >= 200 && entry.responseStatus < 300
    );
    await this.ctx.storage.deleteAll();
    return {
      temporaryStorageCleared: (await this.ctx.storage.list()).size === 0,
      temporaryMcpSessionEstablished: established,
      temporaryMcpSessionTerminated: established ? terminated : null,
      teardown,
      ...(cleanupError ? { cleanupError } : {})
    };
  }
}
export default {
  async fetch(request: Request, env: CanaryEnv): Promise<Response> {
    if (
      !env.CANARY_TOKEN ||
      request.headers.get("Authorization") !== `Bearer ${env.CANARY_TOKEN}`
    )
      return new Response("Unauthorized", { status: 401 });
    const action = new URL(request.url).pathname;
    if (action === "/health") return Response.json({ ready: true });
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const attempt = env.ATTEMPTS.getByName("only-canary");
    try {
      if (action === "/setup") return Response.json(await attempt.setup());
      if (action === "/lose") return Response.json(await attempt.loseReply());
      if (action === "/cancel")
        return Response.json(await attempt.cancelProof());
      if (action === "/reset") return await attempt.resetProof();
      if (action === "/status") return Response.json(await attempt.status());
      if (action === "/lookup")
        return Response.json(
          await attempt.lookup(
            new URL(request.url).searchParams.get("scan_id") ?? ""
          )
        );
      if (action === "/reconcile")
        return Response.json(await attempt.reconcileProof());
      if (action === "/clean") return Response.json(await attempt.clean());
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  }
} satisfies ExportedHandler<CanaryEnv>;
