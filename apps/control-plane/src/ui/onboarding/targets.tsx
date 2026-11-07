import { Badge, Banner, Button, Checkbox, Dialog, Empty, Input, InputArea, Link, PoweredByCloudflare, Select, Text } from "@cloudflare/kumo";
import { GlobeIcon, PlusIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { APIError,createRun,parseRun,parseJob, type UIRun, type UIJob } from "../api";
import { MaterialAttachments, useMaterialDraft,dropMaterials,pasteMaterials } from "../components/materials";
import type { SavedTarget } from "../../native/onboarding";
import { action, snapshot,setupRequest, type OnboardingSnapshot } from "./api";
import {SourceContextEditor} from "./source-context";
import {ProgramPicker,TargetAccessEditor} from "./target-access";

const blank=()=>({id:"target-"+crypto.randomUUID(),kind:"website" as "website"|"api",name:"",url:"",objective:"",exclusions:""});
export function TargetLibrary({onCreated,runs=[]}:{onCreated:(run:UIRun,job:UIJob)=>void;runs?:UIRun[]}) {
  const [data,setData]=useState<OnboardingSnapshot>(),[selected,setSelected]=useState<SavedTarget>(),[draft,setDraft]=useState(blank);
  const [runObjective,setRunObjective]=useState("");
  const [programId,setProgramId]=useState<string>();
  const [editing,setEditing]=useState(true),[showArchived,setShowArchived]=useState(false),[authorized,setAuthorized]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),[deleting,setDeleting]=useState<SavedTarget>(),[deleteOpen,setDeleteOpen]=useState(false);
  const [starting,setStarting]=useState(false);
  const [runId]=useState(()=>{const id=new URLSearchParams(window.location.search).get("draft");return id&&/^run-[A-Za-z0-9._-]{1,48}$/.test(id)?id:"run-"+crypto.randomUUID();});
  const materials=useMaterialDraft(runId);
  const submission=useRef<Parameters<typeof createRun>[0]|undefined>(undefined);
  const refresh=async()=>{const value=await snapshot();setData(value);return value;};
  useEffect(()=>{let live=true;void(async()=>{
    const value=await snapshot();if(!live)return;setData(value);setEditing(value.targets.length===0);
    const params=new URLSearchParams(window.location.search),pendingId=params.get("draft");
    if(pendingId===runId){
      const pending=await setupRequest<{input?:import("../../native/types").NewRunInput;target?:SavedTarget;accepted?:{run:unknown;rootJob:unknown}}>("/onboarding/pending/"+encodeURIComponent(runId));
      if(!live)return;
      if(pending.accepted){onCreated(parseRun(pending.accepted.run),parseJob(pending.accepted.rootJob));return;}
      if(pending.input){
        submission.current={runId,task:pending.input.task,launchTime:pending.input.launch_time??new Date().toISOString(),targetId:pending.input.target_id!,targetRevision:pending.input.target_revision!,authorized:true,uploadIds:pending.input.upload_ids??[]};
        if(pending.target)choose(pending.target);setRunObjective(pending.input.task);setAuthorized(true);setNotice("Recovered the saved run request. Retry uses its original target, objective and files.");
      }else{
        const target=value.targets.find(t=>t.id===params.get("target"));if(target)choose(target);
      }
    }
  })().catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
  const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setError(undefined);try{await fn();}catch(e){setError(e instanceof Error?e.message:"Could not update target");}finally{setBusy(false);}};
  const choose=(target:SavedTarget)=>{setSelected(target);setDraft({...target});setProgramId(undefined);setRunObjective(target.objective||"Assess the security of "+target.url);setEditing(false);setAuthorized(false);setNotice(undefined);};
  const save=()=>perform(async()=>{
    let target=await action<SavedTarget>("target.save",{...draft,revision:selected?.id===draft.id?selected.revision:null});setSelected(target);
    if(programId)target=await action<SavedTarget>("scope.import",{id:target.id,revision:target.revision,programId});
    await refresh();choose(target);setNotice("Target saved. It is available for future runs.");
  });
  const lifecycle=(target:SavedTarget,verb:"archive"|"restore"|"delete")=>perform(async()=>{
    await action("target."+verb,{id:target.id,revision:target.revision});
    await refresh();if(selected?.id===target.id)setSelected(undefined);setDeleteOpen(false);
  });
  const start=()=>perform(async()=>{
    setStarting(true);try{
    if(!selected||!authorized)return;
    window.history.replaceState(null,"","/?draft="+encodeURIComponent(runId)+"&target="+encodeURIComponent(selected.id));
    if(submission.current){
      const pending=await setupRequest<{accepted?:{run:unknown;rootJob:unknown}}>("/onboarding/pending/"+encodeURIComponent(runId));
      if(pending.accepted){onCreated(parseRun(pending.accepted.run),parseJob(pending.accepted.rootJob));return;}
    }
    {
      const check=await action<{classification:string;redirectURL?:string}>("target.check",{id:selected.id,revision:selected.revision,requestId:"check-"+crypto.randomUUID()});
      if(!["reachable","needs-auth","path-review"].includes(check.classification)){
        setNotice(check.redirectURL?"The address redirects to "+check.redirectURL+". Review and save that address before starting.":"The address needs attention: "+check.classification);
        return;
      }
      submission.current??={runId,launchTime:new Date().toISOString(),targetId:selected.id,targetRevision:selected.revision,authorized:true,
        task:runObjective.trim()||"Assess the security of "+selected.url,
        uploadIds:materials.uploadIds};
    }
    try{const result=await createRun(submission.current);materials.draft.clear();onCreated(result.run,result.rootJob);}
    catch(error){if(error instanceof APIError&&[400,413,415,422,429].includes(error.status))submission.current=undefined;throw error;}
    }finally{setStarting(false);}
  });
  const visible=data?.targets.filter(t=>showArchived?t.archived:!t.archived)??[];
  return <section className="onboarding" aria-busy={!data||busy}>
    <header className="onboarding-heading"><div className="onboarding-title"><span className="onboarding-symbol"><GlobeIcon size={24}/></span><div><Text as="h1" variant="heading1">Your targets</Text><p>Choose a website or API you own or are authorized to test. PentCloud will check the address and prepare discovery.</p></div></div><Button variant="secondary" icon={<PlusIcon size={16}/>} disabled={busy||!!submission.current} onClick={()=>{setSelected(undefined);setDraft(blank());setProgramId(undefined);setAuthorized(false);setEditing(true);setNotice(undefined);}}>Add target</Button></header>
    {error&&!deleteOpen&&<p role="alert" className="onboarding-error">{error}{submission.current?" Retry sends the same run request.":""}</p>}
    {notice&&<Banner variant="secondary" role="status" description={notice}/>}
    <div className="onboarding-grid">
      <section className="onboarding-card" aria-label="Saved targets">
        <div className="onboarding-row"><h2>Saved targets</h2><Button variant="ghost" disabled={busy||!!submission.current} onClick={()=>setShowArchived(v=>!v)}>{showArchived?"Show active":"Show archived"}</Button></div>
        {!data?<p role="status">Loading targets…</p>:visible.length===0?<Empty size="sm" icon={<GlobeIcon size={24}/>} title={showArchived?"No archived targets":"Add your first target"} description="Targets stay here so you can run another assessment without entering everything again."/>:<div className="onboarding-targets">{visible.map(target=><article key={target.id} className={"onboarding-target "+(selected?.id===target.id?"is-selected":"")}><button disabled={busy||!!submission.current} onClick={()=>choose(target)}><strong>{target.name}</strong><span>{target.url}</span><Badge variant="secondary">{target.kind==="api"?"API":"Website"}</Badge></button><div className="onboarding-row"><Button variant="ghost" disabled={busy||!!submission.current} onClick={()=>void lifecycle(target,target.archived?"restore":"archive")}>{target.archived?"Restore":"Archive"}</Button><Button variant="ghost" disabled={busy||!!submission.current} onClick={()=>{setDeleting(target);setDeleteOpen(true);}}>Delete</Button></div></article>)}</div>}
      </section>
      <section className={"onboarding-card "+(editing?"order-first min-[761px]:order-none":"")} aria-label="Target setup">
        {editing?<form className="onboarding-form" onSubmit={e=>{e.preventDefault();void save();}}>
          <h2>{selected?"Edit target":"Add a target"}</h2>
          <ProgramPicker targetURL={draft.url} disabled={busy} perform={perform} onPick={(id,url)=>{setProgramId(id);if(url)setDraft({...draft,url});setNotice("Program selected. Saving verifies the address and imports its exclusions.");}}/>
          <Select label="Target type" aria-label="Target type" required renderValue={value=>value==="api"?"API":"Website"} value={draft.kind} disabled={busy} onValueChange={value=>setDraft({...draft,kind:value as "website"|"api"})}><Select.Option value="website">Website</Select.Option><Select.Option value="api">API</Select.Option></Select>
          <Input label="Name" value={draft.name} onValueChange={name=>setDraft({...draft,name})} disabled={busy} placeholder="Name this target"/>
          <Input label={draft.kind==="api"?"API base address":"Website address"} value={draft.url} onValueChange={url=>setDraft({...draft,url})} disabled={busy} placeholder={draft.kind==="api"?"Enter the full API base address":"Enter the full website address"}/>
          <InputArea label="What should PentCloud investigate?" rows={3} value={draft.objective} onValueChange={objective=>setDraft({...draft,objective})} disabled={busy} placeholder="Optional: important areas or concerns"/>
          <InputArea label="Exclusions" rows={2} value={draft.exclusions} onValueChange={exclusions=>setDraft({...draft,exclusions})} disabled={busy} placeholder="Optional guidance for the agents"/>
          <p>Saving a target does not contact it. Its API base path, scheme and port are preserved.</p>
          <Button variant="primary" type="submit" disabled={busy||!draft.name.trim()||!draft.url.trim()}>{busy?"Saving…":"Save target"}</Button>
        </form>:selected?<div className="onboarding-form" onPaste={e=>pasteMaterials(e,materials.draft,busy||!!submission.current)} onDragOver={e=>{if(e.dataTransfer.types.includes("Files"))e.preventDefault();}} onDrop={e=>dropMaterials(e,materials.draft,busy||!!submission.current)}>
          <div className="onboarding-row"><h2>{selected.name}</h2><Button variant="ghost" disabled={busy||!!submission.current} onClick={()=>setEditing(true)}>Edit</Button></div><p className="onboarding-address">{selected.url}</p>
          <ProgramPicker targetURL={selected.url} disabled={busy||!!submission.current||selected.archived} perform={perform} onPick={async(id,url)=>{if(url&&new URL(url).href!==selected.url)throw new Error("Edit the target address before importing a different program asset");await action("scope.import",{id:selected.id,revision:selected.revision,programId:id});const value=await refresh(),current=value.targets.find(t=>t.id===selected.id);if(current)choose(current);}}/>
          <TargetAccessEditor key={selected.id+":"+selected.revision} target={selected} disabled={busy||!!submission.current||selected.archived} perform={perform} onChanged={async()=>{const value=await refresh(),current=value.targets.find(t=>t.id===selected.id);if(current){setSelected(current);setDraft({...current});setAuthorized(false);setNotice("Target settings saved for future runs.");}}}/>
          <SourceContextEditor key={selected.id} target={selected} pending={data?.sourceImports??[]} disabled={busy||!!submission.current||selected.archived} perform={perform} onChanged={async()=>{const value=await refresh(),current=value.targets.find(t=>t.id===selected.id);if(current){setSelected(current);setDraft({...current});}}}/>
          <div className="onboarding-notice"><strong>{selected.access?"Review the scope":"Understand the network reach"}</strong><p>{selected.access?"Browser and managed HTTP requests use this target’s settings and imported exclusions. Scanner runtimes have direct Internet access; scope is not enforced there. Review the program’s current rules and confirm your permission before every assessment.":"Your target and exclusions guide the agents. They do not prevent every tool from contacting other hosts. Configure network and login settings to use managed target access."}</p></div>
          <Checkbox checked={authorized} disabled={busy||!!submission.current} onCheckedChange={setAuthorized} label="I own this project or have permission to test it, and understand the network reach risk."/>
          <InputArea label="Run objective" rows={3} value={runObjective} onValueChange={setRunObjective} disabled={busy||!!submission.current}/>
          <MaterialAttachments draft={materials.draft} files={materials.files} {...(materials.error?{error:materials.error}:{})} disabled={busy||!!submission.current}/>
          <p>The quick address check uses no model. Discovery may wait for the shared scanner to prepare. You can choose models and API test access while it runs.</p>
          <Button variant="primary" icon={<ArrowRightIcon size={16}/>} loading={starting} disabled={busy||!authorized||selected.archived||!materials.ready} onClick={()=>void start()}>{starting?"Checking and starting…":submission.current?"Retry the same run":"Verify address & start discovery"}</Button>
          <h3>Previous runs</h3>
          {runs.filter(r=>r.target?.id===selected.id).length?runs.filter(r=>r.target?.id===selected.id).map(r=><Link key={r.id} href={"/?run="+encodeURIComponent(r.id)}>{r.id} · {r.status}</Link>):<p>No runs for this target yet. Each new run gets fresh discovery and evidence.</p>}
        </div>:<Empty size="sm" icon={<GlobeIcon size={24}/>} title="Choose a saved target" description="Start a fresh run or add another website or API."/>}
      </section>
    </div>
    <footer className="onboarding-footer"><p>OpenCode and target login credentials can use Cloudflare secret bindings.</p><PoweredByCloudflare/></footer>
    <Dialog.Root open={deleteOpen} onOpenChange={setDeleteOpen} onOpenChangeComplete={open=>{if(!open)setDeleting(undefined);}}><Dialog size="sm" className="grid gap-4"><Dialog.Title>Delete saved target</Dialog.Title><Dialog.Description>Delete {deleting?.name??"this target"} from the library. Historical runs and their evidence remain available.</Dialog.Description>{error&&<Banner variant="error" role="alert" description={error}/>}<div className="onboarding-row"><Button variant="secondary" disabled={busy} onClick={()=>setDeleteOpen(false)}>Keep target</Button><Button variant="primary" disabled={busy} onClick={()=>{if(deleting)void lifecycle(deleting,"delete");}}>Delete target</Button></div></Dialog></Dialog.Root>
  </section>;
}
