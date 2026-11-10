import type { ProbeScenarioContext } from "./worker";
import { evidenceBytesHash } from "../../src/native/evidence";
import { GuardedWorkspace } from "../../src/native/tools";
import type {
  OpenCodeOperationResult,
  OpenCodeReceipt,
  OpenCodeSession,
  OpenCodeSessionEvent
} from "agents/harness/opencode";
export async function probeEvidenceFinalization(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { id, internal, computer, exec, checks } = context;

  const operations: string[] = [];
  let listener: (events: readonly OpenCodeSessionEvent[]) => void = () => {};
  let streamsOpened = 0,
    streamsStopped = 0;
  const wait = async (operation: string): Promise<OpenCodeOperationResult> => {
    if (operation.startsWith("finalize-")) {
      try {
        await computer("computer_exec", { command: "echo forbidden" });
      } catch {
        checks.mutationFenced = true;
      }
      const tools = await internal.cloudflareTools(),
        tool = tools.find((t) => t.name === "pentcloud_kali_import")!;
      try {
        await internal.callCloudflareTool(
          tool,
          { path: "README.md" },
          "forbidden-file",
          new AbortController().signal
        );
      } catch {
        checks.fileMutationFenced = true;
      }
      try {
        await exec(
          "export default function(){return 'forbidden'}",
          "native-javascript"
        );
      } catch {
        checks.javascriptFenced = true;
      }
      await internal.callTool(
        "code_result",
        { result: "Existing work finalized", message: "done" },
        "final-result"
      );
    }
    return {
      operationId: operation,
      session: "ses_root",
      status: "done",
      text: ""
    };
  };
  // Match the native session surface used by both admission and finalization.
  const session = {
    setModel: async () => {},
    events: async () => {
      streamsOpened++;
      return {
        start: (next: typeof listener) => {
          listener = next;
        },
        stop: async () => {
          streamsStopped++;
        }
      };
    },
    wait
  } as unknown as OpenCodeSession;
  const harness = context.attempt.harness as unknown as {
    session: () => OpenCodeSession;
    submit: (
      text: string,
      options: { operationId: string }
    ) => Promise<OpenCodeReceipt>;
  };
  harness.session = () => session;
  harness.submit = async (_text, options) => {
    const operationId = options.operationId;
    operations.push(operationId);
    listener([
      {
        type: "operation_end",
        result: {
          operationId,
          session: "ses_root",
          status: "done",
          text: ""
        }
      }
    ]);
    return { operationId, session: "ses_root", accepted: true };
  };
  checks.result = await (
    context.attempt as unknown as { execute(): Promise<unknown> }
  ).execute();
  checks.streamsOpened = streamsOpened;
  checks.streamsStopped = streamsStopped;
  checks.operations = operations;
  checks.initialId = id;
  checks.starts = (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  return checks;
}
export async function probeEvidenceGatewayCompat(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  (
    context.env.TOOLBOX as unknown as { putFile: () => Promise<never> }
  ).putFile = async () => {
    throw new Error("RPC receiver does not implement method putFile");
  };
  const tool = (await internal.cloudflareTools()).find(
    (t) => t.name === "pentcloud_kali_import"
  )!;
  try {
    await tool.execute(
      { path: "README.md" },
      "compat-proof",
      new AbortController().signal
    );
  } catch (error) {
    checks.pending =
      error instanceof Error && error.name === "ToolboxPendingError";
  }
  checks.starts = (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  return checks;
}
export async function probeEvidenceCancelCommit(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { kind, id, base, internal, checks } = context;

  const commit = context.attempt.workspace.git.commit.bind(
      context.attempt.workspace.git
    ),
    push = context.attempt.workspace.git.push.bind(
      context.attempt.workspace.git
    );
  let pushes = 0,
    cancelled = false;
  context.attempt.workspace.git.commit = async (options) => {
    const value = await commit(options);
    if (kind === "evidence-cancel-commit" && !cancelled) {
      cancelled = true;
      await context.attempt.cancel();
    }
    return value;
  };
  context.attempt.workspace.git.push = async (options) => {
    pushes++;
    if (kind === "evidence-failed-push" && pushes === 1)
      throw new Error("Injected failed push");
    return push(options);
  };
  await internal.captureToolEvidence("fixture-command", {}, "call-one", {
    status: "completed",
    output: "retained existing bytes"
  });
  if (kind === "evidence-failed-push") {
    const state =
      (await context.ctx.storage.get<Record<string, unknown>>("attempt"))!;
    await context.ctx.storage.put("attempt", {
      ...state,
      status: "settled",
      result: {
        id,
        runId: "local-run",
        status: "failed",
        error: "Model stopped",
        inputCommit: base.oid
      }
    });
  }
  const execution = await context.attempt.execution();
  checks.execution = execution;
  checks.pushes = pushes;
  checks.registrations = await context.ctx.storage.get(
    "fixture:evidenceReceipts"
  );
  checks.starts = (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  return checks;
}
export async function probeEvidenceCancelPush(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, computer, checks } = context;

  let pushes = 0;
  const push = context.attempt.workspace.git.push.bind(
    context.attempt.workspace.git
  );
  context.attempt.workspace.git.push = async (options) => {
    pushes++;
    const result = await push(options);
    await context.attempt.cancel();
    return result;
  };
  await internal.captureToolEvidence("fixture-command", {}, "call-one", {
    status: "completed",
    output: "pushed before cancellation"
  });
  const execution = await context.attempt.execution();
  checks.evidence = execution.evidence;
  await internal.checkpointEvidence();
  try {
    await computer("computer_exec", { command: "echo forbidden" });
  } catch {
    checks.cancelFenced = true;
  }
  checks.pushes = pushes;
  checks.registrations =
    (await context.ctx.storage.get("fixture:evidenceReceipts")) ?? [];
  return checks;
}
export async function probeEvidenceTransfer(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { input, id, internal, checks } = context;

  const bytes = new TextEncoder().encode("config = ß\n\u0000binary-boundary");
  await context.attempt.workspace.fs.writeFile(
    `${context.attempt.directory}/input.bin`,
    bytes
  );
  const tools = await internal.cloudflareTools(),
    tool = (name: string) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error("missing native transfer tool " + name);
      return found;
    };
  const imported = await tool("pentcloud_kali_import").execute(
    { path: "input.bin" },
    "import-proof",
    new AbortController().signal
  );
  checks.imported = imported;
  const parsed = JSON.parse(imported.content);
  const value = (parsed.value ?? parsed) as { path: string };
  const exported = await tool("pentcloud_kali_export").execute(
    { path: value.path },
    "export-proof",
    new AbortController().signal
  );
  const parsedFile = JSON.parse(exported.content);
  const file = (parsedFile.value ?? parsedFile) as {
    path: string;
    sha256: string;
  };
  checks.file = file;
  checks.expectedHash = await evidenceBytesHash(bytes);
  checks.actualHash = await evidenceBytesHash(
    new Uint8Array(
      await new Response(
        await context.attempt.workspace.fs.readFile(
          `${context.attempt.directory}/${file.path}`
        )
      ).arrayBuffer()
    )
  );
  const guarded = new GuardedWorkspace(context.attempt.workspace, {
    role: input.role,
    id,
    root: context.attempt.directory,
    active: async () => {}
  });
  try {
    await guarded.fs.rename(
      `${context.attempt.directory}/.pentagi/evidence/${id}`,
      `${context.attempt.directory}/moved-evidence`
    );
  } catch {
    checks.renameFenced = true;
  }
  checks.checkpoint = await context.ctx.storage.get("fixture:evidenceReceipts");
  checks.starts = (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  return checks;
}
export async function probeEvidencePackScratch(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  const bytes = new Uint8Array([0, 128, 192, 255, 10]),
    state =
      (await context.ctx.storage.get<Record<string, unknown>>("attempt"))!;
  await context.ctx.storage.put("attempt", { ...state, toolPacks: true });
  await context.attempt.workspace.fs.mkdir("/workspace/scratch", {
    recursive: true
  });
  await context.attempt.workspace.fs.writeFile(
    "/workspace/scratch/fixture.bin",
    bytes
  );
  let calls = 0;
  context.env.TOOL_PACKS = {
    ready: async () => ({}),
    stop: async () => ({ stopped: true }),
    run: async (_scope, _input, files) => {
      calls++;
      checks.checkpointBeforeDispatch =
        (
          (await context.ctx.storage.get<unknown[]>(
            "fixture:evidenceReceipts"
          )) ?? []
        ).length > 0;
      checks.inputHash = await evidenceBytesHash(files.input!);
      return { exitCode: 0, stdout: "exact binary input", stderr: "" };
    }
  };
  const request = {
    pack: "pcap" as const,
    request: { tool: "tshark" },
    files: { input: "/workspace/scratch/fixture.bin" }
  };
  await internal.packCall(request, "scratch");
  await context.attempt.workspace.fs.rm("/workspace/scratch/fixture.bin");
  await internal.packCall(request, "scratch");
  checks.calls = calls;
  checks.expectedHash = await evidenceBytesHash(bytes);
  const files =
    await context.ctx.storage.get<
      Array<{ path: string; source: string; sha256: string }>
    >("evidenceFiles");
  checks.captured = files!.find((f) => f.source === "tool-input");
  try {
    await internal.packCall(
      { ...request, files: { input: "/workspace/scratch/../private" } },
      "escape"
    );
  } catch {
    checks.escapeDenied = true;
  }
  await context.attempt.workspace.fs.symlink(
    "/private",
    "/workspace/scratch/link"
  );
  try {
    await internal.packCall(
      { ...request, files: { input: "/workspace/scratch/link" } },
      "symlink"
    );
  } catch {
    checks.symlinkDenied = true;
  }
  return checks;
}
export async function probeEvidencePackLarge(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  const output = "🧪".repeat(600000),
    record = {
      stdout: output,
      stderr: "retained complete stderr",
      exitCode: 0
    };
  await internal.captureToolEvidence(
    "pentcloud_tool",
    {},
    "large-result",
    record
  );
  const files =
    await context.ctx.storage.get<Array<{ path: string; size: number }>>(
      "evidenceFiles"
    );
  const index = files!.find((f) => f.path.endsWith("-result.json"))!;
  const manifest = JSON.parse(
    await context.attempt.workspace.fs.readFile(
      context.attempt.directory + "/" + index.path,
      "utf8"
    )
  );
  const chunks: Uint8Array[] = [];
  for (const path of manifest.parts)
    chunks.push(
      new Uint8Array(
        await new Response(
          await context.attempt.workspace.fs.readFile(
            context.attempt.directory + "/" + path
          )
        ).arrayBuffer()
      )
    );
  const bytes = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of chunks) {
    bytes.set(b, offset);
    offset += b.length;
  }
  const restored = JSON.parse(new TextDecoder().decode(bytes));
  checks.restored =
    restored.result.stdout === output &&
    restored.result.stderr === record.stderr;
  checks.files = files;
  checks.parts = manifest.parts;
  checks.checkpoint = await context.ctx.storage.get("fixture:evidenceReceipts");
  return checks;
}
export async function probeEvidenceReadPages(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, computer, checks, id } = context;
  await internal.captureToolEvidence("pentcloud_tool", {}, "paged-result", {
    stdout: "🧪\\\u0000".repeat(20000),
    exitCode: 0
  });
  const files =
    (await context.ctx.storage.get<Array<{ path: string }>>("evidenceFiles"))!;
  const path = files.find((file) => file.path.endsWith("-result.json"))!.path;
  const expected = await context.attempt.workspace.fs.readFile(
    `${context.attempt.directory}/${path}`,
    "utf8"
  );
  const state =
    await context.ctx.storage.get<Record<string, unknown>>("attempt");
  if (context.kind === "evidence-read-preparation")
    await context.ctx.storage.put("attempt", { ...state, preparation: true });
  const fileRead = await computer("computer_read", { path })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("read cap"))
        throw error;
      return { content: error.message };
    })
    .finally(async () => {
      if (context.kind === "evidence-read-preparation")
        await context.ctx.storage.put("attempt", state!);
    });
  checks.fileReadBounded =
    new TextEncoder().encode(fileRead.content).byteLength < 32768;
  // Exercise the actual model-visible continuation, including during preparation.
  const fileParts: string[] = [];
  let fileOffset: number | undefined = 0;
  if (context.kind === "evidence-read-preparation")
    await context.ctx.storage.put("attempt", { ...state, preparation: true });
  try {
    while (fileOffset !== undefined && fileParts.length < 1000) {
      const output = await computer("computer_read_bytes", {
        path,
        offset: fileOffset
      });
      const page = JSON.parse(output.content).value as {
        text: string;
        nextOffset?: number;
      };
      fileParts.push(page.text);
      fileOffset = page.nextOffset;
    }
  } finally {
    await context.ctx.storage.put("attempt", state!);
  }
  checks.fileReadRestored = fileParts.join("") === expected;
  if (context.kind === "evidence-read-pending") {
    const push = context.attempt.workspace.git.push.bind(
      context.attempt.workspace.git
    );
    let fail = true;
    context.attempt.workspace.git.push = async (options) => {
      if (fail) {
        fail = false;
        throw new Error("Lost oversized-output push");
      }
      return push(options);
    };
  }
  const command = await computer("computer_exec", {
    backend: "native-shell",
    command: "printf 'start'; printf '%100000s' x; printf 'end'"
  });
  checks.commandBounded =
    new TextEncoder().encode(command.content).byteLength < 32768;
  checks.commandEvidence = command.content.includes("pentcloud_read_evidence");
  checks.checkpointRecovered = !(await context.ctx.storage.get(
    "evidenceCollectionPending"
  ));
  const retained =
    (await context.ctx.storage.get<Array<{ path: string }>>("evidenceFiles"))!;
  const commandFiles = retained.filter(
    (file) => !files.some((before) => before.path === file.path)
  );
  const commandRecords = await Promise.all(
    commandFiles.map(async (file) => ({
      path: file.path,
      text: await context.attempt.workspace.fs.readFile(
        `${context.attempt.directory}/${file.path}`,
        "utf8"
      )
    }))
  );
  const fullCommand = commandRecords.find(
    (record) =>
      JSON.parse(record.text).result?.stdout ===
      "start" + " ".repeat(99999) + "xend"
  );
  checks.commandRestored =
    !!fullCommand &&
    commandRecords.some(
      (record) =>
        record.path !== fullCommand.path &&
        record.text.includes(fullCommand.path)
    );
  const multilineTool = (await internal.cloudflareTools()).find(
    (tool) => tool.name === "computer_grep"
  )!;
  multilineTool.execute = async () => ({ content: "line\n".repeat(2500) });
  const multiline = (await internal.callCloudflareTool(
    multilineTool,
    {},
    "multiline-output",
    new AbortController().signal
  )) as { content: string };
  checks.multilineRetained = multiline.content.includes(
    "pentcloud_read_evidence"
  );
  const parts: string[] = [];
  let offset: number | undefined = 0;
  checks.bounded = true;
  while (offset !== undefined && parts.length < 1000) {
    const output = await computer("pentcloud_read_evidence", {
      job_id: id,
      path,
      offset
    });
    if (new TextEncoder().encode(output.content).byteLength > 32768)
      checks.bounded = false;
    const page = JSON.parse(output.content).value as {
      text: string;
      nextOffset?: number;
      totalBytes?: number;
    };
    parts.push(page.text);
    offset = page.nextOffset;
    checks.totalBytes = page.totalBytes;
  }
  checks.pages = parts.length;
  checks.restored = parts.join("") === expected;
  checks.expectedBytes = new TextEncoder().encode(expected).byteLength;
  return checks;
}
export async function probeEvidenceCheckpoints(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  const commits: string[] = [],
    push = context.attempt.workspace.git.push.bind(
      context.attempt.workspace.git
    );
  let lose = true;
  context.attempt.workspace.git.push = async (options) => {
    const result = await push(options);
    commits.push(
      await context.attempt.workspace.git.revParse({
        dir: context.attempt.directory,
        ref: "HEAD"
      })
    );
    if (lose) {
      lose = false;
      throw new Error("Injected lost push reply");
    }
    return result;
  };
  await internal.captureToolEvidence("fixture-command", {}, "call-one", {
    status: "completed",
    output: "retained evidence",
    private: context.env.OPENCODE_GO_API_KEY
  });
  const first = await context.attempt.workspace.git.revParse({
    dir: context.attempt.directory,
    ref: "HEAD"
  });
  checks.before =
    (await context.ctx.storage.get<{ result?: unknown }>("attempt"))?.result ??
    null;
  const recovered = await internal.checkpointEvidence();
  checks.unavailable =
    JSON.parse(
      await context.attempt.workspace.fs.readFile(
        `${context.attempt.directory}/${recovered!.manifestPath}`,
        "utf8"
      )
    ).unavailable ?? [];
  checks.sameCommitRetried = commits[0] === commits[1] && commits[0] === first;
  checks.recovered = recovered;
  const evidenceFiles =
    await context.ctx.storage.get<Array<{ path: string; sha256: string }>>(
      "evidenceFiles"
    );
  checks.evidenceFiles = evidenceFiles;
  checks.raw = await context.attempt.workspace.fs.readFile(
    context.attempt.directory + "/" + evidenceFiles![0]!.path,
    "utf8"
  );
  await context.attempt.workspace.fs.writeFile(
    `${context.attempt.directory}/output.txt`,
    "ordinary source output"
  );
  checks.terminal = await internal.publish({
    tool: "code_result",
    arguments: { result: "Finished existing work", message: "done" },
    status: "completed",
    finishedAt: Date.now()
  });
  const head = await context.attempt.workspace.git.revParse({
      dir: context.attempt.directory,
      ref: "HEAD"
    }),
    commit = await context.attempt.workspace.git.show({
      dir: context.attempt.directory,
      ref: head
    });
  checks.terminalParent = commit.parent[0];
  checks.registrations = await context.ctx.storage.get(
    "fixture:evidenceReceipts"
  );
  await context.attempt.cancel();
  const before = commits.length;
  await internal.captureToolEvidence("late-tool", {}, "late-call", {
    late: true
  });
  checks.noLatePublication = commits.length === before;
  checks.starts = (await context.ctx.storage.get("fixture:modelRequests")) ?? 0;
  return checks;
}
export async function probeEvidenceIncompleteImage(
  context: ProbeScenarioContext
): Promise<Record<string, unknown>> {
  const { internal, checks } = context;

  await internal.captureToolEvidence("fixture-image", {}, "incomplete", {
    content: [{ type: "image", mimeType: "image/png", data: "invalid base64!" }]
  });
  const recovered = await internal.checkpointEvidence();
  checks.unavailable =
    JSON.parse(
      await context.attempt.workspace.fs.readFile(
        `${context.attempt.directory}/${recovered!.manifestPath}`,
        "utf8"
      )
    ).unavailable ?? [];
  return checks;
}
