import { ConversationHeader } from "./conversation-header";
import { ConversationDetails } from "./conversation-details";
import { ConversationTranscript } from "./conversation-transcript";
import { useConversationActions } from "./use-conversation-actions";
import { useConversationScroll } from "./use-conversation-scroll";
import { Banner, Button, InputArea, Text } from "@cloudflare/kumo";
import { ArrowDownIcon, PaperPlaneRightIcon } from "@phosphor-icons/react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState
} from "react";

import type { SpecialistChatState } from "../presentation";
import { useNativeSession } from "../native-stream";
import { acceptedOutcome, sessionMessagesForJob } from "../session-projection";
import { cancelRun, type UIJob } from "../api";
import { NativeSessionControls } from "./session-controls";

import {
  MaterialAttachments,
  dropMaterials,
  pasteMaterials,
  useMaterialDraft
} from "./materials";
import { chatActivity } from "../chat-activity";
import { conversations } from "../attempts";
import { chatTurns } from "../chat-transcript";

export function SpecialistChat({
  job,
  attempts,
  onSelect,
  onRevision,
  onState,
  readOnly = false,
  displayName,
  task,
  peers = [],
  onSelectConversation,
  draft = "",
  onDraftChange,
  onAttentionChange,
  canStopRun = false
}: {
  canStopRun?: boolean;
  job: UIJob;
  attempts: UIJob[];
  draft?: string;
  onDraftChange?: (value: string, expected?: string) => void;
  onAttentionChange?: (id: string, needed: boolean) => void;
  readOnly?: boolean;
  displayName?: string | undefined;
  task?: string | undefined;
  peers?: UIJob[];
  onSelectConversation?: (id: string) => void;
  onSelect: (id: string) => void;
  onRevision: (job?: UIJob) => void;
  onState: (state: SpecialistChatState) => void;
}) {
  const input = draft;
  const setInput = (value: string) => onDraftChange?.(value);
  const [needsAnswer, setNeedsAnswer] = useState(false);
  const handleAttention = useCallback(
    (needed: boolean) => {
      setNeedsAnswer(needed);
      onAttentionChange?.(job.id, needed);
    },
    [job.id, onAttentionChange]
  );
  const materials = useMaterialDraft(job.runId);
  const {
    projection,
    connected,
    error: streamError,
    controlsRevision
  } = useNativeSession(
    job.id,
    [
      "waiting",
      "completed",
      "failed",
      "invalid_result",
      "integration_failed",
      "interrupted"
    ].includes(job.status),
    job.inputError === undefined || job.nativeSession === true
  );
  const effectiveJob =
    projection.job && projection.job.revision > job.revision
      ? projection.job
      : job;
  const selectedMessages = useMemo(
    () => sessionMessagesForJob(projection, effectiveJob),
    [projection, effectiveJob]
  );
  const messages = useDeferredValue(selectedMessages);
  const turns = useMemo(
    () => chatTurns(messages, job),
    [messages, job.id, job.task]
  );
  const name =
    displayName ??
    (job.role
      ? job.role.charAt(0).toUpperCase() + job.role.slice(1)
      : "Specialist");
  const sessionActivity = chatActivity(
    effectiveJob,
    messages,
    projection.busy,
    connected
  );
  const activity =
    needsAnswer && !readOnly
      ? { ...sessionActivity, label: "Needs your answer", working: false }
      : sessionActivity;
  const activePeer = conversations(
    peers.filter((p) => p.runId === job.runId)
  ).find((c) => c.job.id !== job.id && c.job.status === "running");
  const effectiveStatus = effectiveJob.status;
  const outcome = acceptedOutcome(projection, effectiveJob);
  useEffect(() => {
    onState({
      ...(projection.job ? { job: projection.job } : {}),
      streaming: projection.busy
    });
  }, [projection.job, projection.busy, onState]);
  const running = effectiveStatus === "running";
  const preparing =
    effectiveJob.preparingConversation === true &&
    effectiveStatus === "created";
  const conversing = running || preparing;
  const stopped =
    [
      "completed",
      "failed",
      "waiting",
      "invalid_result",
      "integration_failed",
      "interrupted"
    ].includes(effectiveStatus) && job.cleanupStatus !== "pending";
  const nativeFiles = effectiveJob.nativeSession === true;
  const canAttachFiles =
    !preparing && (nativeFiles || effectiveJob.inputError !== undefined);
  const composerAvailable =
    !readOnly && (conversing || stopped) && !effectiveJob.recovery?.sealed;
  const filesSelected = materials.files.length > 0;
  const {
    pending,
    error,
    setError,
    submission,
    canEditRejectedSubmission,
    canSend,
    steer,
    interrupt,
    editRejectedDraft
  } = useConversationActions({
    job,
    input,
    composerAvailable,
    conversing,
    filesSelected,
    materials,
    onRevision,
    onDraftChange
  });
  const { scrollRef, awayFromBottom, onScroll, jumpToLatest } =
    useConversationScroll(job.id, messages);

  return (
    <section
      className="chat-shell grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-kumo-base text-base text-kumo-default"
      aria-label={`${job.role ?? "Specialist"} chat`}
      aria-busy={!connected && !projection.job && job.inputError === undefined}
    >
      <ConversationHeader
        job={job}
        effectiveJob={effectiveJob}
        name={name}
        activity={activity}
        connected={connected}
        pendingSpans={projection.pendingSpans}
        nativeFiles={nativeFiles}
        running={running}
        conversing={conversing}
        readOnly={readOnly}
        pending={pending}
        interrupt={interrupt}
      />
      <ConversationDetails
        job={job}
        attempts={attempts}
        task={task}
        connected={connected}
        readOnly={readOnly}
        canStopRun={canStopRun}
        pending={pending}
        onSelect={onSelect}
        recovery={effectiveJob.recovery}
        onResumed={() => onRevision()}
        onStopRun={() =>
          void cancelRun(job.runId).catch((e) => setError(String(e)))
        }
      />
      <div className="relative min-h-0">
        <div
          className="message-scroll h-full min-h-0 overflow-y-auto"
          ref={scrollRef}
          onScroll={onScroll}
        >
          <ConversationTranscript
            job={job}
            effectiveJob={effectiveJob}
            messages={messages}
            turns={turns}
            name={name}
            activity={activity}
            connected={connected}
            conversing={conversing}
            busy={projection.busy}
            outcome={outcome}
            activePeer={activePeer}
            onSelectConversation={onSelectConversation}
          />
        </div>
        {awayFromBottom && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              variant="secondary"
              icon={<ArrowDownIcon size={16} />}
              onClick={jumpToLatest}
            >
              Jump to latest
            </Button>
          </div>
        )}
      </div>

      {readOnly ? (
        <footer className="border-t border-kumo-line px-4 py-3">
          <Text variant="secondary">
            Restore this run to send instructions or attach files. Restoring
            does not resume previous execution.
          </Text>
        </footer>
      ) : (
        <footer className="composer-wrap border-t border-kumo-line px-4 py-3">
          <div className="mx-auto grid max-w-3xl gap-3">
            {effectiveJob.nativeSession === true &&
              !effectiveJob.recovery?.sealed &&
              (preparing ||
                !["created", "provisioning"].includes(effectiveStatus)) && (
                <NativeSessionControls
                  jobId={job.id}
                  running={conversing}
                  controlsRevision={controlsRevision}
                  onAttention={handleAttention}
                />
              )}
            {(error ?? streamError) && (
              <Banner
                className="composer-error"
                variant="error"
                role="alert"
                description={error ?? streamError}
              />
            )}
            <form
              className="composer-card grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void steer();
              }}
              onPaste={(event) => {
                if (canAttachFiles)
                  pasteMaterials(
                    event,
                    materials.draft,
                    !composerAvailable || pending || !!submission
                  );
              }}
              onDragOver={(event) => {
                if (
                  canAttachFiles &&
                  event.dataTransfer.types.includes("Files")
                )
                  event.preventDefault();
              }}
              onDrop={(event) => {
                if (canAttachFiles)
                  dropMaterials(
                    event,
                    materials.draft,
                    !composerAvailable || pending || !!submission
                  );
              }}
            >
              {canAttachFiles && (
                <MaterialAttachments
                  draft={materials.draft}
                  files={materials.files}
                  {...(materials.error ? { error: materials.error } : {})}
                  disabled={!composerAvailable || pending || !!submission}
                />
              )}
              {filesSelected && (
                <Text variant="secondary">
                  {running
                    ? "Files will queue a fresh revision. The current attempt continues."
                    : "Files will be pinned to a fresh revision."}{" "}
                  Selection does not mean the specialist has read them.
                </Text>
              )}
              {submission && error && (
                <Text variant="secondary">
                  Retry sends the same instructions and files.
                </Text>
              )}
              {canEditRejectedSubmission && submission && (
                <Button variant="secondary" onClick={editRejectedDraft}>
                  Edit rejected draft
                </Button>
              )}
              <InputArea
                value={input}
                onValueChange={setInput}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void steer();
                  }
                }}
                disabled={!composerAvailable || pending || !!submission}
                placeholder={
                  preparing
                    ? "Discuss your project while discovery runs…"
                    : running
                      ? `Message ${name.toLowerCase()} while it works…`
                      : stopped
                        ? "Send instructions for a fresh revision attempt…"
                        : "Waiting for this attempt to start…"
                }
                aria-label={`Message ${name}`}
                autoResize
                minRows={2}
                maxRows={6}
              />
              <div className="composer-bottom flex items-center justify-end gap-3 min-[760px]:justify-between">
                <Text
                  DANGEROUS_className="hidden min-[760px]:inline"
                  variant="secondary"
                >
                  {filesSelected
                    ? "Enter to queue revision"
                    : conversing
                      ? "Enter to send"
                      : "Enter to create a fresh attempt"}{" "}
                  · Shift+Enter for a new line
                </Text>
                <Button
                  variant="primary"
                  shape="square"
                  icon={<PaperPlaneRightIcon size={17} />}
                  disabled={!canSend}
                  type="submit"
                  aria-label="Send message"
                />
              </div>
            </form>
          </div>
        </footer>
      )}
    </section>
  );
}
