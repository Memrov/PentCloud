import {
  type NativeMessage,
  type SessionProjection
} from "./session-projection-types";
import {
  projectMessage,
  pendingMessages,
  contents,
  record,
  olderCursor,
  remember
} from "./session-projection-utils";

/** Native durable/ephemeral envelope: {id,created,type,data,durable?:{seq}}. */
export function projectSessionEvent(
  current: SessionProjection,
  value: unknown,
  cursor = ""
): SessionProjection {
  if (!record(value) || typeof value.type !== "string" || !record(value.data))
    throw new Error("invalid session event");
  const sequence =
    record(value.durable) && typeof value.durable.seq === "number"
      ? String(value.durable.seq)
      : typeof value.id === "string"
        ? ""
        : cursor;
  if (sequence && olderCursor(sequence, current.cursor)) return current;
  if (typeof value.id === "string" && current.seenEventIds.has(value.id))
    return current;
  const data = value.data;
  const type = value.type;
  let native = current.native;
  let pending = current.pending;
  let busy = current.busy;
  const messageID =
    typeof data.assistantMessageID === "string"
      ? data.assistantMessageID
      : undefined;
  const eventMessageID =
    typeof value.id === "string"
      ? value.id.replace(/^evt_/, "msg_")
      : `event:${sequence}`;
  const upsert = (message: NativeMessage) => {
    native = native.some((item) => item.id === message.id)
      ? native.map((item) => (item.id === message.id ? message : item))
      : [...native, message];
  };
  const updateAssistant = (
    update: (message: NativeMessage) => NativeMessage
  ) => {
    if (!messageID) return;
    const existing = native.find((item) => item.id === messageID) ?? {
      id: messageID,
      type: "assistant",
      content: []
    };
    upsert(update(existing));
  };
  if (
    type === "session.inbox.enqueued" &&
    typeof data.inboxID === "string" &&
    record(data.item)
  ) {
    pending = [
      ...pending.filter((item) => !record(item) || item.id !== data.inboxID),
      { ...data.item, id: data.inboxID }
    ];
  } else if (
    type === "session.inbox.delivered" &&
    typeof data.inboxID === "string"
  ) {
    const item = pending.find(
      (item) => record(item) && item.id === data.inboxID
    );
    if (
      record(item) &&
      record(item.payload) &&
      typeof item.payload.text === "string"
    )
      upsert({
        id: data.inboxID,
        type: item.type === "user" ? "user" : "synthetic",
        text: item.payload.text
      });
    pending = pending.filter(
      (item) => !record(item) || item.id !== data.inboxID
    );
  } else if (type === "session.inbox.cancelled") {
    pending = pending.filter(
      (item) => !record(item) || item.id !== data.inboxID
    );
  } else if (type === "session.execution.started") {
    busy = true;
  } else if (
    [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted"
    ].includes(type)
  ) {
    busy = false;
    upsert({
      id: eventMessageID,
      type: "idle",
      outcome: type.split(".").at(-1),
      ...(record(data.error) ? { error: data.error } : {})
    });
  } else if (type === "session.step.started") {
    busy = true;
    updateAssistant((message) => ({
      ...message,
      time: { created: data.started }
    }));
  } else if (type === "session.step.ended" || type === "session.step.failed") {
    updateAssistant((message) => ({
      ...message,
      time: {
        ...(record(message.time) ? message.time : {}),
        completed: value.created ?? 0
      },
      ...(record(data.error) ? { error: data.error } : {})
    }));
  } else if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(type)) {
    const kind = type.split(".")[1]!;
    const operation = type.split(".")[2]!;
    const partID = `${kind}:${String(data.ordinal)}`;
    updateAssistant((message) => {
      const content = contents(message);
      let index = content.findIndex((part) => part.uiPartID === partID);
      // A snapshot has no ordinal IDs, but native events reference the latest matching span.
      if (index < 0 && operation !== "started")
        index = content.findLastIndex((part) => part.type === kind);
      if (index < 0)
        return {
          ...message,
          content: [
            ...content,
            {
              type: kind,
              uiPartID: partID,
              text:
                operation === "ended"
                  ? data.text
                  : operation === "delta"
                    ? data.delta
                    : "",
              streaming: operation !== "ended"
            }
          ]
        };
      const previous = content[index]!;
      const text =
        operation === "ended"
          ? data.text
          : operation === "delta"
            ? `${typeof previous.text === "string" ? previous.text : ""}${typeof data.delta === "string" ? data.delta : ""}`
            : previous.text;
      return {
        ...message,
        content: content.map((part, i) =>
          i === index
            ? {
                ...part,
                uiPartID: partID,
                text,
                streaming: operation !== "ended"
              }
            : part
        )
      };
    });
  } else if (type.startsWith("session.tool.") && typeof data.id === "string") {
    updateAssistant((message) => {
      const content = contents(message);
      const index = content.findIndex(
        (part) => part.type === "tool" && part.id === data.id
      );
      const previous =
        index < 0
          ? {
              type: "tool",
              id: data.id,
              name: typeof data.name === "string" ? data.name : "Tool",
              state: { status: "streaming", input: "" }
            }
          : content[index]!;
      const state = record(previous.state)
        ? previous.state
        : { status: "streaming", input: "" };
      let next = previous;
      if (type === "session.tool.input.started")
        next = { ...previous, name: data.name };
      else if (type === "session.tool.input.delta")
        next = {
          ...previous,
          state: {
            ...state,
            input: `${typeof state.input === "string" ? state.input : ""}${typeof data.delta === "string" ? data.delta : ""}`
          }
        };
      else if (type === "session.tool.input.ended")
        next = { ...previous, state: { ...state, input: data.text } };
      else if (type === "session.tool.called")
        next = { ...previous, state: { status: "running", input: data.input } };
      else if (type === "session.tool.success")
        next = {
          ...previous,
          state: {
            status: "completed",
            input: state.input,
            content: data.content,
            metadata: data.metadata
          }
        };
      else if (type === "session.tool.failed")
        next = {
          ...previous,
          state: { status: "error", input: state.input, error: data.error }
        };
      return {
        ...message,
        content:
          index < 0
            ? [...content, next]
            : content.map((part, i) => (i === index ? next : part))
      };
    });
  } else if (
    type === "session.message.content.updated" &&
    typeof data.messageID === "string" &&
    Array.isArray(data.content)
  ) {
    native = native.map((message) =>
      message.id === data.messageID
        ? { ...message, content: data.content }
        : message
    );
  } else if (
    (type === "session.synthetic" || type === "session.instructions.updated") &&
    typeof data.text === "string"
  ) {
    upsert({ id: eventMessageID, type: "system", text: data.text });
  }
  const next = {
    ...current,
    native,
    pending,
    busy,
    messages: [...native.flatMap(projectMessage), ...pendingMessages(pending)]
  };
  // Ephemeral IDs also deduplicate live delivery, without advancing the durable reconnect cursor.
  if (typeof value.id === "string" && !sequence)
    next.seenEventIds = new Set([...current.seenEventIds, value.id]);
  return remember(next, sequence);
}
