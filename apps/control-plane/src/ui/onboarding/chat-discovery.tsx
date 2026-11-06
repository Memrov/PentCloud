import { Banner, Button, Collapsible, Loader } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { UIJob, UIRun } from "../api";
import { action } from "./api";
import { DiscoveryProgress } from "./discovery-progress";

/** Coordinator projections only: refreshing never contacts Kali. */
export function ChatDiscovery({run,jobs,onRefresh}:{run:UIRun;jobs:UIJob[];onRefresh:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState<string>();
  const discovery=jobs.filter(job=>job.tool==="native_discovery");
  const failed=discovery.some(job=>["failed","invalid_result","integration_failed","interrupted"].includes(job.status));
  if(!discovery.length || run.discoveryDrained && (!failed || run.discoveryAcknowledged))return null;
  const perform=async(ack=false)=>{
    setBusy(true);setError(undefined);
    try{if(ack)await action("discovery.acknowledge",{runId:run.id});await onRefresh();}
    catch(e){setError(e instanceof Error?e.message:"Could not refresh discovery");}
    finally{setBusy(false);}
  };
  const finishing=discovery.every(job=>job.status==="completed");
  const queued=discovery.every(job=>job.status==="created");
  const status=failed?"Discovery needs attention":finishing?"Finishing discovery":queued?"Waiting for discovery to start":"Discovery is starting or running";
  return <div className="chat-discovery border-b border-kumo-line px-4 py-2 text-base"><Collapsible>
    <Collapsible.Trigger render={<Button variant="ghost"/>} aria-label="Discovery status and details">
      {failed?<WarningCircleIcon size={16}/>:<Loader size="sm" aria-label="Discovery in progress"/>}<span>{status}</span><span>Details</span>
    </Collapsible.Trigger><Collapsible.DefaultPanel>
    <DiscoveryProgress inChat jobs={discovery} settled={run.discoveryDrained===true} failed={failed} refreshing={busy} onRefresh={()=>void perform()} />
    </Collapsible.DefaultPanel></Collapsible><div className="chat-discovery-actions">
    {failed&&<Button variant="secondary" disabled={busy||!run.discoveryDrained} onClick={()=>void perform(true)}>Accept incomplete discovery & continue assessment</Button>}
    {error&&<Banner variant="error" role="alert" description={error}/>}
  </div></div>;
}
