import type { ProbeScenarioContext } from "./worker";
import { ToolboxMCP } from "../../src/native/tools";
import { renderLaunch } from "../../src/native/prompts";
import { specialistSources } from "../../src/native/specialist-sources";
export async function probeSdkLiveTransport(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  await context.attempt.lifecycle.start();
  Object.assign(context.env, { OPENCODE_GO_API_KEY: "fixture-sensitive-key" });
  const image = "data:image/png;base64,aGVsbG8=";
  const tool = {
    type: "tool",
    id: "browser-call",
    name: "cloudflare_browser",
    state: {
      status: "completed",
      input: { action: "screenshot" },
      content: [{ type: "text", text: "Captured evidence" }],
      metadata: { cloudflareImages: [image] }
    }
  };
  let emit: (events: unknown[]) => void = () => {},
    stops = 0;
  const fake = {
    id: "ses_root",
    busy: async () => true,
    history: async () => [{ id: "answer", type: "assistant", content: [tool] }],
    events: async () => ({
      snapshot: {
        messages: [
          {
            id: "past-span",
            type: "assistant",
            time: { created: 0 },
            content: [{ type: "text", text: "Proof" }]
          },
          {
            id: "recover",
            type: "assistant",
            time: { created: 0 },
            content: [{ type: "text", text: "" }]
          },
          {
            id: "overlap",
            type: "assistant",
            time: { created: 0 },
            content: [{ type: "text", text: "Hello" }]
          }
        ],
        pending: [],
        permissions: [],
        busy: true
      },
      start: (listener: (events: unknown[]) => void) => {
        emit = listener;
      },
      stop: async () => {
        stops++;
      }
    }),
    log: async function* () {
      throw new Error("LOCAL_DURABLE_ONLY_TRANSPORT");
    }
  };
  context.attempt.harness.session = () =>
    fake as unknown as ReturnType<typeof context.attempt.harness.session>;
  const abort = new AbortController();
  const response = await context.attempt.events(
    new Request("https://probe.invalid/events", { signal: abort.signal })
  );
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let text = "";
  const until = async (marker: string) => {
    while (!text.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Live stream ended before " + marker);
      text += decoder.decode(chunk.value);
    }
  };
  await until("event: snapshot");
  checks.completedSnapshotRetained = text.includes('"text":"Proof"');
  emit([
    {
      type: "message_start",
      messageId: "answer",
      agent: "primary",
      model: { providerID: "opencode", id: "fixture" }
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 0,
      delta: "Partial live answer"
    }
  ]);
  await until("Partial live answer");
  checks.partialBeforeEnd = !text.includes("text_end");
  emit([
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 1,
      delta: "fixture-sensi"
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 1,
      delta: "tive-key"
    },
    {
      type: "text_end",
      messageId: "answer",
      ordinal: 1,
      text: "fixture-sensitive-key"
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 2,
      delta: '{"api_key": "live-'
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 2,
      delta: 'private-value"}'
    },
    {
      type: "text_end",
      messageId: "answer",
      ordinal: 2,
      text: '{"api_key": "live-private-value"}'
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 3,
      delta: 'PASSWORD="first '
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 3,
      delta: "private tail"
    },
    {
      type: "text_end",
      messageId: "answer",
      ordinal: 3,
      text: 'PASSWORD="first private tail'
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 4,
      delta: "API_TOKEN='first "
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 4,
      delta: "single tail"
    },
    {
      type: "text_delta",
      messageId: "answer",
      ordinal: 4,
      delta: "' permitted summary"
    },
    {
      type: "text_end",
      messageId: "answer",
      ordinal: 4,
      text: "API_TOKEN='first single tail' permitted summary"
    },
    {
      type: "text_delta",
      messageId: "recover",
      ordinal: 0,
      delta: "tive-key"
    },
    {
      type: "text_end",
      messageId: "recover",
      ordinal: 0,
      text: "fixture-sensitive-key"
    },
    {
      type: "text_delta",
      messageId: "overlap",
      ordinal: 0,
      delta: "Hello"
    },
    { type: "text_end", messageId: "overlap", ordinal: 0, text: "Hello" }
  ]);
  emit([
    {
      type: "tool_start",
      messageId: "answer",
      toolCallId: "browser-call",
      name: "cloudflare_browser",
      input: { action: "screenshot" }
    },
    {
      type: "tool_end",
      messageId: "answer",
      toolCallId: "browser-call",
      name: "cloudflare_browser",
      error: false,
      output: "Captured evidence"
    }
  ]);
  await until(image);
  checks.evidenceRetained = text.includes("nativeTool");
  abort.abort();
  await reader.cancel();
  checks.secretLeak =
    text.includes("fixture-sensi") ||
    text.includes("tive-key") ||
    text.includes("live-") ||
    text.includes("private-value");
  checks.quotedSecretLeak =
    text.includes("private tail") || text.includes("single tail");
  checks.overlapDuplicated = text.includes("HelloHello");
  checks.permittedSummary = text.includes("permitted summary");
  checks.stops = stops;
  checks.frames = text;
  checks.remainingStreams = (
    context.attempt as unknown as { sessionStreams: Set<unknown> }
  ).sessionStreams.size;
  checks.modelRequests =
    (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  checks.kaliReadies = (await context.ctx.storage.get("fixture:readies")) ?? 0;
  await context.attempt.harness.dispose();
  return checks;
}
export async function probeSdkTerminalCold(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  await context.attempt.lifecycle.start();
  const receipt = await context.attempt.harness.submit(
    "Retained terminal conversation",
    { operationId: "cold-history-no-model-http" }
  );
  await context.attempt.harness.wait(receipt.operationId, {
    session: receipt.session
  });
  const before = (await context.attempt.harness.session().history()).length;
  try {
    await context.attempt.recordedWork("local-run");
    checks.activeWorkDenied = false;
  } catch {
    checks.activeWorkDenied = true;
  }
  await context.attempt.cancel();
  const settled = (await context.ctx.storage.get<
    { result: Record<string, unknown> } & Record<string, unknown>
  >("attempt"))!;
  await context.ctx.storage.put("attempt", {
    ...settled,
    result: { ...settled.result, status: "completed" }
  });
  await context.attempt.harness.dispose();
  await context.ctx.storage.put("fixture:credentialDenied", true);
  const credentials =
      (await context.ctx.storage.get<number>("fixture:credentialReads")) ?? 0,
    models =
      (await context.ctx.storage.get<number>("fixture:modelRequests")) ?? 0;
  checks.before = before;
  checks.after = (
    (await context.attempt.inspect()) as { messages: unknown[] }
  ).messages.length;
  checks.events = await (
    await context.attempt.events(new Request("https://probe.invalid/events"))
  ).text();
  checks.canReply = (await context.attempt.sessionControls()).canReply;
  await context.attempt.harness.dispose();
  await context.ctx.storage.put("remote:recorded-proof", {
    name: "ffuf",
    state: "unknown",
    remoteId: "520de8b8",
    result: { output: "recorded 🧪 ".repeat(10000) }
  });
  let offset = 0,
    recorded = "",
    pages = 0;
  for (;;) {
    const page = await context.attempt.recordedWork("local-run", offset);
    recorded += page.text;
    pages++;
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  const work = JSON.parse(recorded);
  checks.recorded = {
    messages: work.messages.length,
    historyAvailable: work.historyAvailable,
    pages,
    remote: work.remoteCalls[0].state,
    outputLength: work.remoteCalls[0].result.output.length
  };
  try {
    await context.attempt.recordedWork("another-run");
    checks.crossRunWorkDenied = false;
  } catch {
    checks.crossRunWorkDenied = true;
  }
  checks.credentialReads =
    ((await context.ctx.storage.get<number>("fixture:credentialReads")) ?? 0) -
    credentials;
  checks.modelRequests =
    ((await context.ctx.storage.get<number>("fixture:modelRequests")) ?? 0) -
    models;
  checks.kaliReadies =
    (await context.ctx.storage.get<number>("fixture:readies")) ?? 0;
  try {
    await context.attempt.steer("Must remain stopped");
    checks.steerDenied = false;
  } catch {
    checks.steerDenied = true;
  }
  await context.attempt.harness.dispose();
  await context.ctx.storage.deleteAlarm();
  return checks;
}
export async function probeBrowserLiveView(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  const snapshot = async () =>
    JSON.stringify([...(await context.ctx.storage.list())]);
  const before = await snapshot();
  checks.absent = await context.attempt.browserLiveView();
  checks.absentNoWrites = before === (await snapshot());
  const state = (await context.ctx.storage.get<object>("attempt"))!;
  let browserReads = 0;
  let providerCalls = 0;
  const credential =
    "https://live.browser.run/ui/view?wss=fixture-readonly-bearer";
  Object.defineProperty(context.attempt.cloudBrowser, "liveView", {
    value: async () => {
      browserReads++;
      return {
        sessionId: "existing-browser",
        targets: [{ targetId: "existing-page", type: "page" }]
      };
    }
  });
  Object.assign(context.env, {
    BROWSER: {
      getLiveView: async (_session: string, options: object) => {
        providerCalls++;
        checks.options = options;
        return {
          devtoolsFrontendUrl: credential,
          options: { mode: "tab", guardrails: { mode: "readonly" } }
        };
      }
    }
  });
  const activeView = await context.attempt.browserLiveView();
  checks.created =
    activeView.available &&
    activeView.readOnly &&
    activeView.url === credential;
  checks.activeNoWrites = before === (await snapshot());
  for (const value of [
    undefined,
    { ...state, status: "settled" },
    { ...state, proposal: { tool: "done" } }
  ]) {
    if (value) await context.ctx.storage.put("attempt", value);
    else await context.ctx.storage.delete("attempt");
    const prior = await snapshot();
    if (
      (await context.attempt.browserLiveView()).available ||
      prior !== (await snapshot())
    )
      throw new Error("Historical view changed runtime state");
  }
  await context.ctx.storage.put("attempt", state);
  await context.ctx.storage.put("cancelled", true);
  checks.cancelled = !(await context.attempt.browserLiveView()).available;
  await context.ctx.storage.delete("cancelled");
  Object.assign(context.env, {
    BROWSER: {
      getLiveView: async () => {
        providerCalls++;
        await context.ctx.storage.put("cancelled", true);
        return {
          devtoolsFrontendUrl: credential,
          options: { mode: "tab", guardrails: { mode: "readonly" } }
        };
      }
    }
  });
  checks.cancellationRace = !(await context.attempt.browserLiveView())
    .available;
  checks.credentialsNotStored = !(await snapshot()).includes(
    "fixture-readonly-bearer"
  );
  checks.lifecycleNotStarted = !(await context.ctx.storage.get("startup"));
  checks.browserReads = browserReads;
  checks.providerCalls = providerCalls;

  return context.checks;
}
export async function probeToolboxEviction(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, checks } = context;

  await context.ctx.storage.put("fixture:holdModel", true);
  await context.ctx.storage.put("fixture:replayInput", input);
  // Finish SDK startup before observing its background model hook, so context.attempt
  // fixture's storage polling does not contend with startup's concurrency gate.
  await (
    context.attempt as unknown as {
      preflightToolbox(state: object): Promise<void>;
    }
  ).preflightToolbox((await context.ctx.storage.get<object>("attempt"))!);
  await context.attempt.lifecycle.start();
  context.ctx.waitUntil(
    (context.attempt as unknown as { execute(): Promise<unknown> })
      .execute()
      .catch(() => undefined)
  );
  for (
    let i = 0;
    i < 400 && !(await context.ctx.storage.get("fixture:modelHeld"));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!(await context.ctx.storage.get("fixture:modelHeld")))
    throw new Error("Model hold did not start");
  checks.users = (await context.attempt.harness.session().history()).filter(
    (message) => message.type === "user"
  ).length;
  checks.models = await context.ctx.storage.get("fixture:modelRequests");
  checks.modelKinds = await context.ctx.storage.get("fixture:modelKinds");
  checks.pending = await context.attempt.harness.pending();

  return context.checks;
}
export async function probeSdkToolboxCold(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  await context.ctx.storage.put("fixture:readyBlocked", true);
  await context.ctx.storage.put("fixture:partialWarmup", true);
  await context.ctx.storage.put("fixture:stopBeforeModel", true);
  const started = (
    context.attempt as unknown as { execute(): Promise<unknown> }
  ).execute();
  await new Promise((resolve) => setTimeout(resolve, 100));
  checks.before = {
    readies: (await context.ctx.storage.get("fixture:readies")) ?? 0,
    initializes: (await context.ctx.storage.get("fixture:initializes")) ?? 0,
    modelRequests: (await context.ctx.storage.get("fixture:modelRequests")) ?? 0
  };
  await context.ctx.storage.put("fixture:readyBlocked", false);
  checks.answer = await started;
  checks.modelKinds = await context.ctx.storage.get("fixture:modelKinds");
  checks.after = {
    generation: await context.ctx.storage.get("toolboxGeneration"),
    session: await context.ctx.storage.get("mcpSession"),
    catalog: await context.ctx.storage.get("remoteCatalog"),
    modelRequests: await context.ctx.storage.get("fixture:modelRequests"),
    initializes: await context.ctx.storage.get("fixture:initializes"),
    deletes: await context.ctx.storage.get("fixture:deletes"),
    modelsAtPartial: await context.ctx.storage.get(
      "fixture:modelsAtPartialCatalog"
    ),
    partialCatalogWasPinned: await context.ctx.storage.get(
      "fixture:partialCatalogWasPinned"
    )
  };
  await context.attempt.cancel();
  await context.attempt.harness.dispose();
  await context.ctx.storage.deleteAlarm();

  return context.checks;
}
export async function probeToolboxActivity(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  await context.attempt.execution();
  checks.withoutOwnership =
    (await context.ctx.storage.get("fixture:activities")) ?? 0;
  await context.ctx.storage.put("toolboxGeneration", "fixture-generation");
  await context.attempt.execution();
  checks.active = (await context.ctx.storage.get("fixture:activities")) ?? 0;
  await context.attempt.cancel();
  await context.attempt.execution();
  checks.drained = (await context.ctx.storage.get("fixture:activities")) ?? 0;
  await context.ctx.storage.put("remote:held", {
    state: "unknown",
    name: "nmap_port_scan",
    fingerprint: "held"
  });
  await context.attempt.execution();
  checks.held = (await context.ctx.storage.get("fixture:activities")) ?? 0;
  checks.readies = (await context.ctx.storage.get("fixture:readies")) ?? 0;

  return context.checks;
}
export async function probeToolboxGenerationLoss(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  const native = context.attempt as unknown as {
    remote(): Promise<ToolboxMCP>;
    executeRemoteTool(name: string, args: object, id: string): Promise<unknown>;
  };
  await (await native.remote()).list();
  await context.ctx.storage.put("fixture:dropSessionReply", true);
  try {
    await native.executeRemoteTool(
      "nmap_port_scan",
      { target: "127.0.0.1" },
      "generation-lost"
    );
  } catch {}
  checks.firstInitializes = await context.ctx.storage.get(
    "fixture:initializes"
  );
  await context.ctx.storage.put("fixture:generation", "replacement-generation");
  let blocked = 0;
  try {
    await (await native.remote()).list();
  } catch {
    blocked++;
  }
  try {
    await native.executeRemoteTool(
      "nmap_port_scan",
      { target: "127.0.0.1" },
      "generation-lost"
    );
  } catch {
    blocked++;
  }
  try {
    await context.attempt.harness.opencode();
  } catch {
    blocked++;
  }
  checks.blocked = blocked;
  checks.initializes = await context.ctx.storage.get("fixture:initializes");
  checks.receipts = await context.attempt.remoteReceipts();
  checks.execution = await context.attempt.execution();
  checks.session = await context.ctx.storage.get("mcpSession");
  await context.attempt.cancel();
  checks.cancelled = await context.attempt.execution();
  const receipt = (await context.ctx.storage.get<Record<string, unknown>>(
    "remote:generation-lost"
  ))!;
  await context.ctx.storage.put("remote:generation-lost", {
    ...receipt,
    state: "reconciled"
  });
  checks.reconciled = await context.attempt.execution();
  checks.sessionAfterReconciled =
    !!(await context.ctx.storage.get("mcpSession"));

  return context.checks;
}
export async function probeToolboxCleanupLost(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, checks } = context;

  const native = context.attempt as unknown as {
    remote(): Promise<ToolboxMCP>;
  };
  if (kind === "toolbox-legacy-session")
    await context.ctx.storage.put("mcpSession", {
      sessionId: "unversioned-legacy"
    });
  else await (await native.remote()).list();
  if (kind === "toolbox-cleanup-lost")
    await context.ctx.storage.put(
      "fixture:generation",
      "replacement-generation"
    );
  if (kind === "toolbox-upstream-conflict")
    await context.ctx.storage.put("fixture:failDelete", 409);
  await context.attempt.cancel();
  checks.after = await context.attempt.execution();
  checks.sessionHeld = !!(await context.ctx.storage.get("mcpSession"));
  checks.initializes =
    (await context.ctx.storage.get("fixture:initializes")) ?? 0;
  checks.readies = (await context.ctx.storage.get("fixture:readies")) ?? 0;
  checks.deletes =
    (await context.ctx.storage.get("fixture:deleteAttempts")) ?? 0;
  if (kind === "toolbox-upstream-conflict") {
    await context.ctx.storage.put("fixture:failDelete", false);
    checks.recovered = await context.attempt.execution();
    checks.sessionAfterRecovery =
      !!(await context.ctx.storage.get("mcpSession"));
  }

  return context.checks;
}
export async function probePlatformBackoff(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  await context.attempt.onAlarmMemoryLimit({
    sealed: false,
    nextTime: Date.now() + 60000
  });
  try {
    await context.attempt.sessionControls();
    checks.controlsFenced = false;
  } catch (error) {
    checks.controlsFenced = String(error).includes("409:");
  }
  await context.attempt.lifecycle.start();
  await context.attempt.lifecycle.alarm();
  checks.lifecycleStartupSkipped = !(await context.ctx.storage.get("startup"));
  const recovery = (await context.attempt.execution()).recovery!;
  await context.ctx.storage.put("platform:recovery", {
    ...recovery,
    nextTime: Date.now() - 1
  });
  checks.after = await context.attempt.sessionControls();

  return context.checks;
}
export async function probePlatformRecovery(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, computer, checks } = context;

  await context.ctx.storage.put("remote:platform-unknown", {
    state: "unknown",
    name: "nmap_port_scan",
    fingerprint: "held"
  });
  await context.attempt.onAlarmMemoryLimit({
    sealed: true,
    purgedRecoveryLoopJobs: []
  });
  const before = await context.attempt.execution();
  checks.before = before;
  try {
    await context.attempt.rearmPlatformRecovery(
      before.recovery!.observedAt - 1
    );
    checks.staleRejected = false;
  } catch (error) {
    checks.staleRejected = String(error).includes("409:");
  }
  try {
    await context.attempt.rearmPlatformRecovery(before.recovery!.observedAt);
    checks.unknownRejected = false;
  } catch (error) {
    checks.unknownRejected = String(error).includes("409:");
  }
  try {
    await context.attempt.sessionControls();
    checks.controlsFenced = false;
  } catch (error) {
    checks.controlsFenced = String(error).includes("409:");
  }
  await context.attempt.lifecycle.start();
  await context.attempt.lifecycle.alarm();
  checks.lifecycleStartupSkipped = !(await context.ctx.storage.get("startup"));
  try {
    await computer("computer_exec", { command: "printf unsafe" });
    checks.callFenced = false;
  } catch {
    checks.callFenced = true;
  }
  if (kind === "platform-recovery-held") return checks;
  await context.ctx.storage.put("remote:platform-unknown", {
    state: "reconciled",
    name: "nmap_port_scan",
    fingerprint: "held"
  });
  checks.rearmed = await context.attempt.rearmPlatformRecovery(
    before.recovery!.observedAt
  );
  checks.after = await context.attempt.execution();

  return context.checks;
}
export async function probeSdkManagedSpecialist(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, checks } = context;

  await context.ctx.storage.put("fixture:inspectProviderTools", true);
  await context.attempt.lifecycle.start();
  const native = await context.attempt.harness.opencode();
  const sessionID = context.attempt.harness.session().id;
  const created = await native.sessions.create({ id: sessionID });
  const location = { directory: created.location.directory };
  // agent.list awaits native plugin activation; agent.get does not in 2.2.5.
  await native.agent.list({ location });
  checks.profile = (
    await native.agent.get({ agentID: `pentcloud-${input.role}`, location })
  ).data;
  checks.skills = (await native.skill.list({ location })).data;
  await native.experimental.session.skill({
    sessionID,
    id: "pentcloud-tools",
    resume: false
  });
  checks.skillLoaded = JSON.stringify(
    await context.attempt.harness.session().history()
  ).includes("PentCloud");
  const receipt = await context.attempt.harness.submit(
    "Inspect actual native skill tool; stop before model HTTP",
    { operationId: "skill-tool-proof" }
  );
  checks.answer = await context.attempt.harness.wait(receipt.operationId, {
    session: receipt.session
  });
  checks.providerTools = await context.ctx.storage.get("fixture:providerTools");
  await context.attempt.harness.dispose();
  await context.ctx.storage.deleteAlarm();

  return context.checks;
}
export async function probeSdkManagedSession(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { checks } = context;

  await context.attempt.lifecycle.start();
  const native = await context.attempt.harness.opencode();
  const sessionID = context.attempt.harness.session().id;
  // No prompt, inference, scanner or provider request is needed to exercise
  // native form storage, permissions and the embedded usage APIs.
  await native.sessions.create({
    id: sessionID,
    permissions: [{ action: "operator-probe", resource: "*", effect: "ask" }]
  });
  await native.sessions.update({
    sessionID,
    permissions: [{ action: "operator-probe", resource: "*", effect: "ask" }]
  });
  const form = await native.sessions.form.create({
    sessionID,
    title: "Native operator question",
    fields: [{ key: "continue", type: "boolean", required: true }]
  });
  checks.pending = await context.attempt.sessionControls();
  try {
    await context.attempt.replyNative("form", form.id, {
      session: "ses_other",
      answer: { continue: true }
    });
    checks.wrongSessionRejected = false;
  } catch (error) {
    checks.wrongSessionRejected = String(error).includes("409:");
  }
  try {
    await context.attempt.replyNative("form", form.id, {
      session: sessionID,
      answer: { continue: "not boolean" }
    });
    checks.invalidAnswerRejected = false;
  } catch (error) {
    checks.invalidAnswerRejected = String(error).includes("400:");
  }
  await context.attempt.replyNative("form", form.id, {
    session: sessionID,
    answer: { continue: true }
  });
  checks.answered = await native.sessions.form.get({
    sessionID,
    formID: form.id
  });
  try {
    await context.attempt.replyNative("form", form.id, {
      session: sessionID,
      answer: { continue: false }
    });
    checks.duplicateRejected = false;
  } catch (error) {
    checks.duplicateRejected = String(error).includes("409:");
  }
  const cancelled = await native.sessions.form.create({
    sessionID,
    title: "Cancel native question",
    fields: [{ key: "text", type: "string" }]
  });
  await context.attempt.replyNative(
    "form",
    cancelled.id,
    { session: sessionID, message: "Operator declined" },
    true
  );
  checks.cancelled = await native.sessions.form.get({
    sessionID,
    formID: cancelled.id
  });
  const permission = native.permission.create({
    sessionID,
    id: "per_managed_probe",
    action: "operator-probe",
    resources: ["exact-resource"]
  });
  let pendingPermission = false;
  for (let i = 0; i < 100; i++) {
    if (
      (await native.permission.list({ sessionID })).some(
        (request) => request.id === "per_managed_probe"
      )
    ) {
      pendingPermission = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!pendingPermission)
    throw new Error(
      `Native permission fixture did not become pending: ${JSON.stringify(await permission)}`
    );
  checks.permissionPending = await context.attempt.sessionControls();
  await context.attempt.replyNative("permission", "per_managed_probe", {
    session: sessionID,
    decision: "once"
  });
  checks.permission = await permission;
  try {
    await context.attempt.replyNative("permission", "per_managed_probe", {
      session: sessionID,
      decision: "once"
    });
    checks.permissionDuplicateRejected = false;
  } catch (error) {
    checks.permissionDuplicateRejected = String(error).includes("409:");
  }
  const fenced = await native.sessions.form.create({
    sessionID,
    title: "Cancellation fence",
    fields: [{ key: "text", type: "string" }]
  });
  await context.attempt.cancel();
  try {
    await context.attempt.replyNative("form", fenced.id, {
      session: sessionID,
      answer: { text: "late" }
    });
    checks.lateRejected = false;
  } catch (error) {
    checks.lateRejected = String(error).includes("409:");
  }
  checks.fenced = await native.sessions.form.get({
    sessionID,
    formID: fenced.id
  });
  checks.nativePermissionList = await native.permission.list({ sessionID });
  await context.attempt.harness.dispose();
  await context.ctx.storage.deleteAlarm();

  return context.checks;
}
export async function probeSdkRole(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, checks } = context;

  const launch = await renderLaunch(
    "primary",
    { task: "Local harmless startup probe" },
    specialistSources.primary,
    {
      promptFormat: "markdown",
      cwd: context.attempt.directory,
      now: new Date(0)
    }
  );
  const state =
    (await context.ctx.storage.get<Record<string, unknown>>("attempt"))!;
  await context.ctx.storage.put("attempt", {
    ...state,
    prompt: launch.prompt,
    promptDigest: launch.promptDigest
  });
  await context.ctx.storage.put(
    kind === "sdk-startup"
      ? "fixture:stopBeforeModel"
      : "fixture:inspectProviderTools",
    true
  );
  await context.attempt.lifecycle.start();
  const receipt = await context.attempt.harness.submit(
    "Stop before inference HTTP",
    {
      operationId: "local-startup-no-model"
    }
  );
  checks.answer = await context.attempt.harness.wait(receipt.operationId, {
    session: receipt.session
  });
  checks.startup = await context.ctx.storage.get("startup");
  checks.messages = (await context.attempt.harness.session().history()).length;
  if (kind === "sdk-startup") {
    checks.storedModelSecret = false;
    const tables = context.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf*' AND name NOT GLOB '__cf*'"
      )
      .toArray();
    for (const table of tables) {
      const rows = context.ctx.storage.sql
        .exec(
          'SELECT * FROM "' + table.name.replaceAll('"', '""') + '" LIMIT 1000'
        )
        .toArray();
      for (const row of rows)
        for (const value of Object.values(row)) {
          const text =
            value instanceof ArrayBuffer
              ? new TextDecoder().decode(value)
              : typeof value === "string"
                ? value
                : JSON.stringify(value);
          if (text?.includes("local-probe-go")) checks.storedModelSecret = true;
        }
    }
  }

  checks.providerTools =
    (await context.ctx.storage.get("fixture:providerTools")) ?? null;
  checks.toolboxReadies =
    (await context.ctx.storage.get("fixture:readies")) ?? 0;
  await context.attempt.cancel();
  checks.terminalEvents = (
    await context.attempt.events(new Request("https://probe.invalid/events"))
  ).text();
  checks.terminalEvents = await checks.terminalEvents;
  await context.attempt.harness.dispose();
  await context.ctx.storage.deleteAlarm();

  return context.checks;
}
