import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import type { UIJob, UIRun, UIRunJobs, RunLifecycleResult } from "./api";
import { emptyRunProjection, mergeRunLifecycle, purgeRunProjection, mergeCoordinatorProjection, mergeJobProjection, mergeRunList, mergeRunSnapshot, parseCoordinatorProjection, type CoordinatorProjection } from "./coordinator-projection";
import { emptySessionProjection, projectSessionEvent, projectSessionSnapshot, projectLiveSessionEvent, type SessionProjection } from "./session-projection";

/** EventSource owns reconnection and sends Last-Event-ID on the same authenticated URL. */
export function connectNativeSession(jobId: string, handlers: {
  onProjection: (projection: SessionProjection) => void;
  onConnection: (connected: boolean) => void;
  onError: (message: string) => void;
  onControlsChanged?: () => void;
}, createSource: (url: string) => EventSource = url => new EventSource(url)): () => void {
  let projection = emptySessionProjection();
  const source = createSource(`/v1/ui/jobs/${encodeURIComponent(jobId)}/events`);
  source.onopen = () => handlers.onConnection(true);
  source.onerror = () => handlers.onConnection(false);
  const listen = (kind: "snapshot" | "session" | "live") => (event: MessageEvent<string>) => {
    try {
      const value: unknown = JSON.parse(event.data);
      projection = kind === "snapshot" ? projectSessionSnapshot(projection, value, event.lastEventId) : kind === "live" ? projectLiveSessionEvent(projection,value) : projectSessionEvent(projection, value, event.lastEventId);
      handlers.onProjection(projection);
      if(kind==="snapshot" || kind==="live" && controlsChanged(value)) handlers.onControlsChanged?.();
    } catch { handlers.onError("Could not read live session event"); }
  };
  source.addEventListener("snapshot", listen("snapshot") as EventListener);
  source.addEventListener("session", listen("session") as EventListener);
  source.addEventListener("live", listen("live") as EventListener);
  source.addEventListener("end", () => source.close());
  return () => source.close();
}

function controlsChanged(value: unknown): boolean {
  if(typeof value!=="object"||value===null)return false;
  const event=value as Record<string,unknown>;
  return event.type==="permission_asked"||event.type==="permission_replied"||event.type==="run_end"||((event.type==="tool_start"||event.type==="tool_end")&&event.name==="question");
}

export function useNativeSession(jobId: string, terminal = false, enabled = true): { projection: SessionProjection; connected: boolean; controlsRevision: number; error?: string } {
  const [projection, setProjection] = useState(emptySessionProjection);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [controlsRevision,setControlsRevision]=useState(0);
  // Reopen once at settlement: the finite history stream releases the SDK lease.
  useEffect(() => {
    setProjection(emptySessionProjection());
    setConnected(false);
    setError(undefined);
    setControlsRevision(0);
    if (!enabled) return;
    return connectNativeSession(jobId, { onProjection: setProjection, onConnection: setConnected, onError: setError, onControlsChanged:()=>setControlsRevision(revision=>revision+1) });
  }, [jobId, terminal, enabled]);
  return { projection, connected, controlsRevision, ...(error ? { error } : {}) };
}

/** Native State owns live summaries; REST adds historical archives and initial fallback. */
export function useCoordinatorRuns() {
  const [projection, setProjection] = useState(emptyRunProjection);
  useAgent<CoordinatorProjection>({
    agent: "coordinator",
    name: "global",
    onStateUpdate(value, source) {
      if (source !== "server") return;
      try {
        const next = parseCoordinatorProjection(value);
        setProjection(current => mergeCoordinatorProjection(current, next));
      } catch { /* Keep the last valid projection until the server publishes again. */ }
    },
  });
  const addRuns = useCallback((runs: UIRun[]) => setProjection(current => mergeRunList(current, runs)), []);
  const addRunSnapshot = useCallback((value: UIRunJobs) => setProjection(current => mergeRunSnapshot(current, value)), []);
  const addJob = useCallback((job: UIJob) => setProjection(current => mergeJobProjection(current, job)), []);
  const updateLifecycle = useCallback((value: RunLifecycleResult) => setProjection(current => mergeRunLifecycle(current, value)), []);
  const purgeRun = useCallback((runId: string) => setProjection(current => purgeRunProjection(current, runId)), []);
  return { ...projection, addRuns, addRunSnapshot, addJob, updateLifecycle, purgeRun };
}
