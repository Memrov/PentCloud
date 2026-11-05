import {Banner,Button,Collapsible,Dialog,Text} from "@cloudflare/kumo";
import {useState} from "react";
import {archiveRun, cancelRun, getRunJobs, restoreRun, trashRun, type RunLifecycleResult, type UIJob, type UIRun} from "../api";
import {ReportButton} from './report-reader';
import {RunDeleteDialog,runDeletionDescription} from './run-delete';

export function RunManagement({run, jobs, onChanged, onDeleted}: {run: UIRun; jobs: UIJob[]; onChanged: (value: RunLifecycleResult) => void; onDeleted: () => void}) {
  const [pending, setPending] = useState(false);
  const [confirmOpen,setConfirmOpen]=useState(false),[deleteOpen,setDeleteOpen]=useState(false);
  const [error, setError] = useState<string>();
  const lifecycle = run.lifecycle ?? "active";
  const change = async (action: "archive" | "trash" | "restore" | "stop") => {
    if (pending) return;
    setPending(true); setError(undefined);
    try {
      if (action === "stop") {await cancelRun(run.id); onChanged(await getRunJobs(run.id));}
      else onChanged(await (action === "archive" ? archiveRun : action === "trash" ? trashRun : restoreRun)(run.id));
      setConfirmOpen(false);
    } catch (caught) {setError(caught instanceof Error ? caught.message : "Could not update run");}
    finally {setPending(false);}
  };
  return <><header className="run-management" aria-label="Manage run">
    <Collapsible className="run-details"><Collapsible.DefaultTrigger>Run details</Collapsible.DefaultTrigger><Collapsible.DefaultPanel>
    <div className="run-management-title"><strong>{run.id}</strong><span>{lifecycle === "trashed" ? "In Trash" : lifecycle === "purging" ? "Deletion in progress" : lifecycle === "archived" ? "Archived" : "Active"}</span></div>
    {!!run.target?.sources?.length&&<div className="source-context" aria-label="Pinned run sources"><p>Source commits for this run</p>{run.target.sources.map(source=><p key={source.id}>{source.origin??source.repo} · {source.branch} · <code title={source.commit}>{source.commit}</code></p>)}</div>}
    <div className="run-management-actions">
      {lifecycle === "active" && <Button variant="secondary" disabled={pending} onClick={() => void change("archive")}>Archive run</Button>}
      {(lifecycle === "archived" || lifecycle === "trashed") && <Button variant="secondary" disabled={pending} onClick={() => void change("restore")}>Restore run</Button>}
      {(lifecycle === "active" || lifecycle === "archived") && <Button variant="secondary" disabled={pending} onClick={() => {setError(undefined);setConfirmOpen(true);}}>Move run to Trash</Button>}
    </div>
    </Collapsible.DefaultPanel></Collapsible>
    {lifecycle === "active" && ["discovery", "setup"].includes(run.phase ?? "") && <Button variant="secondary" disabled={pending} onClick={() => void change("stop")}>Stop run</Button>}
    <ReportButton runId={run.id} jobs={jobs}/>
    <Button variant="secondary" disabled={pending} onClick={()=>setDeleteOpen(true)}>Delete run</Button>
    <Text variant="secondary">{runDeletionDescription}</Text>
    {error && !confirmOpen && <Banner variant="error" role="alert" description={error}/>}
  </header><Dialog.Root open={confirmOpen} onOpenChange={open=>{if(!pending)setConfirmOpen(open);}}><Dialog size="sm" className="grid gap-4">
    <Dialog.Title>Move run to Trash</Dialog.Title>
    <Dialog.Description>Move run “{run.id}” and all its specialist chats and files to Trash? Active execution will stop. Retained data can be restored.</Dialog.Description>
    {error&&<Banner variant="error" role="alert" description={error}/>}
    <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={pending} onClick={()=>setConfirmOpen(false)}>Keep run</Button><Button variant="primary" disabled={pending} onClick={()=>void change("trash")}>{pending?"Working…":"Move to Trash"}</Button></div>
  </Dialog></Dialog.Root><RunDeleteDialog runId={run.id} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={onDeleted}/></>;
}
