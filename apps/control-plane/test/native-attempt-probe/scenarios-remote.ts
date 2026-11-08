import type { ProbeScenarioContext } from "./worker";
import { ToolboxMCP } from "../../src/native/tools";
export async function probeSession(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, checks } = context;

  if (kind === "session-stateless") {
    await context.ctx.storage.put("fixture:stateless", true);
    const hooks = {
      load: () =>
        context.ctx.storage.get<{
          sessionId: string;
          protocolVersion?: string;
        }>("mcpSession"),
      save: (value: object) => context.ctx.storage.put("mcpSession", value),
      clear: async () => {
        await context.ctx.storage.delete("mcpSession");
      }
    };
    const binding = {
      fetch: (request: Request) => context.sessionMCP(context.ctx, request)
    } as unknown as Fetcher;
    const first = new ToolboxMCP(binding, hooks, "fixture-generation");
    await first.list();
    await first.detach();
    const second = new ToolboxMCP(binding, hooks, "fixture-generation");
    await second.list();
    await second.close();
    checks.initializes = await context.ctx.storage.get("fixture:initializes");
    checks.deletes = (await context.ctx.storage.get("fixture:deletes")) ?? 0;
    checks.saved = !!(await context.ctx.storage.get("mcpSession"));
  } else {
    const native = context.attempt as unknown as {
      remote(): Promise<ToolboxMCP>;
      remoteTools(remote: ToolboxMCP): Promise<object[]>;
      executeRemoteTool(
        name: string,
        args: object,
        id: string
      ): Promise<unknown>;
    };
    const remote = await native.remote();
    await Promise.all([remote.list(), remote.list()]);
    await native.remoteTools(remote);
    if (kind === "session")
      await context.ctx.storage.put("fixture:dropSessionReply", true);
    else await context.ctx.storage.put("fixture:failDelete", true);
    try {
      await native.executeRemoteTool(
        "nmap_port_scan",
        { target: "127.0.0.1" },
        "session-lost"
      );
    } catch {
      checks.lost = true;
    }
    await context.attempt.cancel();
    checks.before = await context.attempt.execution();
    checks.savedBeforeMutation = await context.ctx.storage.get(
      "fixture:persistedBeforeMutation"
    );
    checks.initializes = await context.ctx.storage.get("fixture:initializes");
    checks.deletesBefore =
      (await context.ctx.storage.get("fixture:deletes")) ?? 0;
    if (kind === "session-cleanup-failure") {
      checks.refused = [];
      for (const status of [404, 405]) {
        await context.ctx.storage.put("fixture:failDelete", status);
        (checks.refused as object[]).push({
          status,
          execution: await context.attempt.execution(),
          saved: !!(await context.ctx.storage.get("mcpSession"))
        });
      }
      await context.ctx.storage.put("fixture:failDelete", false);
      checks.after = await context.attempt.execution();
      checks.savedAfter = !!(await context.ctx.storage.get("mcpSession"));
      checks.deletes = await context.ctx.storage.get("fixture:deletes");
    }
  }

  return context.checks;
}
export async function probeMetasploit(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, checks } = context;

  const tools = [
    "metasploit_start_listener",
    "metasploit_stop_job",
    "metasploit_terminate_session",
    "metasploit_list_listeners",
    "metasploit_list_active_sessions"
  ];
  await context.ctx.storage.put("remoteCatalog", {
    tools: tools.map((name) => ({
      name,
      inputSchema: { type: "object", properties: {} }
    }))
  });
  let job = true,
    session = kind !== "metasploit-stale-inventory",
    stops = 0,
    launches = 0,
    closed = false,
    closes = 0,
    opensAfterClose = 0;
  let holdOldInventory = false,
    oldInventoryEntered!: () => void,
    releaseOldInventory!: () => void;
  const inventoryEntered = new Promise<void>((resolve) => {
    oldInventoryEntered = resolve;
  });
  const inventoryRelease = new Promise<void>((resolve) => {
    releaseOldInventory = resolve;
  });
  const inspectOrder: string[] = [];
  const backend = {
    close: async () => {
      closed = true;
      closes++;
      await context.ctx.storage.delete("mcpSession");
    },
    detach: async () => {},
    call: async (name: string, args: Record<string, unknown>) => {
      let data: object;
      if (name === "metasploit_start_listener") {
        launches++;
        data =
          kind === "metasploit-unknown"
            ? { status: "unknown", result: { uuid: "owned-execution" } }
            : {
                status: "success",
                job_id: 0,
                uuid: "owned-execution",
                session_id: null
              };
      } else if (name === "metasploit_stop_job") {
        stops++;
        job = false;
        data = { status: "success", job_id: args.job_id };
      } else if (name === "metasploit_terminate_session") {
        stops++;
        session = false;
        data = { status: "success" };
      } else if (name === "metasploit_list_listeners") {
        inspectOrder.push("jobs");
        data = {
          status: "success",
          handlers: job ? { "0": { name: "owned" } } : {},
          other_jobs: {},
          handler_count: job ? 1 : 0,
          other_job_count: 0,
          total_job_count: job ? 1 : 0
        };
      } else if (name === "metasploit_list_active_sessions") {
        inspectOrder.push("sessions");
        data = {
          status: "success",
          sessions: session
            ? {
                "7": { exploit_uuid: "owned-execution" },
                "8": { exploit_uuid: "other-execution" }
              }
            : { "8": { exploit_uuid: "other-execution" } },
          count: session ? 2 : 1
        };
      } else throw new Error("Unexpected fixture tool");
      if (name === "metasploit_list_active_sessions" && holdOldInventory) {
        holdOldInventory = false;
        oldInventoryEntered();
        await inventoryRelease;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        isError: false
      };
    }
  };
  (context.attempt as unknown as { remote(): Promise<object> }).remote =
    async () => {
      if (closed) opensAfterClose++;
      return backend;
    };
  const native = context.attempt as unknown as {
    executeRemoteTool(name: string, args: object, id: string): Promise<unknown>;
  };
  await native.executeRemoteTool("metasploit_start_listener", {}, "listener");
  checks.before = await context.attempt.execution();
  try {
    await native.executeRemoteTool(
      "metasploit_start_listener",
      {},
      "new-launch"
    );
    checks.newCallFenced = false;
  } catch {
    checks.newCallFenced = true;
  }
  try {
    await context.attempt.controlRemote(
      "metasploit_terminate_session",
      { session_id: 8 },
      "unowned"
    );
    checks.unownedRejected = false;
  } catch {
    checks.unownedRejected = true;
  }
  await context.attempt.cancel();
  if (kind === "metasploit-stale-inventory") {
    holdOldInventory = true;
    const oldSessions = context.attempt.inspectRemote(
      "metasploit_list_active_sessions",
      {}
    );
    await inventoryEntered;
    job = false;
    session = true;
    await context.attempt.inspectRemote("metasploit_list_listeners", {});
    releaseOldInventory();
    await oldSessions;
    checks.afterStale = await context.attempt.remoteReceipts();
    checks.after = await context.attempt.execution();
    checks.terminate = await context.attempt.controlRemote(
      "metasploit_terminate_session",
      { session_id: 7 },
      "fresh-session-terminate"
    );
  } else if (kind.endsWith("race")) {
    await context.ctx.storage.put("mcpSession", {
      sessionId: "owned-backend"
    });
    const storage = context.ctx.storage as unknown as {
      get: (...args: unknown[]) => Promise<unknown>;
    };
    const get = storage.get.bind(context.ctx.storage);
    let release!: () => void,
      entered!: () => void,
      hold = true;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    storage.get = async (...args: unknown[]) => {
      if (hold && args[0] === "remoteCatalog") {
        hold = false;
        entered();
        await held;
      }
      return get(...args);
    };
    const request =
      kind === "metasploit-control-race"
        ? context.attempt.controlRemote(
            "metasploit_stop_job",
            { job_id: 0 },
            "racing-stop"
          )
        : context.attempt.inspectRemote("metasploit_list_listeners", {});
    const outcome = request.then(
      () => "fulfilled",
      (error) => (error instanceof Error ? error.message : String(error))
    );
    await admitted;
    job = false;
    session = false;
    checks.during = await context.attempt.execution();
    checks.closesDuring = closes;
    release();
    checks.requestOutcome = await outcome;
    storage.get = get;
    checks.after = await context.attempt.execution();
    checks.closes = closes;
    checks.opensAfterClose = opensAfterClose;
    try {
      await context.attempt.controlRemote(
        "metasploit_stop_job",
        { job_id: 0 },
        "retired-stop"
      );
      checks.retiredControlRejected = false;
    } catch {
      checks.retiredControlRejected = true;
    }
    try {
      await context.attempt.inspectRemote("metasploit_list_listeners", {});
      checks.retiredInspectionRejected = false;
    } catch {
      checks.retiredInspectionRejected = true;
    }
  } else if (kind === "metasploit-owned") {
    checks.stop = await context.attempt.controlRemote(
      "metasploit_stop_job",
      { job_id: 0 },
      "stop-job"
    );
    checks.afterJob = await context.attempt.execution();
    checks.stopDuplicate = await context.attempt.controlRemote(
      "metasploit_stop_job",
      { job_id: 0 },
      "stop-job"
    );
    checks.terminate = await context.attempt.controlRemote(
      "metasploit_terminate_session",
      { session_id: 7 },
      "terminate-session"
    );
    checks.after = await context.attempt.execution();
  } else {
    job = false;
    session = false;
    checks.after = await context.attempt.execution();
    try {
      await context.attempt.controlRemote(
        "metasploit_stop_job",
        { job_id: 0 },
        "unknown-stop"
      );
      checks.unknownControlRejected = false;
    } catch {
      checks.unknownControlRejected = true;
    }
  }
  checks.receipts = await context.attempt.remoteReceipts();
  checks.launches = launches;
  checks.stops = stops;
  checks.inspectOrder = inspectOrder;

  return context.checks;
}
export async function probeMcpSchema(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  let initialized = false;
  const binding = {
    fetch: async (request: Request) => {
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: {
            "X-Pentcloud-Toolbox-Generation": "fixture-generation"
          }
        });
      const rpc = (await request.json()) as { id?: number; method: string };
      if (rpc.method === "notifications/initialized") {
        initialized = true;
        return new Response(null, {
          status: 202,
          headers: {
            "X-Pentcloud-Toolbox-Generation": "fixture-generation"
          }
        });
      }
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "schema-canary", version: "1" }
            }
          : rpc.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "schema_canary",
                    inputSchema: { type: "object", properties: {} },
                    outputSchema: {
                      type: "object",
                      properties: { ok: { type: "boolean" } },
                      required: ["ok"],
                      additionalProperties: false
                    }
                  }
                ]
              }
            : {
                content: [{ type: "text", text: "Validated without eval" }],
                structuredContent: { ok: true },
                isError: false
              };
      return Response.json(
        { jsonrpc: "2.0", id: rpc.id, result },
        {
          headers: {
            "X-Pentcloud-Toolbox-Generation": "fixture-generation"
          }
        }
      );
    }
  };
  const client = new ToolboxMCP(
    binding as unknown as Fetcher,
    undefined,
    "fixture-generation"
  );
  try {
    checks.catalog = await client.list();
    checks.result = await client.call("schema_canary", {});
    checks.initialized = initialized;
  } finally {
    await client.close();
  }

  return context.checks;
}
export async function probeRemoteMutation(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, checks } = context;

  await context.installRemoteFixture();
  const remote = context.attempt as unknown as {
    executeRemoteTool(name: string, args: object, id: string): Promise<unknown>;
  };
  if (kind === "known-running")
    await context.ctx.storage.put("fakeKnownRunning", true);
  try {
    checks.first = await remote.executeRemoteTool(
      "nmap_port_scan",
      { target: "127.0.0.1", ports: "8081" },
      "lost-first"
    );
  } catch {
    checks.firstLost = true;
  }
  try {
    await remote.executeRemoteTool(
      "nmap_port_scan",
      { target: "127.0.0.1", ports: "8081" },
      "new-second"
    );
    checks.newCallFenced = false;
  } catch {
    checks.newCallFenced = true;
  }
  checks.starts = await context.ctx.storage.get("fakeRemoteStarts");
  checks.before = await context.attempt.execution();
  if (kind === "known-running") {
    await context.ctx.storage.put("fakeKnownFinished", true);
    checks.after = await context.attempt.execution();
  } else {
    await context.attempt.cancel();
    checks.cancelled = await context.attempt.execution();
    checks.receipts = await context.attempt.remoteReceipts();
  }

  return context.checks;
}
export async function probeDrain(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { shell, checks } = context;

  const pending = shell("sleep 30");
  await new Promise((resolve) => setTimeout(resolve, 25));
  checks.before = await context.attempt.execution();
  await context.attempt.cancel();
  checks.cancelled = await context.attempt.execution();
  try {
    await pending;
    checks.lateRejected = false;
  } catch {
    checks.lateRejected = true;
  }
  checks.after = await context.attempt.execution();
  checks.published = context.published;

  return context.checks;
}
export async function probeCancel(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  await context.attempt.cancel();
  try {
    await internal.publish({
      tool: "yield",
      arguments: { message: "late", plan: "late" },
      status: "waiting",
      finishedAt: Date.now()
    });
    checks.lateRejected = false;
  } catch {
    checks.lateRejected = true;
  }
  checks.published = context.published;
  checks.state = await context.ctx.storage.get("attempt");

  return context.checks;
}
