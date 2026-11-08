import type { ProbeScenarioContext } from "./worker";
import { supportedOptionalTools } from "../../src/native/tool-policy";
import type { AttemptInput } from "../../src/native/types";
export async function probeNativePinnedModel(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input } = context;

  const result = await context.attempt.run(input);
  await context.attempt.harness.dispose();
  return {
    result,
    model: result.model,
    request:
      (await context.ctx.storage.get("fixture:pinnedModelRequest")) ?? null,
    modelRequests: (await context.ctx.storage.get("fixture:modelRequests")) ?? 0
  };
}
export async function probeNativeDiscovery(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, id, checks } = context;

  // Exercise production admission too: bypassing run() hid stripped execution metadata.
  checks.result = await context.attempt.run(input);
  checks.record = JSON.parse(
    await context.attempt.workspace.fs.readFile(
      context.attempt.directory + "/.pentagi/jobs/" + id + "/result.json",
      "utf8"
    )
  );
  checks.modelRequests =
    (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  checks.modelKeyConfigured = !!context.env.OPENCODE_GO_API_KEY;
  checks.scannerArguments = await context.ctx.storage.get(
    "fixture:whatwebArguments"
  );
  return checks;
}
export async function probePurgeFailure(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input } = context;

  const state =
    (await context.ctx.storage.get<Record<string, unknown>>("attempt"))!;
  await context.ctx.storage.put("attempt", { ...state, status: "settled" });
  await context.ctx.storage.put("cancelled", true);
  context.attempt.harness.dispose = async () => {
    throw new Error("LOCAL_PURGE_CLEANUP_INTERRUPTED");
  };
  return await context.attempt.purge(input.runId);
}
export async function probePurge(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, checks } = context;

  const native = context.attempt as unknown as {
    purge(runId: string): Promise<unknown>;
    inFlightTools: number;
    running: Promise<unknown> | undefined;
    publishing: Promise<unknown> | undefined;
  };
  const rejection = async (runId = input.runId) => {
    try {
      await native.purge(runId);
      return "allowed";
    } catch (error) {
      return String(error);
    }
  };
  checks.wrongRun = await rejection("another-run");
  checks.running = await rejection();
  const state =
    (await context.ctx.storage.get<Record<string, unknown>>("attempt"))!;
  await context.ctx.storage.put("attempt", { ...state, status: "publishing" });
  checks.persistedPublishing = await rejection();
  await context.ctx.storage.put("attempt", { ...state, status: "settled" });
  await context.ctx.storage.put("cancelled", true);
  await context.ctx.storage.put("remote:held", {
    state: "unknown",
    name: "nmap_port_scan",
    fingerprint: "held"
  });
  checks.unknown = await rejection();
  await context.ctx.storage.delete("remote:held");
  native.inFlightTools = 1;
  checks.inflight = await rejection();
  native.inFlightTools = 0;
  native.running = Promise.resolve();
  checks.localRunning = await rejection();
  native.running = undefined;
  native.publishing = Promise.resolve();
  checks.publishing = await rejection();
  native.publishing = undefined;
  await context.ctx.storage.put("mcpSession", { sessionId: "held" });
  checks.session = await rejection();
  await context.ctx.storage.delete("mcpSession");
  context.ctx.storage.sql.exec("CREATE TABLE purge_probe (payload TEXT)");
  context.ctx.storage.sql.exec(
    "INSERT INTO purge_probe VALUES ('private session history')"
  );
  await context.ctx.storage.put(
    "fixture:privateTranscript",
    "private session history"
  );
  await context.ctx.storage.setAlarm(Date.now() + 60000);
  checks.purged = await native.purge(input.runId);
  checks.keys = [...(await context.ctx.storage.list())];
  checks.tables = [
    ...context.ctx.storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
  ].map((row) => row.name);
  checks.alarm = await context.ctx.storage.getAlarm();
  checks.repeat = await native.purge(input.runId);
  checks.reused = await rejection("another-run");
  try {
    await context.attempt.run(input);
    checks.replay = "allowed";
  } catch (error) {
    checks.replay = String(error);
  }
  try {
    await context.attempt.sessionControls();
    checks.controls = "allowed";
  } catch (error) {
    checks.controls = String(error);
  }
  try {
    await context.attempt.events(new Request("https://local.invalid/events"));
    checks.events = "allowed";
  } catch (error) {
    checks.events = String(error);
  }
  checks.execution = await context.attempt.execution();
  checks.finalKeys = [...(await context.ctx.storage.list())];
  return checks;
}
export async function probeHeaderRedaction(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  const tools = await internal.cloudflareTools();
  checks.curl = await internal.callCloudflareTool(
    tools.find((t) => t.name === "computer_exec")!,
    {
      backend: "native-shell",
      command: "curl --silent https://example.com/"
    },
    "echo-curl",
    new AbortController().signal
  );
  checks.api = await internal.apiRequest(
    { path: "/", method: "GET" },
    "echo-api"
  );
  checks.retrieval = internal.safe(
    await (
      await context.attempt.targetFetch(new Request("https://example.com/"))
    ).text()
  );

  return context.checks;
}
export async function probeComputerCoder(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  const tools = await internal.cloudflareTools();
  const call = async (name: string, args: unknown) =>
    internal.callCloudflareTool(
      tools.find((t) => t.name === name)!,
      args,
      crypto.randomUUID(),
      new AbortController().signal
    );
  const path = `${context.attempt.directory}/native-computer.txt`;
  checks.write = await call("computer_write", {
    path,
    content: "native marker"
  });
  checks.read = await call("computer_read", { path });
  checks.edit = await call("computer_edit", {
    path,
    edits: [{ oldText: "native marker", newText: "edited marker" }]
  });
  checks.exec = await call("computer_exec", {
    backend: "native-shell",
    command: "cat native-computer.txt"
  });
  checks.delete = await call("computer_delete", { path });
  try {
    await context.attempt.workspace.fs.stat(path);
    checks.deleted = false;
  } catch {
    checks.deleted = true;
  }

  return context.checks;
}
export async function probeComputer(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { id, internal, checks } = context;

  const tools = await internal.cloudflareTools();
  const call = async (name: string, args: unknown) => {
    try {
      return (await internal.callCloudflareTool(
        tools.find((t) => t.name === name)!,
        args,
        crypto.randomUUID(),
        new AbortController().signal
      )) as { content: string };
    } catch (error) {
      return { content: JSON.stringify({ error: String(error) }) };
    }
  };
  checks.read = await call("computer_read", { path: "README.md" });
  await context.attempt.workspace.fs.symlink(
    `${context.attempt.directory}/README.md`,
    `${context.attempt.directory}/source-link`
  );
  checks.symlink = await call("computer_read", { path: "source-link" });
  checks.captured = await call("computer_write", {
    path: `.pentagi/evidence/${id}/captured/forbidden.txt`,
    content: "forbidden"
  });
  checks.retired = {};
  for (const [name, args] of Object.entries({
    file: {
      action: "write_file",
      path: "README.md",
      content: "changed",
      message: "recorded"
    },
    terminal: { input: "echo changed > README.md", message: "recorded" },
    workspace_javascript: { source: "export default()=>42" }
  })) {
    try {
      await internal.callTool(name, args, "recorded-legacy");
      (checks.retired as Record<string, unknown>)[name] = "executed";
    } catch (error) {
      (checks.retired as Record<string, unknown>)[name] = String(error);
    }
  }
  checks.write = await call("computer_write", {
    path: `.pentagi/evidence/${id}/computer.txt`,
    content: "computer native marker"
  });
  checks.exec = await call("computer_exec", {
    backend: "native-shell",
    command: `cat .pentagi/evidence/${id}/computer.txt`
  });
  checks.javascript = await call("computer_exec", {
    backend: "native-javascript",
    command: "export default async function() { return 42; }"
  });
  checks.source = await call("computer_write", {
    path: "README.md",
    content: "forbidden"
  });
  checks.escape = await call("computer_read", { path: "../outside" });
  checks.git = await call("computer_read", { path: ".git/config" });
  checks.cwdBlocked = (
    await call("computer_exec", {
      backend: "native-shell",
      command: "pwd",
      cwd: "/"
    })
  ).content.includes('"error"');
  checks.baseline = await context.attempt.workspace.fs.readFile(
    `${context.attempt.directory}/README.md`,
    "utf8"
  );
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = internal
    .callCloudflareTool(
      {
        ...tools[0]!,
        execute: async () => {
          entered();
          await blocked;
          return { content: "late browser response" };
        }
      },
      {},
      "native-drain",
      new AbortController().signal
    )
    .then(
      () => false,
      () => true
    );
  await started;
  await context.attempt.cancel();
  checks.drainedDuring = (await context.attempt.execution()).drained;
  release();
  checks.rejectedAfterCancel = await pending;
  checks.drainedAfter = (await context.attempt.execution()).drained;
  checks.lateBlocked = (
    await call("computer_read", { path: "README.md" })
  ).content.includes("cancelled");

  return context.checks;
}
export async function probeShell(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { id, internal, shell, checks, origin } = context;

  checks.read = await shell("cat README.md");
  checks.git = await shell("git status --short");
  checks.blockGit = await shell("cat .git/config");
  checks.blockSource = await shell("echo changed > README.md");
  checks.baseline = await context.attempt.workspace.fs.readFile(
    `${context.attempt.directory}/README.md`,
    "utf8"
  );
  checks.evidence = await shell(
    `mkdir -p .pentagi/evidence/${id}; echo native-shell > .pentagi/evidence/${id}/shell.txt; cat .pentagi/evidence/${id}/shell.txt`
  );
  checks.unsupported = await shell("nmap 127.0.0.1");
  checks.outputWindow = await shell("seq 1 2500");
  const tool = (await internal.cloudflareTools()).find(
    (tool) => tool.name === "computer_exec"
  )!;
  try {
    await internal.callCloudflareTool(
      tool,
      { backend: "native-shell", command: "sleep 30" },
      "shell-timeout",
      AbortSignal.timeout(25)
    );
    checks.timeout = false;
  } catch {
    checks.timeout = true;
  }
  checks.drainedAfterTimeout = (await context.attempt.execution()).drained;
  // Exercise the production backend: optional curl modules, real HTTP
  // egress, request options, and guarded Workspace output files.
  checks.curl = await shell(
    `curl --include --fail --silent --show-error --max-time 5 -X POST -H 'X-Curl-Fixture: native' --data 'curl fixture body' '${origin}/curl-fixture' > .pentagi/evidence/${id}/curl-response.txt; cat .pentagi/evidence/${id}/curl-response.txt`
  );
  checks.curlFile = await context.attempt.workspace.fs
    .readFile(
      `${context.attempt.directory}/.pentagi/evidence/${id}/curl-response.txt`,
      "utf8"
    )
    .catch(() => "");

  return context.checks;
}
export async function probeJavascript(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { exec, checks } = context;

  const javascript = (source: string) => exec(source, "native-javascript");
  checks.scratch = await javascript(
    'import fs from "node:fs/promises"; export default async function() { await fs.writeFile("hello.txt", "isolated scratch"); console.log(await fs.readFile("hello.txt", "utf8")); }'
  );
  checks.blockEscape = await javascript(
    'import fs from "node:fs/promises"; export default async function() { console.log(await fs.readFile("/workspace/repo/.git/config", "utf8")); }'
  );
  checks.memory = await javascript(
    'import {search_code} from "ws:tools"; export default async function() { const result = await search_code({questions:["accepted memory"],lang:"typescript",message:"Read accepted memory"}); if(result.isError || typeof result.text !== "string" || !result.details) throw Error("Missing native tool result"); return result.details; }'
  );
  checks.invalidArguments = await javascript(
    'import {search_code} from "ws:tools"; export default async function() { return search_code("invalid", {}); }'
  );
  checks.fileRead = await javascript(
    'import {file} from "ws:tools"; export default async function() { console.log(await file({action:"read_file",path:"README.md",message:"probe"})); }'
  );
  checks.fileWrite = await javascript(
    'import {file} from "ws:tools"; export default async function() { console.log(await file({action:"write_file",path:"README.md",content:"changed",message:"probe"})); }'
  );

  return context.checks;
}
export async function probePublish(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, id, base, internal, checks } = context;

  checks.terminal = await internal.publish({
    tool: "yield",
    arguments: { message: "local probe", plan: "done" },
    status: "waiting",
    finishedAt: Date.now()
  });
  checks.published = context.published;
  checks.main = await context.attempt.workspace.git.revParse({
    dir: context.attempt.directory,
    ref: "main"
  });
  checks.base = base.oid;
  checks.head = await context.attempt.workspace.git.revParse({
    dir: context.attempt.directory,
    ref: "HEAD"
  });
  checks.result = JSON.parse(
    await context.attempt.workspace.fs.readFile(
      `${context.attempt.directory}/.pentagi/jobs/${id}/result.json`,
      "utf8"
    )
  );
  if (kind === "replay") {
    const state =
      await context.ctx.storage.get<Record<string, unknown>>("attempt");
    if (!state) throw new Error("Fixture state missing");
    const proposal = state.proposal;
    Object.assign(context.env.CF_VERSION_METADATA, { id: "probe-redeployed" });
    delete state.result;
    delete state.outputCommit;
    state.status = "publishing";
    await context.ctx.storage.put("attempt", state);
    checks.replayed = await internal.publish(proposal as object);
    checks.replayedHead = await context.attempt.workspace.git.revParse({
      dir: context.attempt.directory,
      ref: "HEAD"
    });
  }

  return context.checks;
}
export async function probeMemoryContract(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  let call = 0;
  const role = async (
    name: AttemptInput["role"],
    scope: Record<string, unknown> = {}
  ) => {
    const state = (await context.ctx.storage.get<{ input: AttemptInput }>(
      "attempt"
    ))!;
    await context.ctx.storage.put("attempt", {
      ...state,
      input: {
        ...state.input,
        role: name,
        context: { enabledTools: supportedOptionalTools(name), ...scope }
      }
    });
  };
  const invoke = (name: string, args: object) =>
    internal.callTool(
      name,
      { ...args, message: "Memory contract regression" },
      `memory-${++call}`
    );
  const code = (lang: string, marker: string) => ({
    code: marker,
    question: marker,
    lang,
    explanation: "Memory contract",
    description: "Memory contract"
  });
  await role("coder");
  const fresh = await invoke(
    "store_code",
    code("python", "same-attempt-needle")
  );
  checks.sameAttempt = await invoke("search_code", {
    questions: ["same-attempt-needle"],
    lang: "python"
  });
  checks.wrongLanguage = await invoke("search_code", {
    questions: ["same-attempt-needle"],
    lang: "javascript"
  });
  // Populate different original document kinds with the same literal query.
  await invoke("store_code", code("javascript", "shared-kind-needle"));
  await role("maintenance");
  const install = await invoke("store_guide", {
    guide: "shared-kind-needle",
    question: "install question",
    type: "install"
  });
  await invoke("store_guide", {
    guide: "shared-kind-needle",
    question: "configure question",
    type: "configure"
  });
  checks.guides = await invoke("search_guide", {
    questions: ["shared-kind-needle"],
    type: "install"
  });
  await role("searcher");
  const answer = await invoke("store_answer", {
    answer: "shared-kind-needle",
    question: "answer question",
    type: "vulnerability"
  });
  checks.answers = await invoke("search_answer", {
    questions: ["shared-kind-needle"],
    type: "vulnerability"
  });
  checks.wrongAnswerType = await invoke("search_answer", {
    questions: ["shared-kind-needle"],
    type: "tool"
  });
  await role("coder", { task_id: 41, subtask_id: 7 });
  const scoped = await invoke("store_code", code("python", "scoped-needle"));
  await role("coder", { task_id: 41, subtask_id: 8 });
  await invoke("store_code", code("python", "scoped-needle"));
  await role("coder", { task_id: 42, subtask_id: 7 });
  await invoke("store_code", code("python", "scoped-needle"));
  await role("coder");
  const argumentState = (await context.ctx.storage.get<{
    input: AttemptInput;
  }>("attempt"))!;
  await context.ctx.storage.put("attempt", {
    ...argumentState,
    input: { ...argumentState.input, args: { task_id: 43, subtask_id: 9 } }
  });
  const argumentScoped = await invoke(
    "store_code",
    code("python", "argument-scope-needle")
  );
  await role("memorist");
  checks.scoped = await invoke("search_in_memory", {
    questions: ["scoped-needle"],
    task_id: 41,
    subtask_id: 7
  });
  checks.argumentScoped = await invoke("search_in_memory", {
    questions: ["argument-scope-needle"],
    task_id: 43,
    subtask_id: 9
  });
  checks.mappedButNoMatch = await invoke("search_in_memory", {
    questions: ["absent-needle"],
    task_id: 41
  });
  try {
    await invoke("search_in_memory", {
      questions: ["scoped-needle"],
      task_id: 999
    });
  } catch (error) {
    checks.unmapped = String(error);
  }
  try {
    await invoke("search_in_memory", {
      questions: ["scoped-needle"],
      task_id: 41,
      subtask_id: 999
    });
  } catch (error) {
    checks.unmappedSubtask = String(error);
  }
  // Legacy accepted Markdown must remain searchable with its original metadata headings.
  const legacy = ".pentagi/memory/code/legacy.md";
  await context.attempt.workspace.fs.writeFile(
    `${context.attempt.directory}/${legacy}`,
    "---\nkind: code\ntool: store_code\njob_id: old\ndigest: legacy\n---\n\n## code\n\nlegacy-needle\n\n## lang\n\npython\n\n## question\n\nOld accepted code\n"
  );
  await context.attempt.workspace.git.add({
    dir: context.attempt.directory,
    paths: [legacy]
  });
  await role("coder");
  checks.legacy = await invoke("search_code", {
    questions: ["legacy-needle"],
    lang: "python"
  });
  checks.paths = { fresh, install, answer, scoped, argumentScoped };
  checks.noModel =
    (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  checks.noScanner = (await context.ctx.storage.get("fixture:toolCalls")) ?? 0;

  return context.checks;
}
export async function probeMemory(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, internal, checks } = context;

  checks.stored = await internal.callTool(
    "store_code",
    {
      code: "native-memory-marker",
      question: "native-memory-marker",
      lang: "text",
      explanation: "Durable memory regression",
      description: "Native memory",
      message: "Store evidence"
    },
    "store-code"
  );
  const terminal = (await internal.publish({
    tool: "code_result",
    arguments: { result: "Stored native-memory-marker", message: "Done" },
    status: "completed",
    finishedAt: Date.now()
  })) as { outputCommit: string };
  checks.acceptedHead = terminal.outputCommit;
  checks.committedFiles = await context.attempt.workspace.git.lsFiles({
    dir: context.attempt.directory,
    ref: terminal.outputCommit
  });
  const next = {
    ...input,
    id: "next-memory-attempt",
    role: "memorist" as const,
    inputCommit: terminal.outputCommit,
    context: { enabledTools: supportedOptionalTools("memorist") }
  };
  await context.ctx.storage.put("attempt", {
    input: next,
    fingerprint: "next-memory",
    prompt: "Probe",
    promptDigest: "c".repeat(64),
    status: "running",
    prepared: true,
    startedAt: Date.now()
  });
  checks.found = await internal.callTool(
    "search_in_memory",
    {
      questions: ["native-memory-marker"],
      message: "Find accepted memory"
    },
    "search-memory"
  );

  return context.checks;
}
export async function probeResearchPolicy(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, internal, checks } = context;

  let scopeRejected = false;
  let mutationRejected = false;
  try {
    await internal.callTool(
      "browser",
      {
        url: "https://outside.example.invalid/",
        action: "html",
        message: "Scope regression"
      },
      "browser-outside"
    );
  } catch {
    scopeRejected = true;
  }
  try {
    await (
      context.attempt as unknown as {
        executeRemoteTool(
          name: string,
          args: object,
          id: string
        ): Promise<unknown>;
      }
    ).executeRemoteTool(
      "nmap_port_scan",
      { target: "127.0.0.1" },
      "research-mutation"
    );
  } catch {
    mutationRejected = true;
  }
  checks.scopeRejected = scopeRejected;
  checks.mutationRejected = mutationRejected;
  checks.enabledTools = input.context.enabledTools;

  return context.checks;
}
