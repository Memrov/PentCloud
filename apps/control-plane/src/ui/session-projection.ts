import { parseJob, type UIJob } from "./api";
import { type ChatMessage, type ChatPart } from "./presentation";
import { canonical } from "../native/domain";
import { type SessionProjection } from "./session-projection-types";
import {
  projectMessage,
  pendingMessages,
  normalizedMessage,
  contents,
  terminalReceipt,
  errorText,
  isNativeMessage,
  record,
  remember
} from "./session-projection-utils";
export type { SessionProjection } from "./session-projection-types";
export { projectSessionEvent } from "./session-event-reducer";
export { projectLiveSessionEvent } from "./session-live-event";

export function emptySessionProjection(): SessionProjection {
  return {
    messages: [],
    busy: false,
    pending: [],
    seenEventIds: new Set(),
    native: []
  };
}

/** A readable view of the exact Coordinator-accepted terminal payload, never generated prose. */
export function acceptedOutcome(
  projection: SessionProjection,
  job: Pick<UIJob, "id" | "status" | "outputCommit">
): string | undefined {
  const receipt = projection.result;
  if (
    !receipt ||
    receipt.id !== job.id ||
    receipt.status !== job.status ||
    receipt.outputCommit !== job.outputCommit
  )
    return;
  const text = receipt.arguments.message ?? receipt.arguments.result;
  return typeof text === "string" && text.trim() ? text : undefined;
}

/** Hide the SDK's deliberate post-commit inference fence only after accepted job state arrives. */
export function sessionMessagesForJob(
  projection: SessionProjection,
  job: Pick<UIJob, "status" | "outputCommit"> & Partial<Pick<UIJob, "id">>
): ChatMessage[] {
  if (
    !["completed", "waiting"].includes(job.status) ||
    !/^[a-f0-9]{40}$/.test(job.outputCommit ?? "")
  )
    return projection.messages;
  // A local candidate is insufficient: Coordinator must have accepted this exact
  // attempt/commit/status before the browser reconciles its interrupted reply.
  const receipt =
    projection.result?.id === job.id &&
    projection.result?.outputCommit === job.outputCommit &&
    projection.result?.status === job.status
      ? projection.result
      : undefined;
  const matches = receipt
    ? projection.native.flatMap((message) =>
        contents(message)
          .filter(
            (part) =>
              part.type === "tool" &&
              part.name === receipt.tool &&
              record(part.state) &&
              part.state.status === "error" &&
              record(part.state.input) &&
              canonical(part.state.input) === canonical(receipt.arguments)
          )
          .map((part) => ({ messageID: message.id, callID: part.id }))
      )
    : [];
  const recovered = matches.length === 1 ? matches[0] : undefined;
  const isFence = (error: string | undefined) =>
    error === "Attempt has settled" ||
    (!!receipt && error === "Terminal publication has started");
  const fenced = new Set(
    projection.native
      .filter(
        (message) =>
          (message.type === "assistant" ||
            (message.type === "idle" && message.outcome === "failed")) &&
          isFence(errorText(message.error))
      )
      .map((message) => message.id)
  );
  if (!fenced.size && !recovered) return projection.messages;
  let changed = false;
  const messages = projection.messages.flatMap((message) => {
    const parts = message.parts.flatMap((part): ChatPart[] => {
      if (
        fenced.has(message.id) &&
        part.type === "data-status" &&
        part.data.status === "failed" &&
        isFence(part.data.error)
      ) {
        changed = true;
        return [];
      }
      if (
        receipt &&
        recovered?.messageID === message.id &&
        part.type === "dynamic-tool" &&
        part.toolCallId === recovered.callID
      ) {
        changed = true;
        const { errorText: _error, ...retained } = part;
        return [
          {
            ...retained,
            state: "output-available",
            recovered: true,
            output: {
              status: receipt.status,
              outputCommit: receipt.outputCommit,
              arguments: receipt.arguments
            }
          }
        ];
      }
      return [part];
    });
    return parts.length ? [{ ...message, parts }] : [];
  });
  return changed ? messages : projection.messages;
}

/** OpenCode 2.2 history uses {id,type,content}, independently of UI presentation messages. */
export function projectSessionSnapshot(
  current: SessionProjection,
  value: unknown,
  cursor = ""
): SessionProjection {
  if (!record(value) || !Array.isArray(value.messages))
    throw new Error("invalid session snapshot");
  const pendingSpans = Array.isArray(value.pendingSpans)
    ? value.pendingSpans.filter((key): key is string => typeof key === "string")
    : [];
  const native = value.messages.filter(isNativeMessage).map((message) => {
    if (message.type !== "assistant") return message;
    const ordinals = { text: 0, reasoning: 0 };
    const old = current.native.find((previous) => previous.id === message.id);
    return {
      ...message,
      content: contents(message).map((part) => {
        if (part.type !== "text" && part.type !== "reasoning") return part;
        const kind = part.type,
          ordinal = ordinals[kind]++;
        const previous = old
          ? contents(old).filter((candidate) => candidate.type === kind)[
              ordinal
            ]
          : undefined;
        const text =
          part.text === "" &&
          pendingSpans.includes(`${message.id}:${kind}:${ordinal}`) &&
          typeof previous?.text === "string"
            ? previous.text
            : part.text;
        return { ...part, text, streaming: false };
      })
    };
  });
  const pending = Array.isArray(value.pending) ? value.pending : [];
  const normalized = value.messages.flatMap(
    (message) => normalizedMessage(message) ?? []
  );
  const snapshotCursor =
    typeof value.cursor === "string" || typeof value.cursor === "number"
      ? String(value.cursor)
      : cursor;
  const { result: _oldResult, ...base } = current;
  const result = terminalReceipt(value.result);
  return remember(
    {
      ...base,
      native,
      pending,
      pendingSpans,
      messages: [
        ...native.flatMap(projectMessage),
        ...normalized,
        ...pendingMessages(pending)
      ],
      busy: value.busy === true,
      ...(result ? { result } : {}),
      ...(value.job ? { job: parseJob(value.job) } : {})
    },
    snapshotCursor
  );
}
