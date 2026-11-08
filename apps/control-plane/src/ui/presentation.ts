import type { UIJob, UIRun } from "./api";

/** Browser presentation contracts, independent of Durable Object implementations. */
export type ChatRole = "user" | "assistant" | "system";
export type ChatPart = { id?: string } & (
  | { type: "text" | "reasoning"; text: string; state: "streaming" | "done" }
  | {
      type: "dynamic-tool";
      toolCallId: string;
      toolName: string;
      state: "input-available" | "output-available" | "output-error";
      input: unknown;
      output?: unknown;
      images?: string[];
      errorText?: string;
      recovered?: true;
    }
  | { type: "data-status"; data: { status: string; error?: string } }
);
export interface ChatMessage {
  id: string;
  role: ChatRole;
  parts: ChatPart[];
}
export type ChatJobSummary = UIJob;
export interface SpecialistChatState {
  job?: UIJob;
  streaming: boolean;
  lastEventAt?: number;
  archivedAt?: number;
}
export interface RunHubState {
  runId: string;
  baselineRepo: string;
  inputCommit: string;
  status: UIRun["status"];
  jobs: UIJob[];
  waveMode?: boolean;
}

export type UIActivityEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.interrupted"
  | "phase.started"
  | "phase.completed"
  | "phase.failed"
  | "platform.memory_recovery_sealed"
  | "platform.memory_recovery_backoff"
  | "input.committed"
  | "input.rejected"
  | "discovery.acknowledged"
  | "conversation.preparation_failed"
  | "attempt.recovery_needed"
  | "recovery.failed";
export interface UIActivityEvent {
  instanceId: string;
  eventId: number;
  timestamp: number;
  type: UIActivityEventType;
  stepName?: string;
  jobId?: string;
  error?: { name: string; message: string };
}
