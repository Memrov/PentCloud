import { useEffect, useMemo, useRef, useState } from "react";

import type { UIJob } from "../api";
import { LogPanel } from "../components/log-panel";
import { useNativeSession } from "../native-stream";
import { sessionMessagesForJob } from "../session-projection";
import { sessionLogEntries, type AgentLogEntry } from "./agent-log";

const settledStatuses = ["waiting", "completed", "failed", "invalid_result", "integration_failed", "interrupted"];

/** Read-only live output for the specialist selected on the run map. */
export function AgentLogPanel({ job }: { job: UIJob }) {
  const { projection, connected, error } = useNativeSession(job.id, settledStatuses.includes(job.status), job.inputError === undefined || job.nativeSession === true);
  const effectiveJob = projection.job && projection.job.revision > job.revision ? projection.job : job;
  const messages = useMemo(() => sessionMessagesForJob(projection, effectiveJob), [projection, effectiveJob]);
  const entries = useMemo(() => sessionLogEntries(messages), [messages]);
  const logs = useFirstSeen(job.id, entries);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setCleared(new Set()), [job.id]);
  const visible = useMemo(() => logs.filter(log => !cleared.has(log.id)), [logs, cleared]);
  const settled = settledStatuses.includes(effectiveJob.status);
  const status = error ? "Stream error" : connected ? (settled ? "History" : "Live") : settled ? "Loaded" : "Connecting";
  return (
    <LogPanel
      title="Live output"
      logs={visible}
      onClear={() => setCleared(new Set(logs.map(log => log.id)))}
      status={<span className={`stream-state ${error ? "stream-reconnecting" : connected && !settled ? "stream-live" : connected ? "stream-closed" : "stream-connecting"}`}>{status}</span>}
      emptyText={settled ? "No output was retained for this specialist." : "Waiting for this specialist to start working…"}
    />
  );
}

/**
 * Entries in the first projection are replayed history (no reliable time);
 * later rows are stamped when they first arrive in this browser.
 */
function useFirstSeen(jobId: string, entries: AgentLogEntry[]): AgentLogEntry[] {
  const seen = useRef<{ jobId: string; primed: boolean; times: Map<string, number | undefined> }>({ jobId, primed: false, times: new Map() });
  if (seen.current.jobId !== jobId) seen.current = { jobId, primed: false, times: new Map() };
  return useMemo(() => {
    const state = seen.current;
    const now = Date.now();
    for (const entry of entries) if (!state.times.has(entry.id)) state.times.set(entry.id, state.primed ? now : undefined);
    if (entries.length) state.primed = true;
    return entries.map(entry => {
      const timestamp = state.times.get(entry.id);
      return timestamp === undefined ? entry : { ...entry, timestamp };
    });
  }, [jobId, entries]);
}
