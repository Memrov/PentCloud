import {Badge,Button,Collapsible,Empty,Grid,GridItem,Link,LinkButton,Select,Surface,Tabs,Text} from "@cloudflare/kumo";
import {runName,runDate} from "../run-label";
import {Findings} from "../components/findings";
import Settings from "../settings/settings";
import {TargetLibrary} from "../onboarding/targets";
import {BountySettings} from "../onboarding/bounty-settings";
import {RunManagement} from "../components/run-management";
import {RunDeleteDialog,runDeletionDescription} from "../components/run-delete";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  ClockIcon,
  PulseIcon,
  GearSixIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { useCoordinatorRuns } from "../native-stream";
import { getRunJobs, listRuns, runMatchesView, type UIJob, type UIRun } from "../api";
import { chatPath, dashboardPath,dashboardHomePath, layoutRunGraph, parseDashboardLocation, type DashboardLocation } from "./model";
import { settingsPath } from "../settings/model";
import { RunMap } from "./run-map";
import { ThemeControl } from "../components/theme-control";
import { WorkflowTimeline } from "./workflow-timeline";

export default function Dashboard() {
  const route = parseDashboardLocation(window.location.pathname);
  if (route.kind === "not-found") return <DashboardNotFound />;
  if (route.kind === "home") return <DashboardHome />;
  return <RunDashboard route={route} />;
}

function DashboardHome() {
  const { runs, loading, error,refresh:refreshInventory,forgetRun } = useRuns("all");
  const [deleteRun,setDeleteRun]=useState<UIRun>(),[deleteOpen,setDeleteOpen]=useState(false);
  const query=new URLSearchParams(location.search),returnChat=chatPath(query.get("run")??undefined,query.get("job")??undefined);
  const [tab,setTab]=useState(new URLSearchParams(location.search).get("view")??"overview"),[runFilter,setRunFilter]=useState("retained");
  const visible=runs.filter(r=>runFilter==="retained"?!["trashed","purging"].includes(r.lifecycle??"active"):runMatchesView(r,runFilter as import("../api").RunView));
  const active = runs.filter((run) => ["created", "provisioning", "running", "waiting"].includes(run.status)).length;
  const completed = runs.filter((run) => run.status === "completed").length;
  const failed = runs.filter((run) => ["failed", "invalid_result", "integration_failed", "interrupted"].includes(run.status)).length;
  return (
    <div className="dashboard-shell">
      <DashboardHeader />
      <main className="dashboard-scroll" aria-busy={loading}>
        <div className="dashboard-page">
          {tab==="overview"?<header className="dashboard-page-heading">
            <div><span className="dashboard-kicker"><PulseIcon size={14} /> Operations</span><h1>Dashboard</h1><p>Findings, targets, runs and agent settings.</p></div>
            <LinkButton variant="primary" href={returnChat}><ChatCircleDotsIcon size={16} /> Open chats</LinkButton>
          </header>:<header className="flex items-center justify-between gap-3"><Text as="h1" variant="heading2">Dashboard</Text><LinkButton variant="ghost" href={returnChat}><ChatCircleDotsIcon size={16}/>Open chats</LinkButton></header>}
          <Tabs aria-label="Dashboard sections" value={tab} onValueChange={value=>{setTab(value);const u=new URL(location.href);u.searchParams.set("view",value);history.replaceState(null,"",u);}} tabs={[{value:"overview",label:"Overview"},{value:"findings",label:"Findings"},{value:"targets",label:"Targets"},{value:"bounty",label:"Bug bounty"},{value:"settings",label:"Settings"}]}/>
          {tab==="findings"?<Findings runs={runs} inventoryLoading={loading} inventoryError={error} onRefresh={refreshInventory} initialTarget={new URLSearchParams(location.search).get("target")??undefined}/>:tab==="targets"?<TargetLibrary runs={runs} onCreated={(run,job)=>location.assign(chatPath(run.id,job.id))}/>:tab==="bounty"?<BountySettings/>:tab==="settings"?<Settings embedded/>:<>
          <section aria-label="Run summary"><Grid variant="side-by-side" gap="sm" className="lg:grid-cols-4">
            <StatCard label="Total runs" value={runs.length} icon={<ClockIcon size={18} />} />
            <StatCard label="Active" value={active} icon={<PulseIcon size={18} />} accent="active" />
            <StatCard label="Completed" value={completed} icon={<CheckCircleIcon size={18} />} accent="complete" />
            <StatCard label="Needs attention" value={failed} icon={<WarningCircleIcon size={18} />} {...(failed ? { accent: "failed" } : {})} />
          </Grid></section>
          <section className="dashboard-run-list" aria-label="Runs">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Recent runs</span><h2>Specialist workspaces</h2></div><Select label="Show runs" renderValue={value=>({retained:"All retained",active:"Active",archived:"Archived",trash:"Trash"}[String(value)]??"All retained")} value={runFilter} onValueChange={value=>setRunFilter(String(value??"retained"))}>{[{id:"retained",label:"All retained"},{id:"active",label:"Active"},{id:"archived",label:"Archived"},{id:"trash",label:"Trash"}].map(x=><Select.Option key={x.id} value={x.id}>{x.label}</Select.Option>)}</Select></div>
            <Text variant="secondary">{runDeletionDescription}</Text>
            {loading ? <DashboardNotice title="Loading runs…" />
              : error && runs.length === 0 ? <DashboardNotice title="Dashboard unavailable" detail={error} />
              : runs.length === 0 ? <DashboardNotice title="No runs yet" detail="Choose a saved target and start discovery. Your run will appear here." />
              : visible.length===0 ? <DashboardNotice title="No runs in this view" detail="Choose another filter. Runs awaiting deletion are in Trash." />
              : visible.map((run) => <RunCard key={run.id} run={run} onDelete={()=>{setDeleteRun(run);setDeleteOpen(true);}} />)}
          </section></>}
        </div>
      </main>
      {deleteRun&&<RunDeleteDialog runId={deleteRun.id} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={id=>{forgetRun(id);refreshInventory();}}/>}
    </div>
  );
}

function RunDashboard({ route }: { route: Exclude<DashboardLocation, { kind: "home" } | { kind: "not-found" }> }) {
  const { runs, jobs: allJobs, addRunSnapshot } = useCoordinatorRuns();
  const run = runs.find(run => run.id === route.runId);
  const jobs = useMemo(() => allJobs.filter(job => job.runId === route.runId), [allJobs, route.runId]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setLoading(true);
    void getRunJobs(route.runId).then((value) => {
      if (!live) return;
      addRunSnapshot(value);
      setError(undefined);
    }).catch((caught: unknown) => {
      if (live) setError(caught instanceof Error ? caught.message : "Could not load run");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [route.runId, addRunSnapshot]);
  const selectedJob = route.kind === "job" ? jobs.find((job) => job.id === route.jobId) : undefined;
  const layout = useMemo(() => layoutRunGraph(jobs), [jobs]);
  const active = jobs.filter((job) => ["created", "provisioning", "running"].includes(job.status)).length;
  return (
    <div className="dashboard-shell">
      <DashboardHeader {...(run ? { run } : {})} {...(selectedJob ? { selectedJob } : {})} />
      <main className="dashboard-scroll">
        {run&&<RunManagement run={run} jobs={jobs} onChanged={()=>{void getRunJobs(run.id).then(addRunSnapshot);}} onDeleted={()=>location.assign(dashboardPath())}/>}

        <div className="dashboard-run-page">
          <header className="dashboard-run-heading">
            <div>
              <Link variant="plain" className="flex w-fit items-center gap-2" href={dashboardPath()}><ArrowLeftIcon size={14} /> All runs</Link>
              <span className="dashboard-kicker">Run map</span>
              <h1>{run?runName(run):"Assessment"}</h1>
              <p>{jobs.length} specialists · {active} active · {run?.status ?? "loading"}</p>
            </div>
            <div className="dashboard-heading-actions">
              <StatusPill status={run?.status ?? "created"} />
              <LinkButton variant="secondary" href={chatPath(route.runId, selectedJob?.id)}>Open chats</LinkButton>
            </div>
          </header>
          {loading ? <DashboardNotice title="Loading run map…" />
            : error && !run ? <DashboardNotice title="Run unavailable" detail={error} />
            : jobs.length === 0 ? <DashboardNotice title="No specialists found" />
            : (
              <div className={`dashboard-workspace-grid ${selectedJob ? "has-inspector" : ""}`}>
                <div className="dashboard-map-card"><RunMap layout={layout} {...(selectedJob ? { selectedJobId: selectedJob.id } : {})} /></div>
                {route.kind === "job" && !selectedJob ? <DashboardNotice title="Specialist unavailable" detail="It may have been removed from this run." />
                  : selectedJob ? <WorkflowTimeline job={selectedJob} />
                  : <DashboardInspectorEmpty runId={route.runId} jobs={jobs} />}
              </div>
            )}
        </div>
      </main>
    </div>
  );
}

function DashboardHeader({ run, selectedJob }: { run?: UIRun; selectedJob?: UIJob }) {
  const query=new URLSearchParams(location.search),runId=run?.id??query.get("run")??undefined,jobId=selectedJob?.id??query.get("job")??undefined;
  return (
    <header className="dashboard-topbar">
      <Link variant="plain" className="dashboard-brand" href={dashboardPath()}><Text bold>PentCloud</Text></Link>
      <nav aria-label="Product navigation">
        <LinkButton variant="ghost" aria-label="Chats" href={chatPath(runId,jobId)}><ChatCircleDotsIcon size={16} /> <span className="hidden min-[721px]:inline">Chats</span></LinkButton>
        <LinkButton variant="secondary" aria-label="Dashboard" href={dashboardHomePath(runId,jobId,run?.target?.id)}><PulseIcon size={16} /> <span className="hidden min-[721px]:inline">Dashboard</span></LinkButton>

        <ThemeControl className="dashboard-icon-button" />
      </nav>
    </header>
  );
}

function RunCard({ run,onDelete }: { run: UIRun;onDelete:()=>void }) {
  return <Surface className="grid min-w-0 gap-3 rounded-lg px-4 py-3 ring ring-kumo-line">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <Link className="min-w-0 break-words" href={dashboardPath(run.id)}><Text bold>{runName(run)}</Text></Link>
      <StatusPill status={run.status}/>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2"><Text variant="secondary">{runDate(run)}</Text><div className="flex flex-wrap gap-2"><LinkButton variant="ghost" href={chatPath(run.id)}>View conversations</LinkButton><Button variant="secondary" aria-label={`Delete run ${run.id}`} onClick={onDelete}>Delete run</Button></div></div>
    <Collapsible><Collapsible.DefaultTrigger>Run details</Collapsible.DefaultTrigger><Collapsible.DefaultPanel className="grid gap-2 break-all"><Text>{run.id}</Text><Text variant="secondary">Source: {run.baselineRepo} · {shortCommit(run.inputCommit)}</Text><Link href={dashboardPath(run.id)}>Open run map</Link></Collapsible.DefaultPanel></Collapsible>
  </Surface>;
}

function StatCard({ label, value, icon, accent }: { label: string; value: number; icon: React.ReactNode; accent?: string }) {
  return <GridItem><Surface className="dashboard-stat flex items-center gap-3 rounded-lg px-4 py-3 ring ring-kumo-line"><span>{icon}</span><div><Text as="span" variant="heading2">{value}</Text><Text variant="secondary">{label}</Text></div></Surface></GridItem>;
}

function StatusPill({ status }: { status: string }) {
  return <Badge appearance="dot" variant={status==="completed"?"success":["failed","invalid_result","integration_failed","interrupted"].includes(status)?"error":status==="waiting"?"warning":"neutral"} className="text-base">{status}</Badge>;
}

function DashboardInspectorEmpty({ runId, jobs }: { runId: string; jobs: UIJob[] }) {
  return (
    <aside className="dashboard-inspector-empty">
      <PulseIcon size={26} />
      <strong>Select a specialist</strong>
      <p>Open a node to inspect its execution phases and timing.</p>
      {jobs[0] && <LinkButton variant="primary" href={dashboardPath(runId, jobs[0].id)}>Inspect primary</LinkButton>}
    </aside>
  );
}

function DashboardNotice({ title, detail }: { title: string; detail?: string }) {
  return <Empty title={title} {...(detail?{description:detail}:{})}/>;
}

function DashboardNotFound() {
  return <div className="dashboard-shell"><DashboardHeader /><main className="dashboard-scroll"><DashboardNotice title="Dashboard page not found" detail="Return to all runs or the chat board." /></main></div>;
}

function useRuns(view:import("../api").RunView="active"): { runs: UIRun[]; loading: boolean; error?: string;refresh:()=>void;forgetRun:(id:string)=>void } {
  const { runs, addRuns,purgeRun:forgetRun } = useCoordinatorRuns();
  const [refreshVersion,setRefreshVersion]=useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;setLoading(true);
    void listRuns(globalThis.fetch,view).then((value) => { if (live) { addRuns(value); setError(undefined); } })
      .catch((caught: unknown) => { if (live) setError(caught instanceof Error ? caught.message : "Could not load runs"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [addRuns,view,refreshVersion]);
  return { forgetRun,refresh:()=>setRefreshVersion(n=>n+1),runs: runs.filter(run => runMatchesView(run, view)), loading, ...(error ? { error } : {}) };
}

function shortCommit(value: string): string {
  return value.length > 10 ? value.slice(0, 10) : value;
}
