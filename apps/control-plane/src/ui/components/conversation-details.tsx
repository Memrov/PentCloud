import { Badge, Button, Collapsible, Tabs, Text } from "@cloudflare/kumo";
import { RuntimeRecoveryNotice } from "./runtime-recovery";
import type { UIJob } from "../api";
export function ConversationDetails({
  job,
  attempts,
  task,
  connected,
  readOnly,
  canStopRun,
  pending,
  onSelect,
  recovery,
  onResumed,
  onStopRun
}: {
  job: UIJob;
  attempts: UIJob[];
  task: string | undefined;
  connected: boolean;
  readOnly: boolean;
  canStopRun: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  recovery: UIJob["recovery"];
  onResumed: () => void;
  onStopRun: () => void;
}) {
  return (
    <div className="border-b border-kumo-line px-4 py-1">
      <Collapsible className="conversation-details">
        <Collapsible.DefaultTrigger>
          Conversation details
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-base">
              {job.model ?? "OpenCode Go"}
            </Badge>
            <Text variant="secondary">
              {connected ? "Live projection" : "Reconnecting"}
            </Text>
            <Text variant="secondary">{job.id}</Text>
          </div>
          <Text>{task || job.task}</Text>
          {job.archiveStatus === "compacted" && (
            <Badge variant="secondary">Archive compacted</Badge>
          )}
          {job.archiveStatus === "failed" && (
            <Badge variant="destructive">Archive retrying</Badge>
          )}
          <div className="overflow-x-auto">
            <Tabs
              variant="underline"
              value={job.id}
              onValueChange={onSelect}
              tabs={attempts.map((a) => ({
                value: a.id,
                label: `Attempt ${a.attempt ?? 1} · ${a.status}`
              }))}
            />
          </div>
          {!readOnly && canStopRun && (
            <Button variant="secondary" disabled={pending} onClick={onStopRun}>
              Stop run
            </Button>
          )}
        </Collapsible.DefaultPanel>
      </Collapsible>
      {!readOnly && recovery && (
        <RuntimeRecoveryNotice
          key={recovery.observedAt}
          recovery={recovery}
          scope="attempt"
          attemptId={job.id}
          onResumed={onResumed}
        />
      )}
    </div>
  );
}
