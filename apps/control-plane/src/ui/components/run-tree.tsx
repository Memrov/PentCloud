import {
  Badge,
  Button,
  Sidebar,
  Text,
  Tooltip,
  useSidebar
} from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { UIJob, UIRun } from "../api";
import { conversations } from "../attempts";
import { runLabel } from "../run-label";
import { DashboardButton } from "./dashboard-button";

interface RunTreeProps {
  runs: UIRun[];
  jobs: UIJob[];
  attentionIds?: string[];
  selectedRunId?: string | undefined;
  selectedJobId?: string | undefined;
  onSelectRun: (id: string) => void;
  onSelectJob: (id: string) => void;
}
export function RunTree(props: RunTreeProps) {
  const { setOpenMobile } = useSidebar(),
    grouped = conversations(props.jobs);
  const select = (action: () => void) => {
    action();
    setOpenMobile(false);
  };
  return (
    <Sidebar aria-label="Run navigation">
      <Sidebar.Header className="flex flex-row items-center justify-between">
        <Text bold>PentCloud</Text>
        <Button
          className="min-[760px]:hidden"
          variant="ghost"
          shape="square"
          icon={<XIcon size={16} />}
          aria-label="Close navigation"
          onClick={() => setOpenMobile(false)}
        />
      </Sidebar.Header>
      <div className="px-2">
        <DashboardButton
          className="w-full"
          run={props.runs.find((r) => r.id === props.selectedRunId)}
          jobId={props.selectedJobId}
          jobs={props.jobs}
        />
      </div>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Runs</Sidebar.GroupLabel>
          {props.runs.length === 0 && (
            <Text variant="secondary">No active runs</Text>
          )}
          <Sidebar.Menu>
            {props.runs.map((run) => (
              <Sidebar.MenuItem key={run.id}>
                <Tooltip
                  content={run.id}
                  render={
                    <Sidebar.MenuButton
                      className="run-row text-base"
                      active={run.id === props.selectedRunId}
                      onClick={() => select(() => props.onSelectRun(run.id))}
                    />
                  }
                >
                  <span className="min-w-0 flex-1 truncate">
                    {runLabel(run)}
                  </span>
                  <Badge
                    appearance="dot"
                    variant={
                      run.status === "completed"
                        ? "success"
                        : [
                              "failed",
                              "invalid_result",
                              "integration_failed",
                              "interrupted"
                            ].includes(run.status)
                          ? "error"
                          : "neutral"
                    }
                    className="text-base"
                  >
                    {run.status}
                  </Badge>
                </Tooltip>
                {run.id === props.selectedRunId && (
                  <Sidebar.MenuSub className="conversation-list">
                    {grouped
                      .filter((c) => c.job.runId === run.id)
                      .map((c) => (
                        <Sidebar.MenuSubButton
                          key={c.id}
                          className="job-row text-base"
                          active={c.attempts.some(
                            (a) => a.id === props.selectedJobId
                          )}
                          onClick={() =>
                            select(() => props.onSelectJob(c.job.id))
                          }
                          aria-label={c.label}
                        >
                          <Text as="span">{c.label}</Text>
                          {props.attentionIds?.includes(c.job.id) && (
                            <Badge
                              appearance="dot"
                              variant="warning"
                              className="ml-auto text-base"
                            >
                              Needs your answer
                            </Badge>
                          )}
                        </Sidebar.MenuSubButton>
                      ))}
                  </Sidebar.MenuSub>
                )}
              </Sidebar.MenuItem>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
    </Sidebar>
  );
}
