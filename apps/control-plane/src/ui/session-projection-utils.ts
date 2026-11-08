import { type ChatMessage, type ChatPart } from "./presentation";
import {
  type RecordValue,
  type NativeMessage,
  type TerminalReceipt,
  type SessionProjection
} from "./session-projection-types";

export function projectMessage(message: NativeMessage): ChatMessage[] {
  if (
    ["user", "system", "synthetic", "skill"].includes(message.type) &&
    typeof message.text === "string"
  )
    return [
      {
        id: message.id,
        role: message.type === "user" ? "user" : "system",
        parts: [
          {
            id: `${message.id}:text`,
            type: "text",
            text: message.text,
            state: "done"
          }
        ]
      }
    ];
  if (message.type === "idle") {
    if (message.outcome === "succeeded") return [];
    return [
      {
        id: message.id,
        role: "assistant",
        parts: [
          {
            type: "data-status",
            data: {
              status: String(message.outcome),
              ...(errorText(message.error)
                ? { error: errorText(message.error)! }
                : {})
            }
          }
        ]
      }
    ];
  }
  if (message.type !== "assistant") return [];
  const complete = record(message.time) && message.time.completed !== undefined;
  const parts = contents(message).flatMap((part, index): ChatPart[] => {
    const id =
      typeof part.uiPartID === "string"
        ? part.uiPartID
        : `${message.id}:${index}`;
    if (
      (part.type === "text" || part.type === "reasoning") &&
      typeof part.text === "string"
    )
      return [
        {
          id,
          type: part.type,
          text: part.text,
          state:
            complete ||
            part.streaming === false ||
            (record(part.time) && part.time.completed !== undefined)
              ? "done"
              : "streaming"
        }
      ];
    if (
      part.type === "tool" &&
      typeof part.id === "string" &&
      typeof part.name === "string" &&
      record(part.state)
    ) {
      const state = part.state;
      return [
        {
          id: part.id,
          type: "dynamic-tool",
          toolCallId: part.id,
          toolName: part.name,
          state:
            state.status === "completed"
              ? "output-available"
              : state.status === "error"
                ? "output-error"
                : "input-available",
          input: state.input,
          ...(state.status === "completed"
            ? {
                output: toolOutput(state.content),
                images: toolImages(state.metadata)
              }
            : {}),
          ...(state.status === "error"
            ? { errorText: errorText(state.error) ?? "Tool failed" }
            : {})
        }
      ];
    }
    return [];
  });
  if (errorText(message.error))
    parts.push({
      type: "data-status",
      data: { status: "failed", error: errorText(message.error)! }
    });
  return [{ id: message.id, role: "assistant", parts }];
}

export function pendingMessages(pending: unknown[]): ChatMessage[] {
  return pending.flatMap((item) =>
    record(item) &&
    typeof item.id === "string" &&
    record(item.payload) &&
    typeof item.payload.text === "string"
      ? [
          {
            id: item.id,
            role: "user",
            parts: [
              { type: "text", text: item.payload.text, state: "done" },
              { type: "data-status", data: { status: "Queued" } }
            ]
          }
        ]
      : []
  );
}

export function normalizedMessage(value: unknown): ChatMessage[] | undefined {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !["user", "assistant", "system"].includes(String(value.role)) ||
    !Array.isArray(value.parts)
  )
    return undefined;
  const parts = value.parts.flatMap((part): ChatPart[] => {
    if (!record(part)) return [];
    if (
      (part.type === "text" || part.type === "reasoning") &&
      typeof part.text === "string"
    )
      return [
        {
          type: part.type,
          text: part.text,
          state: part.state === "streaming" ? "streaming" : "done"
        }
      ];
    if (
      part.type === "dynamic-tool" &&
      typeof part.toolCallId === "string" &&
      typeof part.toolName === "string" &&
      ["input-available", "output-available", "output-error"].includes(
        String(part.state)
      )
    )
      return [
        {
          type: "dynamic-tool",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          state: part.state as
            | "input-available"
            | "output-available"
            | "output-error",
          input: part.input,
          ...(part.output === undefined ? {} : { output: part.output }),
          ...(typeof part.errorText === "string"
            ? { errorText: part.errorText }
            : {})
        }
      ];
    if (
      part.type === "data-status" &&
      record(part.data) &&
      typeof part.data.status === "string"
    )
      return [
        {
          type: "data-status",
          data: {
            status: part.data.status,
            ...(typeof part.data.error === "string"
              ? { error: part.data.error }
              : {})
          }
        }
      ];
    return [];
  });
  return [{ id: value.id, role: value.role as ChatMessage["role"], parts }];
}

export function contents(message: NativeMessage): RecordValue[] {
  return Array.isArray(message.content) ? message.content.filter(record) : [];
}

export function terminalReceipt(value: unknown): TerminalReceipt | undefined {
  return record(value) &&
    typeof value.id === "string" &&
    (value.status === "completed" || value.status === "waiting") &&
    typeof value.outputCommit === "string" &&
    /^[a-f0-9]{40}$/.test(value.outputCommit) &&
    typeof value.tool === "string" &&
    record(value.arguments)
    ? {
        id: value.id,
        status: value.status,
        outputCommit: value.outputCommit,
        tool: value.tool,
        arguments: value.arguments
      }
    : undefined;
}

export function errorText(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : record(value) && typeof value.message === "string"
      ? value.message
      : undefined;
}

export function toolOutput(value: unknown): unknown {
  return Array.isArray(value)
    ? value
        .filter(record)
        .map((part) =>
          part.type === "text"
            ? part.text
            : part.type === "file"
              ? { uri: part.uri, mime: part.mime, name: part.name }
              : undefined
        )
        .filter((part) => part !== undefined)
    : undefined;
}

export function isNativeMessage(value: unknown): value is NativeMessage {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string"
  );
}

export function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function olderCursor(incoming: string, current?: string): boolean {
  return (
    !!current &&
    /^\d+$/.test(incoming) &&
    /^\d+$/.test(current) &&
    BigInt(incoming) <= BigInt(current)
  );
}

export function remember(
  state: SessionProjection,
  cursor: string
): SessionProjection {
  return cursor ? { ...state, cursor } : state;
}

export function toolImages(metadata: unknown): string[] {
  return record(metadata) && Array.isArray(metadata.cloudflareImages)
    ? metadata.cloudflareImages.filter(
        (uri): uri is string =>
          typeof uri === "string" &&
          uri.length <= 1_000_030 &&
          /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]*={0,2}$/.test(uri)
      )
    : [];
}
