import { useEffect, useMemo, useState } from "react";

import type { UIActivityEvent } from "../presentation";
import { parseActivityEvent, type UIJob } from "../api";
import { chatPath, reduceWorkflowEvents, type WorkflowTimeline, type WorkflowTimelineStatus } from "./model";

export type TimelineConnection = "connecting" | "live" | "reconnecting" | "closed";

export function WorkflowTimeline({ job }: { job: UIJob }) {
  const [events, setEvents] = useState<UIActivityEvent[]>([]);
  const [connection, setConnection] = useState<TimelineConnection>("connecting");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setEvents([]);
    setConnection("connecting");
    const source = new EventSource(`/v1/ui/runs/${encodeURIComponent(job.runId)}/workflow-events`);
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    const receive = (message: MessageEvent<string>) => {
      try {
        const event = parseActivityEvent(JSON.parse(message.data) as unknown);
        setEvents((current) => current.some((candidate) => candidate.eventId === event.eventId) ? current : [...current, event]);
        if (["run.completed", "run.failed", "run.interrupted"].includes(event.type)) {
          setConnection("closed");
          source.close();
        }
      } catch {
        setConnection("reconnecting");
      }
    };
    source.addEventListener("activity", receive as EventListener);
    source.addEventListener("end", () => { setConnection("closed"); source.close(); });
    return () => source.close();
  }, [job.runId, job.id]);
  const timeline = useMemo(() => reduceWorkflowEvents(events, now), [events, now]);
  return <WorkflowTimelineView job={job} timeline={timeline} connection={connection} />;
}

export function WorkflowTimelineView({
  job,
  timeline,
  connection,
}: {
  job: UIJob;
  timeline: WorkflowTimeline;
  connection: TimelineConnection;
}) {
  return (
    <section className="workflow-panel" aria-label={`${job.role ?? "Specialist"} activity`}>
      <header className="workflow-panel-header">
        <div>
          <span className="dashboard-kicker">Run activity</span>
          <h2>{job.role ?? job.tool ?? "Specialist"}</h2>
          <p>{job.id}</p>
        </div>
        <div className="workflow-panel-actions">
          <span className={`stream-state stream-${connection}`}>{connectionLabel(connection)}</span>
          <a className="dashboard-button dashboard-button-primary" href={chatPath(job.runId, job.id)}>Open chat</a>
        </div>
      </header>
      {timeline.rows.length === 0 ? (
        <div className="workflow-empty">
          {connection !== "closed" && <span className="workflow-empty-pulse" />}
          <strong>{connection === "closed" ? "No retained activity history" : "Waiting for activity history"}</strong>
          <p>{connection === "closed" ? "This archived run has no retained phase events. Its conversations are available in chat." : "Retained phases will replay before live activity continues."}</p>
        </div>
      ) : (
        <div className="workflow-timeline">
          <div className="timeline-scale"><span>0</span><span>{formatDuration(timeline.durationMs / 2)}</span><span>{formatDuration(timeline.durationMs)}</span></div>
          {timeline.rows.map((row) => (
            <div className={`timeline-row timeline-${row.status}`} key={row.id}>
              <div className="timeline-label" style={{ paddingLeft: `${row.depth * 16}px` }}>
                <span className="timeline-status-mark" />
                <span><strong>{row.label}</strong><small>{statusLabel(row.status)}</small></span>
              </div>
              <div className="timeline-track">
                <span className="timeline-bar" style={{ left: `${row.leftPercent}%`, width: `${Math.max(.8, row.widthPercent)}%` }} />
              </div>
              <div className="timeline-duration">{formatDuration(row.durationMs)}</div>
              {(row.retryDelayMs !== undefined || row.error) && (
                <div className="timeline-detail">
                  {row.retryDelayMs !== undefined && <span>Retry in {formatDuration(row.retryDelayMs)}</span>}
                  {row.error && <span>{row.error.message}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function connectionLabel(connection: TimelineConnection): string {
  if (connection === "live") return "Live events";
  if (connection === "closed") return "History complete";
  if (connection === "reconnecting") return "Reconnecting";
  return "Connecting";
}

function statusLabel(status: WorkflowTimelineStatus): string {
  if (status === "retrying") return "Retry scheduled";
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
