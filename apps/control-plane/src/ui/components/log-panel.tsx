import { useEffect, useRef } from "react";
import { TrashIcon } from "@phosphor-icons/react";
import { Button, LayerCard } from "@cloudflare/kumo";

import type { AgentLogDirection, AgentLogEntry } from "../dashboard/agent-log";

/**
 * Terminal-style event log, adapted from Cloudflare's Agents playground
 * LogPanel (cloudflare/agents examples/playground/src/components/LogPanel.tsx, MIT).
 * Changes: optional timestamps, a status slot, and auto-scroll that only
 * follows the tail while the reader is already at the bottom.
 */
export function LogPanel({
  logs,
  onClear,
  title = "Event log",
  status,
  emptyText = "Waiting for events…",
  maxHeight = "420px"
}: {
  logs: readonly AgentLogEntry[];
  onClear?: () => void;
  title?: string;
  status?: React.ReactNode;
  emptyText?: string;
  maxHeight?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [logs]);
  return (
    <LayerCard className="log-panel overflow-hidden rounded-lg ring ring-kumo-line">
      <div className="flex items-center justify-between gap-2 border-b border-kumo-line px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
          {title}
        </span>
        <span className="flex items-center gap-2">
          {status}
          {onClear && (
            <Button
              variant="ghost"
              shape="square"
              size="xs"
              aria-label="Clear log"
              title="Clear log"
              icon={<TrashIcon size={14} />}
              onClick={onClear}
            />
          )}
        </span>
      </div>
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label={title}
        className="overflow-y-auto"
        style={{ maxHeight }}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
        }}
      >
        {logs.length === 0 ? (
          <div className="px-3 py-3 font-mono text-xs text-kumo-inactive">
            {emptyText}
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className={`log-entry log-entry-${log.direction}`}
            >
              <span className="log-entry-time">
                {log.timestamp === undefined
                  ? "history"
                  : new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span
                className={`log-entry-mark log-mark-${log.direction}`}
                aria-hidden="true"
              >
                {directionLabel(log.direction)}
              </span>
              <span className="log-entry-type">{log.type}</span>
              {log.data !== undefined && (
                <span className="log-entry-data">{log.data}</span>
              )}
            </div>
          ))
        )}
      </div>
    </LayerCard>
  );
}

function directionLabel(direction: AgentLogDirection): string {
  if (direction === "in") return "←";
  if (direction === "out") return "→";
  if (direction === "error") return "✕";
  return "•";
}
