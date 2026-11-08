import type { ProbeScenarioContext } from "./worker";
import type { SessionControls } from "../../src/native/managed-session";
import { supportedOptionalTools } from "../../src/native/tool-policy";
import { digest } from "../../src/native/domain";
import type { AttemptInput } from "../../src/native/types";
export async function probePreparation(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, input } = context;

  input.role = "primary";
  input.context.enabledTools = supportedOptionalTools("primary");
  await context.ctx.storage.put("fixture:inspectProviderTools", true);
  await context.ctx.storage.put("fixture:readyBlocked", true);
  const backup = context.attempt.directory + "-remote";
  await context.attempt.workspace.fs.rename(context.attempt.directory, backup);
  context.attempt.workspace.git.clone = async (options) => {
    if (
      options.headers?.Authorization !==
      "Basic " + btoa("x:local-probe-token-read")
    )
      throw new Error("Clone requires read-only source access");
    if (
      (await context.ctx.storage.get<{ preparation?: true }>("attempt"))
        ?.preparation !== true &&
      (await context.ctx.storage.get("fixture:promotionFailure")) === "clone" &&
      !(await context.ctx.storage.get("fixture:promotionFailed"))
    ) {
      await context.ctx.storage.put("fixture:promotionFailed", true);
      throw new Error("Injected one-shot promotion clone failure");
    }
    await context.attempt.workspace.fs.rename(backup, options.dir!);
    return undefined as never;
  };
  await context.attempt.prepareConversation(input);
  await context.attempt.prepareConversation(input);
  let form: SessionControls["forms"][number] | undefined;
  if (kind === "preparation-chat") {
    for (let n = 0; n < 200 && !form; n++) {
      form = (await context.attempt.sessionControls()).forms[0];
      if (!form) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!form)
      throw new Error("Preparation question did not become answerable");
  } else await context.attempt.harness.wait("prepare-" + input.id);
  const before = {
    tools: await context.ctx.storage.get("fixture:providerTools"),
    users: (await context.attempt.harness.session().history()).filter(
      (message) => message.type === "user"
    ).length,
    session: context.attempt.harness.session().id,
    readies: (await context.ctx.storage.get("fixture:readies")) ?? 0
  };
  const internals = context.attempt as unknown as {
    cloudflareTools(): Promise<Array<{ name: string }>>;
    callCloudflareTool(
      tool: unknown,
      args: unknown,
      id: string,
      signal: AbortSignal
    ): Promise<unknown>;
    callTool(
      name: string,
      args: unknown,
      id: string,
      signal: AbortSignal
    ): Promise<unknown>;
  };
  const tools = await internals.cloudflareTools();
  const read = await internals.callCloudflareTool(
    tools.find((tool) => tool.name === "computer_read"),
    { path: "README.md" },
    "prepare-read",
    new AbortController().signal
  );
  let writeDenied = false,
    resultDenied = false;
  try {
    await internals.callCloudflareTool(
      tools.find((tool) => tool.name === "computer_write"),
      { path: "README.md", content: "changed" },
      "prepare-write",
      new AbortController().signal
    );
  } catch {
    writeDenied = true;
  }
  try {
    await internals.callTool(
      "done",
      {},
      "prepare-result",
      new AbortController().signal
    );
  } catch {
    resultDenied = true;
  }
  if (kind === "preparation-stop") {
    await context.attempt.cancel();
    let steerDenied = false;
    try {
      await context.attempt.steer("late");
    } catch {
      steerDenied = true;
    }
    return {
      before,
      writeDenied,
      resultDenied,
      steerDenied,
      readiness: await context.attempt.purgeReadiness(input.runId)
    };
  }
  await context.attempt.workspace.fs.writeFile(
    context.attempt.directory + "/discovery.txt",
    "validated discovery"
  );
  await context.attempt.workspace.git.add({
    dir: context.attempt.directory,
    paths: ["discovery.txt"]
  });
  const advanced = await context.attempt.workspace.git.commit({
    dir: context.attempt.directory,
    message: "discovery accepted"
  });
  await context.attempt.workspace.fs.rm(
    context.attempt.directory + "/.git/refs/heads/attempts/local-attempt"
  );
  await context.attempt.workspace.fs.rename(context.attempt.directory, backup);
  await context.ctx.storage.put("fixture:liveContext", {
    discovery_result: "validated discovery"
  });
  const admission = {
    ...input,
    inputCommit: advanced.oid,
    context: { ...input.context, discovery_result: "validated discovery" }
  };
  if (
    (await context.ctx.storage.get("fixture:promotionFailure")) === "reload"
  ) {
    const actor = context.attempt as unknown as {
        reloadConversation: () => Promise<void>;
      },
      reload = actor.reloadConversation;
    actor.reloadConversation = async () => {
      if (!(await context.ctx.storage.get("fixture:promotionFailed"))) {
        await context.ctx.storage.put("fixture:promotionFailed", true);
        throw new Error("Injected one-shot promotion reload failure");
      }
      await reload();
    };
  }
  const promoted = context.attempt.run(admission).then(
    (result) => ({ result }),
    (error) => ({ error: String(error) })
  );
  for (
    let n = 0;
    n < 200 &&
    !(context.attempt as unknown as { admittingConversation?: Promise<void> })
      .admittingConversation;
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  await context.attempt.replyNative("form", form!.id, {
    session: context.attempt.harness.session().id,
    answer: { q0: "Focused" }
  });
  const first = await promoted;
  const pendingAfterFailure = !!(
    await context.ctx.storage.get<{ promotionPending?: true }>("attempt")
  )?.promotionPending;
  const result =
    "result" in first ? first.result : await context.attempt.run(admission);
  let changedReplayDenied = false;
  try {
    await context.attempt.run({ ...input, inputCommit: "f".repeat(40) });
  } catch {
    changedReplayDenied = true;
  }
  const history = await context.attempt.harness.session().history();
  const after = {
    tools: await context.ctx.storage.get("fixture:providerTools"),
    session: context.attempt.harness.session().id,
    source: (await context.ctx.storage.get<{ input: AttemptInput }>("attempt"))
      ?.input.inputCommit,
    retained: !!(await context.ctx.storage.get("preparation:snapshot")),
    discoveryDelivered: JSON.stringify(history).includes("validated discovery"),
    users: history.filter((message) => message.type === "user").length
  };
  await context.attempt.harness.dispose();
  return {
    before,
    after,
    read,
    writeDenied,
    resultDenied,
    changedReplayDenied,
    pendingAfterFailure,
    firstFailure: "error" in first,
    formAnswered: JSON.stringify(history).includes("Focused"),
    result: result.status,
    expected: advanced.oid
  };
}

export async function probePromptCompatibility(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, internal } = context;

  const results = [];
  for (const format of [undefined, "pentagi-template"] as const) {
    if (format === undefined) delete input.settings.promptFormat;
    else input.settings.promptFormat = format;
    input.settings.promptTemplate = "Historical {{.Cwd}}";
    const saved = {
      input: structuredClone(input),
      fingerprint: await digest(input),
      prompt: "Previously rendered /workspace/original",
      promptDigest: "d".repeat(64),
      status: "running",
      prepared: true,
      startedAt: 1
    };
    await context.ctx.storage.put("attempt", saved);
    await internal.initialize(input);
    const replayed = await context.ctx.storage.get("attempt");
    await context.ctx.storage.delete("attempt");
    let error: string | undefined;
    try {
      await internal.initialize(input);
    } catch (failure) {
      error = String(failure);
    }
    results.push({
      saved,
      replayed,
      error,
      created: !!(await context.ctx.storage.get("attempt"))
    });
  }
  return {
    results,
    modelRequests: (await context.ctx.storage.get("fixture:modelRequests")) ?? 0
  };
}

export async function probePackageOnly(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, internal, exec } = context;

  const checks: Record<string, unknown> = {};
  delete context.env.TOOLBOX;
  let runs = 0,
    stops = 0;
  context.env.TOOL_PACKS = {
    ready: async () => ({}),
    run: async () => {
      runs++;
      return { exitCode: 0, stdout: "owned package result", stderr: "" };
    },
    stop: async () => {
      stops++;
      return { stopped: true };
    }
  };
  await context.ctx.storage.delete("attempt");
  await internal.initialize(input);
  const state =
    (await context.ctx.storage.get<Record<string, unknown>>("attempt"))!;
  await context.ctx.storage.put("attempt", { ...state, prepared: true });
  await internal.preflightToolbox(state);
  checks.prompt = state.prompt;
  checks.skill =
    (state.toolSkill as { content: string } | undefined)?.content ?? "";
  checks.tools = (await internal.cloudflareTools()).map((tool) => tool.name);
  const request = {
    pack: "http" as const,
    request: { tool: "curl", target: "https://owned.example/" }
  };
  checks.result = await internal.packCall(request, "once");
  await internal.packCall(request, "once");
  checks.shell = await exec("echo owned");
  await context.attempt.cancel();
  checks.execution = await context.attempt.execution();
  checks.runs = runs;
  checks.stops = stops;
  checks.readies = (await context.ctx.storage.get("fixture:readies")) ?? 0;
  checks.initializes =
    (await context.ctx.storage.get("fixture:initializes")) ?? 0;
  return checks;
}

export async function probeFindingContract(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, id, internal } = context;

  const emptyState =
    await context.ctx.storage.get<Record<string, unknown>>("attempt");
  await context.ctx.storage.put("attempt", {
    ...emptyState,
    status: "settled"
  });
  const emptyWork = JSON.parse(
    (await context.attempt.recordedWork(input.runId)).text
  );
  if (emptyWork.historyAvailable || emptyWork.messages.length)
    throw new Error("Missing history was replaced with a synthetic session");
  // Exercise the real input projection. Seeding storage directly hid the
  // dropped findingsVersion and skipped the agent's format instructions.
  await context.ctx.storage.delete("attempt");
  await internal.initialize(input);
  const reviewTool = (await internal.cloudflareTools()).find(
    (t) => t.name === "pentcloud_run_work"
  )!;
  let reviewText = "",
    reviewOffset = 0,
    reviewPages = 0;
  for (;;) {
    const response = (await internal.callCloudflareTool(
      reviewTool,
      { job_id: "source-job", offset: reviewOffset },
      "review-" + reviewPages,
      new AbortController().signal
    )) as { content: string };
    const page = JSON.parse(response.content).value;
    reviewText += page.text;
    reviewPages++;
    if (page.nextOffset === undefined) break;
    reviewOffset = page.nextOffset;
  }
  const review = JSON.parse(reviewText);
  if (
    !review.messages[0].text.startsWith("TOKEN=[redacted]\n") ||
    reviewText.includes("private-assignment") ||
    reviewPages < 2
  )
    throw new Error("Recorded-work delivery changed or exposed secret content");
  const proposal = {
    tool: "report_result",
    arguments: { report: "Reviewed existing evidence" },
    status: "completed",
    finishedAt: Date.now()
  };
  let missing: string | undefined;
  try {
    await internal.publish(proposal);
  } catch (error) {
    missing = String(error);
  }
  const after = await context.ctx.storage.get<{ proposal?: unknown }>(
    "attempt"
  );
  if (!missing?.includes("Required") || after?.proposal)
    throw new Error(
      `Missing index guard: ${missing}; proposal=${!!after?.proposal}`
    );
  const root = `.pentagi/evidence/${id}`;
  await context.attempt.workspace.fs.mkdir(
    `${context.attempt.directory}/${root}`,
    {
      recursive: true
    }
  );
  const doc = {
    version: 1,
    coverage: "partial",
    summary: "Owned fixture; incomplete coverage",
    reportPath: root + "/report.md",
    findings: []
  };
  await context.attempt.workspace.fs.writeFile(
    `${context.attempt.directory}/${root}/findings.json`,
    JSON.stringify(doc)
  );
  await context.attempt.workspace.fs.writeFile(
    `${context.attempt.directory}/${root}/report.md`,
    "# Owned partial assessment"
  );
  const result = (await internal.publish(
    proposal
  )) as import("../../src/native/types").AttemptResult;
  const committed = JSON.parse(
    await context.attempt.workspace.fs.readFile(
      `${context.attempt.directory}/.pentagi/jobs/${id}/result.json`,
      "utf8"
    )
  );
  return {
    missing,
    proposalAfterMissing: !!after?.proposal,
    outputCommit: result.outputCommit,
    version: committed.findings_version,
    modelRequests: (await context.ctx.storage.get("fixture:modelRequests")) ?? 0
  };
}
