import {
  type RecordValue,
  type SessionProjection
} from "./session-projection-types";
import {
  projectMessage,
  pendingMessages,
  contents,
  isNativeMessage,
  record
} from "./session-projection-utils";
import { projectSessionEvent } from "./session-event-reducer";

/** OpenCodeHarness live events use native message/call IDs; reconnect starts with a new snapshot. */
export function projectLiveSessionEvent(
  current: SessionProjection,
  value: unknown
): SessionProjection {
  if (!record(value) || typeof value.type !== "string")
    throw new Error("invalid live session event");
  const eventType = value.type;
  let type: string | undefined,
    data: RecordValue = {};
  const messageId = value.messageId;
  if (typeof messageId === "string") data.assistantMessageID = messageId;
  const existing =
    typeof messageId === "string"
      ? current.native.find((message) => message.id === messageId)
      : undefined;
  // The SDK may repeat events already represented in its reconnect snapshot.
  if (
    existing &&
    record(existing.time) &&
    existing.time.completed !== undefined &&
    ["message_start", "text_delta", "reasoning_delta", "tool_start"].includes(
      eventType
    )
  )
    return current;
  if (
    existing &&
    (eventType === "text_delta" || eventType === "reasoning_delta")
  ) {
    const kind = eventType.split("_")[0];
    const part = contents(existing).filter((part) => part.type === kind)[
      value.ordinal as number
    ];
    if (
      current.pendingSpans?.includes(`${messageId}:${kind}:${value.ordinal}`) ||
      part?.streaming === false ||
      (part && record(part.time) && part.time.completed !== undefined)
    )
      return current;
  }
  if (
    typeof messageId === "string" &&
    /^(text|reasoning)_(delta|end)$/.test(eventType) &&
    Number.isSafeInteger(value.ordinal)
  ) {
    const kind = eventType.split("_")[0]!,
      partID = `${kind}:${value.ordinal}`;
    const message = current.native.find((m) => m.id === messageId),
      parts = message ? contents(message) : [];
    if (!parts.some((part) => part.uiPartID === partID)) {
      const snapshotPart = parts.filter((part) => part.type === kind)[
        value.ordinal as number
      ];
      if (snapshotPart && snapshotPart.uiPartID === undefined) {
        current = {
          ...current,
          native: current.native.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  content: parts.map((part) =>
                    part === snapshotPart ? { ...part, uiPartID: partID } : part
                  )
                }
              : m
          )
        };
      } else
        current = projectSessionEvent(current, {
          type: `session.${kind}.started`,
          data: { assistantMessageID: messageId, ordinal: value.ordinal }
        });
    }
  }
  switch (eventType) {
    case "run_start":
      type = "session.execution.started";
      break;
    case "run_end":
      type = `session.execution.${value.outcome}`;
      if (typeof value.error === "string")
        data.error = { message: value.error };
      break;
    case "message_start":
      type = "session.step.started";
      data.started = 0;
      break;
    case "message_end":
      type = value.error ? "session.step.failed" : "session.step.ended";
      if (typeof value.error === "string")
        data.error = { message: value.error };
      break;
    case "text_delta":
    case "reasoning_delta":
    case "text_end":
    case "reasoning_end": {
      const [kind, operation] = eventType.split("_");
      const replacement =
        operation === "delta" && typeof value.text === "string";
      type = `session.${kind}.${operation === "end" || replacement ? "ended" : "delta"}`;
      data = {
        ...data,
        ordinal: value.ordinal,
        ...(operation === "end" || replacement
          ? { text: value.text }
          : { delta: value.delta })
      };
      break;
    }
    case "tool_start":
      type = "session.tool.called";
      data = {
        ...data,
        id: value.toolCallId,
        name: value.name,
        input: value.input
      };
      break;
    case "tool_end":
      type = value.error ? "session.tool.failed" : "session.tool.success";
      data = {
        ...data,
        id: value.toolCallId,
        name: value.name,
        ...(value.error
          ? { error: { message: value.output } }
          : { content: [{ type: "text", text: value.output }] })
      };
      break;
    case "operation_withdrawn":
      type = "session.inbox.cancelled";
      data.inboxID = `msg_${value.operationId}`;
      break;
    case "operation_start":
      type = "session.inbox.delivered";
      data.inboxID = `msg_${value.operationId}`;
      break;
    case "fault":
      type = "session.execution.failed";
      data.error = { message: value.message };
      break;
  }
  let next = type ? projectSessionEvent(current, { type, data }) : current;
  if (eventType === "text_end" || eventType === "reasoning_end")
    next = {
      ...next,
      pendingSpans:
        next.pendingSpans?.filter(
          (key) =>
            key !== `${messageId}:${eventType.split("_")[0]}:${value.ordinal}`
        ) ?? []
    };
  if (eventType === "message_end")
    next = {
      ...next,
      pendingSpans:
        next.pendingSpans?.filter((key) => !key.startsWith(messageId + ":")) ??
        []
    };
  if (eventType === "run_end" || eventType === "fault")
    next = { ...next, pendingSpans: [] };
  if (
    (eventType === "text_delta" || eventType === "reasoning_delta") &&
    typeof value.text === "string"
  ) {
    const partID = `${eventType.split("_")[0]}:${value.ordinal}`;
    next = {
      ...next,
      native: next.native.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: contents(message).map((part) =>
                part.uiPartID === partID ? { ...part, streaming: true } : part
              )
            }
          : message
      )
    };
  }
  if (Array.isArray(value.inbox)) next = { ...next, pending: value.inbox };
  if (isNativeMessage(value.nativeMessage)) {
    const message = value.nativeMessage;
    const native = next.native.some((m) => m.id === message.id)
      ? next.native.map((m) => (m.id === message.id ? message : m))
      : [...next.native, message];
    next = { ...next, native };
  }
  if (
    typeof messageId === "string" &&
    record(value.nativeTool) &&
    value.nativeTool.type === "tool"
  ) {
    const tool = value.nativeTool;
    next = {
      ...next,
      native: next.native.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: contents(message).map((part) =>
                part.type === "tool" && part.id === tool.id ? tool : part
              )
            }
          : message
      )
    };
  }
  return {
    ...next,
    messages: [
      ...next.native.flatMap(projectMessage),
      ...pendingMessages(next.pending)
    ]
  };
}
