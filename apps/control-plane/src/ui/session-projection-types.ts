import type { UIJob } from "./api";
import type { ChatMessage } from "./presentation";
export type RecordValue = Record<string, unknown>;
export interface NativeMessage extends RecordValue {
  id: string;
  type: string;
}
export interface TerminalReceipt {
  id: string;
  status: "completed" | "waiting";
  outputCommit: string;
  tool: string;
  arguments: RecordValue;
}
export interface SessionProjection {
  messages: ChatMessage[];
  busy: boolean;
  pending: unknown[];
  job?: UIJob;
  cursor?: string;
  seenEventIds: ReadonlySet<string>;
  native: NativeMessage[];
  pendingSpans?: string[];
  result?: TerminalReceipt;
}
