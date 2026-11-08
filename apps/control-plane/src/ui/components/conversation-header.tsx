import { Badge, Button, Loader, Text, Tooltip } from "@cloudflare/kumo";
import { StopIcon } from "@phosphor-icons/react";
import { ThemeControl } from "./theme-control";
import { BrowserLiveViewControl } from "./browser-live-view";
import type { UIJob } from "../api";
import type { chatActivity } from "../chat-activity";
export function ConversationHeader({
  job,
  effectiveJob,
  name,
  activity,
  connected,
  pendingSpans,
  nativeFiles,
  running,
  conversing,
  readOnly,
  pending,
  interrupt
}: {
  job: UIJob;
  effectiveJob: UIJob;
  name: string;
  activity: ReturnType<typeof chatActivity>;
  connected: boolean;
  pendingSpans: string[] | undefined;
  nativeFiles: boolean;
  running: boolean;
  conversing: boolean;
  readOnly: boolean;
  pending: boolean;
  interrupt: () => Promise<void>;
}) {
  return (
    <header className="chat-header flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
      <div className="chat-title-block min-w-0 flex-1">
        <Text as="h1" variant="heading3">
          {name}
        </Text>
        <div className="current-activity flex items-center gap-2" role="status">
          {activity.working && <Loader size="sm" />}
          <Text variant="secondary">
            {effectiveJob.inputError !== undefined && !nativeFiles
              ? "Input rejected"
              : !connected
                ? "Reconnecting"
                : pendingSpans?.length && activity.working
                  ? "Restoring response"
                  : activity.label}
          </Text>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ThemeControl />
        {job.cleanupStatus === "pending" && (
          <Badge variant="error" className="text-base">
            Cleanup retrying
          </Badge>
        )}
        {!readOnly &&
          effectiveJob.nativeSession === true &&
          running &&
          !effectiveJob.recovery?.sealed && (
            <BrowserLiveViewControl key={job.id} jobId={job.id} />
          )}
        {!readOnly && conversing && (
          <Tooltip
            content="Stop attempt"
            render={
              <Button
                variant="secondary"
                shape="square"
                aria-label="Stop attempt"
                icon={<StopIcon size={16} />}
                disabled={!conversing || pending}
                onClick={interrupt}
              />
            }
          />
        )}
      </div>
    </header>
  );
}
