import type { UIJob, UIRun } from "../ui/api";
import type { ChatMessage, ChatPart } from "../ui/presentation";

type RecordValue = Record<string, unknown>;
type HistoryRepository = Pick<
  ArtifactsRepo,
  "readCommit" | "readTree" | "readFile" | typeof Symbol.dispose
>;
type HistoryEnvironment = {
  ARTIFACTS: { get(name: string): Promise<HistoryRepository> };
  LEGACY_STATE_COMMIT?: string;
  CONTROL_TOKEN?: string;
  OPENCODE_GO_API_KEY?: string;
};
const repositoryName = "pentagi-control-state";
const commitPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const terminalStatuses = new Set([
  "waiting",
  "completed",
  "failed",
  "invalid_result",
  "integration_failed",
  "interrupted",
]);
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new Error("400: Invalid historical identifier");
  return value;
};
const integer = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;

/** Immutable, read-only history. It has no reference to the native coordinator or attempts. */
export class LegacyHistory {
  private readonly commit: string | undefined;
  private readonly secrets: string[];
  constructor(private readonly env: HistoryEnvironment) {
    this.commit = env.LEGACY_STATE_COMMIT;
    if (this.commit !== undefined && !commitPattern.test(this.commit))
      throw new Error("503: Invalid historical snapshot configuration");
    this.secrets = [env.CONTROL_TOKEN, env.OPENCODE_GO_API_KEY].filter(
      (value): value is string => !!value,
    );
  }

  async listRuns(): Promise<{ runs: UIRun[] }> {
    if (!this.commit) return { runs: [] };
    using repository = await this.open();
    const runs = await this.readDirectory(repository, "runs");
    const jobs = (await this.readDirectory(repository, "jobs")).map((value) =>
      this.job(value),
    );
    return {
      runs: runs
        .map((value) =>
          this.run(
            value,
            jobs.filter((job) => job.runId === value.id),
          ),
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async getRun(id: string): Promise<{ run: UIRun; jobs: UIJob[] }> {
    identifier(id);
    using repository = await this.open();
    const stored = await this.read(repository, "runs", id);
    if (!stored) throw new Error("404: Historical run not found");
    const jobs = (await this.readDirectory(repository, "jobs"))
      .filter((value) => value.run_id === id)
      .map((value) => this.job(value));
    return {
      run: this.run(stored, jobs),
      jobs: jobs.sort(
        (a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.id.localeCompare(b.id),
      ),
    };
  }

  async events(jobId: string): Promise<Response> {
    identifier(jobId);
    using repository = await this.open();
    const stored = await this.read(repository, "jobs", jobId);
    if (!stored) throw new Error("404: Historical job not found");
    const job = this.job(stored);
    if (!(await this.read(repository, "runs", job.runId)))
      throw new Error("503: Historical job has no run provenance");
    const archive = await this.read(repository, "transcripts", jobId);
    let messages: ChatMessage[];
    if (archive) {
      if (
        archive.version !== 1 ||
        !Array.isArray(archive.messages) ||
        archive.messages.length > 500
      )
        throw new Error("503: Invalid historical transcript");
      messages = archive.messages.map((value) => this.message(value));
    } else {
      messages = [
        {
          id: `history:${jobId}:unavailable`,
          role: "system",
          parts: [
            {
              type: "data-status",
              data: {
                status: "archive_unavailable",
                error: "Historical transcript was not archived.",
              },
            },
          ],
        },
      ];
    }
    const snapshot = { messages, busy: false, pending: [], cursor: 0, job };
    return new Response(
      `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: end\ndata: {}\n\n`,
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Legacy-State-Commit": this.commit!,
        },
      },
    );
  }

  private async open(): Promise<HistoryRepository> {
    if (!this.commit)
      throw new Error("404: Historical snapshot is unavailable");
    const repository = await this.env.ARTIFACTS.get(repositoryName);
    try {
      const commit = await repository.readCommit(this.commit);
      if (
        !commit ||
        commit.hash !== this.commit ||
        !commitPattern.test(commit.treeHash)
      )
        throw new Error("503: Historical snapshot is unavailable");
      return repository;
    } catch (error) {
      repository[Symbol.dispose]();
      throw error;
    }
  }

  private async readDirectory(
    repository: HistoryRepository,
    directory: "runs" | "jobs",
  ): Promise<RecordValue[]> {
    const commit = await repository.readCommit(this.commit!);
    if (!commit || commit.hash !== this.commit)
      throw new Error("503: Historical snapshot changed");
    const root = await repository.readTree(commit.treeHash);
    if (!root) throw new Error("503: Historical root tree is unavailable");
    const tree = root.find(
      (entry) => entry.name === directory && entry.type === "tree",
    );
    if (!tree) return [];
    const entries = await repository.readTree(tree.hash);
    if (!entries || entries.length > 10000)
      throw new Error("503: Invalid historical tree");
    const records: RecordValue[] = [];
    for (const entry of entries) {
      if (
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        !entry.name.endsWith(".json")
      )
        throw new Error("503: Invalid historical record path");
      const id = identifier(entry.name.slice(0, -5));
      const value = await this.read(repository, directory, id);
      if (!value) throw new Error("503: Historical tree record is missing");
      records.push(value);
    }
    return records;
  }

  private async read(
    repository: HistoryRepository,
    directory: "runs" | "jobs" | "transcripts",
    id: string,
  ): Promise<RecordValue | null> {
    identifier(id);
    const file = await repository.readFile({
      ref: this.commit!,
      path: `${directory}/${id}.json`,
    });
    if (!file) return null;
    if (file.size > 3 * 1024 * 1024)
      throw new Error("503: Historical record exceeds its limit");
    let wrapper: unknown;
    try {
      wrapper = JSON.parse(await file.text());
    } catch {
      throw new Error("503: Invalid historical record");
    }
    if (
      !record(wrapper) ||
      typeof wrapper.revision !== "number" ||
      !Number.isSafeInteger(wrapper.revision) ||
      wrapper.revision < 0 ||
      !record(wrapper.value) ||
      wrapper.value[directory === "transcripts" ? "jobId" : "id"] !== id
    )
      throw new Error("503: Historical record identity mismatch");
    return wrapper.value;
  }

  private run(value: RecordValue, jobs: UIJob[]): UIRun {
    const id = identifier(value.id);
    if (
      typeof value.baseline_repo !== "string" ||
      !idPattern.test(value.baseline_repo) ||
      typeof value.input_commit !== "string" ||
      !commitPattern.test(value.input_commit)
    )
      throw new Error("503: Invalid historical run provenance");
    const status =
      record(value.orchestration) && terminalStatuses.has(String(value.status))
        ? this.status(value.status)
        : jobs.some((job) =>
              ["failed", "invalid_result", "integration_failed"].includes(
                job.status,
              ),
            )
          ? "failed"
          : jobs.some((job) => job.status === "interrupted")
            ? "interrupted"
            : jobs.length > 0 && jobs.every((job) => job.status === "completed")
              ? "completed"
              : jobs.some((job) => job.status === "waiting")
                ? "waiting"
                : this.status(value.status);
    return {
      id,
      status,
      baselineRepo: value.baseline_repo,
      inputCommit: value.input_commit,
      maxDepth: integer(value.max_depth),
      maxJobs: integer(value.max_jobs),
      ...(typeof value.settings_revision === "string"
        ? { settingsRevision: this.text(value.settings_revision) }
        : {}),
    };
  }

  private status(status: unknown): UIJob["status"] {
    if (typeof status !== "string" || !terminalStatuses.has(status)) {
      // A historical run can have stale orchestration status despite all jobs having terminated.
      if (["created", "provisioning", "running"].includes(String(status)))
        return "interrupted";
      throw new Error("503: Invalid historical terminal status");
    }
    return status as UIJob["status"];
  }

  private job(value: RecordValue): UIJob {
    if (!terminalStatuses.has(String(value.status)))
      throw new Error(
        "503: Active jobs cannot be served as historical snapshots",
      );
    const job: UIJob = {
      id: identifier(value.id),
      runId: identifier(value.run_id),
      status: this.status(value.status),
      revision: integer(value.revision),
    };
    for (const [source, target] of [
      ["parent_job_id", "parentJobId"],
      ["logical_thread_id", "logicalThreadId"],
      ["revision_of", "revisionOf"],
    ] as const)
      if (value[source] !== undefined) job[target] = identifier(value[source]);
    for (const [source, target] of [
      ["role", "role"],
      ["tool", "tool"],
      ["model", "model"],
      ["settings_revision", "settingsRevision"],
      ["reasoning_effort", "reasoningEffort"],
      ["failure_class", "failureClass"],
    ] as const)
      if (typeof value[source] === "string")
        job[target] = this.text(value[source]);
    for (const [source, target] of [
      ["input_commit", "inputCommit"],
      ["output_commit", "outputCommit"],
    ] as const) {
      if (value[source] !== undefined) {
        if (
          typeof value[source] !== "string" ||
          !commitPattern.test(value[source])
        )
          throw new Error("503: Invalid historical commit provenance");
        job[target] = value[source];
      }
    }
    if (value.depth !== undefined) job.depth = integer(value.depth);
    if (value.attempt !== undefined) job.attempt = integer(value.attempt);
    if (
      ["complete", "compacted", "failed"].includes(
        String(value.transcript_archive_status),
      )
    )
      job.archiveStatus = value.transcript_archive_status as NonNullable<
        UIJob["archiveStatus"]
      >;
    if (["settings", "operator"].includes(String(value.configuration_source)))
      job.configurationSource = value.configuration_source as NonNullable<
        UIJob["configurationSource"]
      >;
    if (record(value.arguments)) {
      const task = [
        value.arguments.task,
        value.arguments.question,
        value.arguments.message,
      ].find((text) => typeof text === "string");
      if (typeof task === "string") job.task = this.text(task);
    }
    return job;
  }

  private text(value: string): string {
    let result = value;
    for (const secret of this.secrets)
      result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
      .replace(/\b(?:sk-|dop_v1_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
      .replace(
        /((?:api[_-]?key|(?:access[_-]?)?token|secret|password|authorization)["']?\s*[=:]\s*["']?)[^\s,"';}\]]+/gi,
        "$1[REDACTED]",
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .slice(0, 256 * 1024);
  }

  private safe(value: unknown, depth = 0): unknown {
    if (depth > 16) return "[truncated]";
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value))
      return value.slice(0, 1000).map((entry) => this.safe(entry, depth + 1));
    if (record(value))
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 1000)
          .map(([key, entry]) => [
            this.text(key),
            /(?:secret|password|token|authorization|cookie|credential|api[_-]?key)/i.test(
              key,
            )
              ? "[REDACTED]"
              : this.safe(entry, depth + 1),
          ]),
      );
    return value;
  }

  private message(value: unknown): ChatMessage {
    if (
      !record(value) ||
      typeof value.id !== "string" ||
      !["user", "assistant", "system"].includes(String(value.role)) ||
      !Array.isArray(value.parts)
    )
      throw new Error("503: Invalid historical message");
    const parts: ChatPart[] = value.parts.map((part) => {
      if (!record(part))
        throw new Error("503: Invalid historical message part");
      if (
        (part.type === "text" || part.type === "reasoning") &&
        typeof part.text === "string"
      )
        return { type: part.type, text: this.text(part.text), state: "done" };
      if (
        part.type === "dynamic-tool" &&
        typeof part.toolCallId === "string" &&
        typeof part.toolName === "string" &&
        ["input-available", "output-available", "output-error"].includes(
          String(part.state),
        )
      )
        return {
          type: "dynamic-tool",
          toolCallId: this.text(part.toolCallId),
          toolName: this.text(part.toolName),
          state: part.state as
            | "input-available"
            | "output-available"
            | "output-error",
          input: this.safe(part.input),
          ...(part.output !== undefined
            ? { output: this.safe(part.output) }
            : {}),
          ...(typeof part.errorText === "string"
            ? { errorText: this.text(part.errorText) }
            : {}),
        };
      if (
        part.type === "data-status" &&
        record(part.data) &&
        typeof part.data.status === "string"
      )
        return {
          type: "data-status",
          data: {
            status: this.text(part.data.status),
            ...(typeof part.data.error === "string"
              ? { error: this.text(part.data.error) }
              : {}),
          },
        };
      throw new Error("503: Invalid historical message part");
    });
    return {
      id: this.text(value.id),
      role: value.role as ChatMessage["role"],
      parts,
    };
  }
}
