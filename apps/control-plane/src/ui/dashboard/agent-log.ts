import type { ChatMessage } from "../presentation";
import { isPublicationFence } from "../chat-activity";

/**
 * Row contract adapted from Cloudflare's Agents playground LogPanel
 * (cloudflare/agents examples/playground/src/components/LogPanel.tsx).
 * `timestamp` is optional because replayed history carries no per-part time.
 */
export type AgentLogDirection = "in" | "out" | "error" | "info";
export interface AgentLogEntry {
  id: string;
  direction: AgentLogDirection;
  type: string;
  data?: string;
  timestamp?: number;
}

const maxDataLength = 600;

/** Flatten a specialist's projected session into append-only log rows. */
export function sessionLogEntries(
  messages: readonly ChatMessage[]
): AgentLogEntry[] {
  const entries: AgentLogEntry[] = [];
  for (const message of messages) {
    message.parts.forEach((part, index) => {
      const key = `${message.id}:${part.id ?? index}`;
      if (part.type === "text") {
        if (!part.text.trim()) return;
        const direction: AgentLogDirection =
          message.role === "user"
            ? "out"
            : message.role === "system"
              ? "info"
              : "in";
        const type =
          message.role === "user"
            ? "prompt"
            : message.role === "system"
              ? "system"
              : "message";
        entries.push({ id: key, direction, type, data: clip(part.text) });
      } else if (part.type === "reasoning") {
        if (!part.text.trim()) return;
        entries.push({
          id: key,
          direction: "info",
          type: "thinking",
          data: clip(part.text)
        });
      } else if (part.type === "dynamic-tool") {
        const call = `${message.id}:${part.toolCallId}`;
        entries.push({
          id: `${call}:call`,
          direction: "out",
          type: toolName(part.toolName),
          ...data(part.input)
        });
        if (part.state === "output-available")
          entries.push({
            id: `${call}:result`,
            direction: "in",
            type: `${toolName(part.toolName)} result`,
            ...data(part.output)
          });
        if (
          part.state === "output-error" &&
          !isPublicationFence(part.errorText)
        )
          entries.push({
            id: `${call}:error`,
            direction: "error",
            type: `${toolName(part.toolName)} failed`,
            ...data(part.errorText)
          });
      } else if (part.type === "data-status") {
        if (isPublicationFence(part.data.error)) return;
        const failed = part.data.status === "failed";
        entries.push({
          id: key,
          direction: failed ? "error" : "info",
          type: `status ${part.data.status}`,
          ...data(part.data.error)
        });
      }
    });
  }
  return entries;
}

function toolName(name: string): string {
  return name.split(/__|\./).at(-1) || "tool";
}

function data(value: unknown): { data?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value === "string")
    return value.trim() ? { data: clip(value) } : {};
  // Projected tool output is a list of text chunks (and file descriptors).
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return data(value.join("\n"));
  try {
    const text = JSON.stringify(value);
    return text && text !== "{}" ? { data: clip(text) } : {};
  } catch {
    return {};
  }
}

function clip(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxDataLength
    ? `${compact.slice(0, maxDataLength)}…`
    : compact;
}
