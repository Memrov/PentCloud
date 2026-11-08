import { Banner, Button, Empty, Loader, Text } from "@cloudflare/kumo";
import { BrainIcon } from "@phosphor-icons/react";
import { ChatResponse } from "./chat-conversation";
import { ChatMarkdown } from "./chat-markdown";
import { RunFilesPanel } from "./materials";
import type { UIJob } from "../api";
import type { ChatMessage } from "../presentation";
import type { ChatTurn } from "../chat-transcript";
import type { AgentConversation } from "../attempts";
import type { chatActivity } from "../chat-activity";
export function ConversationTranscript({
  job,
  effectiveJob,
  messages,
  turns,
  name,
  activity,
  connected,
  conversing,
  busy,
  outcome,
  activePeer,
  onSelectConversation
}: {
  job: UIJob;
  effectiveJob: UIJob;
  messages: ChatMessage[];
  turns: ChatTurn[];
  name: string;
  activity: ReturnType<typeof chatActivity>;
  connected: boolean;
  conversing: boolean;
  busy: boolean;
  outcome: string | undefined;
  activePeer: AgentConversation | undefined;
  onSelectConversation: ((id: string) => void) | undefined;
}) {
  const effectiveStatus = effectiveJob.status;
  const nativeFiles = effectiveJob.nativeSession === true;
  return (
    <div className="message-column mx-auto grid w-full max-w-3xl gap-4 px-4 py-5">
      {!connected && (effectiveJob.inputError === undefined || nativeFiles) && (
        <Banner
          variant="secondary"
          role="status"
          title="Reconnecting to this conversation"
          description="Cloud execution may continue while updates reconnect. Your draft stays here."
        />
      )}
      {effectiveStatus === "waiting" && (
        <Banner
          variant="secondary"
          description={activity.detail}
          action={
            activePeer && onSelectConversation ? (
              <Button
                variant="ghost"
                onClick={() => onSelectConversation(activePeer.job.id)}
              >
                Open {activePeer.label}
              </Button>
            ) : undefined
          }
        />
      )}
      {nativeFiles && (
        <RunFilesPanel
          key={`${effectiveJob.id}:${effectiveJob.outputCommit ?? effectiveJob.inputCommit ?? ""}`}
          runId={job.runId}
          jobId={job.id}
        />
      )}
      {effectiveJob.inputError !== undefined && (
        <Banner
          className="composer-error"
          variant="error"
          role="alert"
          title={
            nativeFiles
              ? "Assessment input rejected"
              : "Input rejected before session start"
          }
          description={
            <>
              <p>{effectiveJob.inputError}</p>
              <p>
                Correct the instructions or attachments below to queue a fresh
                revision.
              </p>
            </>
          }
        />
      )}
      {messages.length === 0
        ? effectiveJob.inputError === undefined && (
            <WaitingState status={effectiveStatus} />
          )
        : turns.map((turn, index) => (
            <ChatResponse
              key={turn.id}
              turn={turn}
              name={name}
              active={conversing && busy && index === turns.length - 1}
              activity={activity}
            />
          ))}
      {outcome && (
        <section aria-label="Accepted outcome" className="grid gap-2">
          <Text bold>Accepted outcome</Text>
          <ChatMarkdown>{outcome}</ChatMarkdown>
        </section>
      )}
      {effectiveStatus === "completed" && !outcome && (
        <Banner
          variant="secondary"
          title="Completed"
          description={
            messages.some(
              (m) =>
                m.role === "assistant" &&
                m.parts.some((p) => p.type === "text" && p.text.trim())
            )
              ? "This attempt has finished. Its accepted files are available above."
              : "This attempt completed through tool results without a separate chat summary. Expand Activity for its recorded work, or open Files for accepted deliverables."
          }
        />
      )}
    </div>
  );
}
function WaitingState({ status }: { status: string }) {
  if (status === "completed") return null;
  return (
    <Empty
      icon={status === "running" ? <Loader /> : <BrainIcon size={24} />}
      title={
        status === "running" ? "Specialist is working" : "Conversation ready"
      }
      description="Session events will appear here as the specialist works."
    />
  );
}
