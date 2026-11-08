import { TargetLibrary } from "./onboarding/targets";
import { ChatDiscovery } from "./onboarding/chat-discovery";
import { RunSetup } from "./onboarding/run-setup";
import { Button, Sidebar, Text } from "@cloudflare/kumo";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { SpecialistChatState } from "./presentation";
import { useCoordinatorRuns } from "./native-stream";
import {
  runHasFinished,
  runMatchesView,
  cancelRun,
  getRunJobs,
  listRuns,
  type UIJob,
  type UIRun
} from "./api";
import {
  conversations,
  preferredConversation,
  threadAttempts
} from "./attempts";
import { RunTree } from "./components/run-tree";
import { DashboardButton } from "./components/dashboard-button";
import { parseChatSelection } from "./dashboard/model";

const SpecialistChat = lazy(async () => {
  const module = await import("./components/specialist-chat");
  return { default: module.SpecialistChat };
});

export default function App() {
  return (
    <Sidebar.Provider
      defaultOpen
      collapsible="offcanvas"
      mobileBreakpoint={760}
      className="app-frame h-dvh min-h-0 w-full bg-kumo-base text-base text-kumo-default"
      style={{ "--sidebar-width": "280px" } as React.CSSProperties}
    >
      <AppContent />
    </Sidebar.Provider>
  );
}
function AppContent() {
  const initialSelection = useMemo(
    () => parseChatSelection(window.location.search),
    []
  );
  const {
    runs,
    jobs: allJobs,
    addRuns,
    addRunSnapshot,
    addJob,
    purgedRunIds
  } = useCoordinatorRuns();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    initialSelection.runId
  );
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>(
    initialSelection.jobId
  );
  const selectionRef = useRef({ runId: selectedRunId, jobId: selectedJobId });
  selectionRef.current = { runId: selectedRunId, jobId: selectedJobId };
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attention, setAttention] = useState<Record<string, boolean>>({});
  const setAgentAttention = useCallback(
    (id: string, needed: boolean) =>
      setAttention((current) =>
        current[id] === needed ? current : { ...current, [id]: needed }
      ),
    []
  );
  const attentionIds = allJobs
    .filter(
      (job) =>
        attention[job.id] &&
        (runs.find((run) => run.id === job.runId)?.lifecycle ?? "active") ===
          "active" &&
        (job.status === "running" ||
          (job.preparingConversation && job.status === "created"))
    )
    .map((job) => job.id);
  useEffect(() => {
    const before = document.title;
    document.title = attentionIds.length
      ? `Needs your answer · PentCloud`
      : "PentCloud Control Room";
    return () => {
      document.title = before;
    };
  }, [attentionIds.length]);
  useEffect(() => {
    if (purgedRunIds.length)
      setDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !purgedRunIds.some((id) => key.startsWith(id + ":"))
          )
        )
      );
  }, [purgedRunIds]);
  const [creating, setCreating] = useState(!initialSelection.runId);
  const view = "active";
  const visibleRuns = useMemo(
    () =>
      runs.filter(
        (run) => runMatchesView(run, view) || run.id === selectedRunId
      ),
    [runs, view, selectedRunId]
  );
  const selectedRun = runs.find((run) => run.id === selectedRunId);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const jobs = useMemo(
    () => allJobs.filter((job) => job.runId === selectedRunId),
    [allJobs, selectedRunId]
  );

  useEffect(() => {
    if (selectedRunId && purgedRunIds.includes(selectedRunId)) {
      setSelectedRunId(undefined);
      setSelectedJobId(undefined);
      setLoadError(undefined);
    }
  }, [selectedRunId, purgedRunIds]);

  useEffect(() => {
    let live = true;
    void listRuns(globalThis.fetch, view)
      .then((next) => {
        if (!live) return;
        addRuns(next);
        setLoadError(undefined);
      })
      .catch((error: unknown) => {
        if (live)
          setLoadError(
            error instanceof Error ? error.message : "Could not load runs"
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [addRuns, initialSelection.runId, view]);
  useEffect(() => {
    if (!selectedRunId || creating) return;
    let live = true;
    void getRunJobs(selectedRunId)
      .then((value) => {
        if (!live) return;
        addRunSnapshot(value);
        setLoadError(undefined);
        setSelectedJobId(
          (selected) => selected ?? preferredConversation(value.jobs)?.id
        );
      })
      .catch((error: unknown) => {
        if (live)
          setLoadError(
            error instanceof Error ? error.message : "Could not load run"
          );
      });
    return () => {
      live = false;
    };
  }, [selectedRunId, creating, addRunSnapshot]);

  useEffect(() => {
    if (jobs.length === 0) return;
    // Native State may arrive before the REST snapshot containing a selected archive.
    setSelectedJobId((selected) => selected ?? preferredConversation(jobs)?.id);
  }, [jobs]);

  const handleSpecialistState = useCallback(
    (state: SpecialistChatState) => {
      if (!state.job) return;
      addJob(state.job);
    },
    [addJob]
  );

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId),
    [jobs, selectedJobId]
  );

  const selectedConversation = useMemo(
    () =>
      conversations(jobs).find((c) =>
        c.attempts.some((a) => a.id === selectedJobId)
      ),
    [jobs, selectedJobId]
  );
  const draftKey = selectedJob
    ? `${selectedJob.runId}:${selectedJob.logicalThreadId ?? selectedJob.id}`
    : "";
  const updateDraft = (value: string, expected?: string) =>
    setDrafts((current) => {
      if (expected !== undefined && (current[draftKey] ?? "") !== expected)
        return current;
      const next = { ...current };
      if (value) next[draftKey] = value;
      else delete next[draftKey];
      return next;
    });
  const navigate = (runId?: string, jobId?: string, replace = false) => {
    const query = new URLSearchParams();
    if (runId) query.set("run", runId);
    if (jobId) query.set("job", jobId);
    const path = query.size ? `/?${query}` : "/";
    if (window.location.pathname + window.location.search !== path)
      window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setSelectedRunId(runId);
    setSelectedJobId(jobId);
    setCreating(!runId);
  };
  useEffect(() => {
    const back = () => {
      const next = parseChatSelection(window.location.search);
      setSelectedRunId(next.runId);
      setSelectedJobId(next.jobId);
      setCreating(!next.runId);
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    if (!creating && selectedRunId && selectedJobId) {
      const query = new URLSearchParams({
        run: selectedRunId,
        job: selectedJobId
      });
      if (window.location.search !== `?${query}`)
        window.history.replaceState(null, "", `/?${query}`);
    }
  }, [creating, selectedRunId, selectedJobId]);
  const selectJob = (id: string) => navigate(selectedRunId, id);

  const selectRun = (runId: string) =>
    navigate(
      runId,
      preferredConversation(allJobs.filter((j) => j.runId === runId))?.id
    );

  const created = async (run: UIRun, rootJob: UIJob) => {
    navigate(run.id, rootJob.id);
    addRunSnapshot({ run, jobs: [rootJob] });
    setSelectedRunId(run.id);
    setSelectedJobId(rootJob.id);
    setCreating(false);
  };

  return (
    <>
      <RunTree
        runs={visibleRuns}
        attentionIds={attentionIds}
        jobs={jobs.filter((job) => job.tool !== "native_discovery")}
        selectedRunId={creating ? undefined : selectedRunId}
        selectedJobId={selectedJobId}
        onSelectRun={selectRun}
        onSelectJob={selectJob}
      />
      <main className="workspace grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden min-[760px]:grid-rows-[minmax(0,1fr)]">
        <div className="mobile-bar flex items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 py-2 min-[760px]:hidden">
          <Sidebar.Trigger aria-label="Open navigation" />
          <Text bold>PentCloud</Text>
          <DashboardButton
            ariaLabel="Open dashboard"
            run={selectedRun}
            jobId={selectedJobId}
            jobs={jobs}
          />
        </div>
        {loading ? (
          <CenterNotice title="Loading control room…" />
        ) : loadError && runs.length === 0 ? (
          <CenterNotice title="Control room unavailable" detail={loadError} />
        ) : creating ? (
          <TargetLibrary onCreated={created} runs={runs} />
        ) : (
          <section className="run-workspace flex h-full min-h-0 flex-col">
            {selectedRun &&
              ["discovery", "setup"].includes(selectedRun.phase ?? "") && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    void cancelRun(selectedRun.id)
                      .then(() => getRunJobs(selectedRun.id))
                      .then(addRunSnapshot)
                      .catch((error) => setLoadError(String(error)));
                  }}
                >
                  Stop run
                </Button>
              )}

            {selectedRun &&
            ["discovery", "setup"].includes(selectedRun.phase ?? "") ? (
              <RunSetup
                key={"setup:" + selectedRun.id}
                run={selectedRun}
                jobs={jobs}
                onActivated={created}
              />
            ) : selectedJob?.tool === "native_discovery" ? (
              <CenterNotice
                title="Initial discovery"
                detail="Discovery has no model chat. Inspect its recorded progress and accepted files, or select the primary agent."
              />
            ) : selectedJob ? (
              <div className="chat-with-discovery flex min-h-0 flex-1 flex-col">
                {selectedRun && (
                  <ChatDiscovery
                    key={selectedRun.id}
                    run={selectedRun}
                    jobs={jobs}
                    onRefresh={async () => {
                      addRunSnapshot(await getRunJobs(selectedRun.id));
                    }}
                  />
                )}
                <Suspense
                  fallback={<CenterNotice title="Opening specialist chat…" />}
                >
                  <SpecialistChat
                    key={selectedJob.id}
                    canStopRun={!!selectedRun && !runHasFinished(selectedRun)}
                    job={selectedJob}
                    draft={drafts[draftKey] ?? ""}
                    onDraftChange={updateDraft}
                    onAttentionChange={setAgentAttention}
                    displayName={selectedConversation?.label}
                    task={selectedConversation?.task}
                    peers={jobs}
                    onSelectConversation={selectJob}
                    readOnly={
                      !selectedRun ||
                      (selectedRun.lifecycle ?? "active") !== "active"
                    }
                    attempts={threadAttempts(jobs, selectedJob)}
                    onSelect={selectJob}
                    onRevision={(job) => {
                      if (job) {
                        addJob(job);
                        if (
                          selectionRef.current.runId === selectedRunId &&
                          selectionRef.current.jobId === selectedJob.id
                        )
                          selectJob(job.id);
                      } else if (selectedRunId) {
                        void getRunJobs(selectedRunId).then(addRunSnapshot);
                      }
                    }}
                    onState={handleSpecialistState}
                  />
                </Suspense>
              </div>
            ) : (
              <CenterNotice
                title={
                  loadError
                    ? "Run unavailable"
                    : visibleRuns.length === 0
                      ? "No active runs"
                      : "Select a specialist"
                }
                detail={
                  loadError ??
                  (visibleRuns.length === 0
                    ? "Start a new run or restore a retained run from the Dashboard."
                    : "Choose a chat from the run tree.")
                }
              />
            )}
          </section>
        )}
      </main>
    </>
  );
}

function CenterNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="center-notice">
      <Text variant="heading3" as="h3">
        {title}
      </Text>
      {detail && <Text variant="secondary">{detail}</Text>}
    </div>
  );
}
