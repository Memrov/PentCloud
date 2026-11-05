import {reconcileFormRevision} from "./form-revision";
import { DiscoveryProgress } from "./discovery-progress";
import { ExternalLink } from "../components/external-link";
import { Badge, Banner, Button, Checkbox, Collapsible, Dialog, Input, Select } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UIJob, UIRun } from "../api";
import { MODEL_ROLES,type ModelRole } from "../../native/onboarding-roles";
import type { ModelChoice, ModelProfile, SetupDraft, CredentialMetadata } from "../../native/onboarding";
import type { OpenCodeModel } from "../../native/opencode-models";
import { action, activate, canActivate, catalogs, snapshot, type OnboardingSnapshot } from "./api";
export function RunSetup({run,jobs,onActivated}:{run:UIRun;jobs:UIJob[];onActivated:(run:UIRun,job:UIJob)=>void}) {
  const [data,setData]=useState<OnboardingSnapshot>(),[models,setModels]=useState<OpenCodeModel[]>([]),[stale,setStale]=useState(false);
  const [keyVersion,setKeyVersion]=useState(0),[overrideKeys,setOverrideKeys]=useState<Partial<Record<ModelRole,{id:string;version:number}>>>({});
  const [conflict,setConflict]=useState(false),[catalogErrors,setCatalogErrors]=useState<string[]>([]);
  const [key,setKey]=useState(""),[defaultModel,setDefaultModel]=useState(""),[overrides,setOverrides]=useState<Partial<Record<ModelRole,string>>>({});
  const [publicAPI,setPublicAPI]=useState(true),[apiKey,setAPIKey]=useState("");
  const [endpoint,setEndpoint]=useState(""),[expectedStatus,setExpectedStatus]=useState("200"),[expectedText,setExpectedText]=useState("");
  const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),[ack,setAck]=useState(false),[revoking,setRevoking]=useState<CredentialMetadata>(),[revokeOpen,setRevokeOpen]=useState(false);
  const initialized=useRef(false),startRequest=useRef<string|undefined>(undefined),formRevision=useRef(0),dirtyRef=useRef(false),conflictRef=useRef(false);
  const receive=useCallback((next:OnboardingSnapshot,force=false)=>{
    const decision=reconcileFormRevision({revision:formRevision.current,dirty:dirtyRef.current,initialized:initialized.current},next.draft?.revision??0,force);
    if(decision==="hydrate"){
      initialized.current=true;formRevision.current=next.draft?.revision??0;dirtyRef.current=false;conflictRef.current=false;setDirty(false);setConflict(false);
      const d=next.draft,c=d?.profile?.default,bound=next.credentials.find(c=>c.id==="bound-go");
      setKey(c?.credentialId??bound?.id??"");setKeyVersion(c?.credentialVersion??bound?.version??0);
      setDefaultModel(c?.model??(bound?"opencode-go:deepseek-v4-pro":""));
      setOverrides(Object.fromEntries(Object.entries(d?.profile?.overrides??{}).map(([role,c])=>[role,c?.model])));
      setOverrideKeys(Object.fromEntries(Object.entries(d?.profile?.overrides??{}).map(([role,c])=>[role,c?{id:c.credentialId,version:c.credentialVersion}:undefined])));
      setPublicAPI(d?.publicAPI??true);setAPIKey(d?.apiCredential?.id??"");setEndpoint(d?.endpoint??run.target?.url??"");
      setExpectedStatus(String(d?.expectedStatus??200));setExpectedText(d?.expectedText??"");
    }else if(decision==="conflict"){conflictRef.current=true;setConflict(true);}
    setData(next);
  },[run.target?.url]);
  const refresh=useCallback(async()=>{const next=await snapshot(run.id);receive(next);return next;},[run.id,receive]);
  useEffect(()=>{
    let live=true;
    void Promise.all([snapshot(run.id),catalogs()]).then(([next,catalog])=>{
      if(!live)return;receive(next);setModels(catalog.models);setStale(catalog.stale);setCatalogErrors(catalog.failures);
    }).catch(e=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[run.id,receive]);
  const signature=jobs.map(j=>j.id+":"+j.status+":"+j.revision).join("|");
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[refresh,run.phase,run.discoveryDrained,signature]);
  const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setError(undefined);setNotice(undefined);try{await fn();}catch(e){setError(e instanceof Error?e.message:"Setup failed");}finally{setBusy(false);}};
  const edit=()=>{dirtyRef.current=true;setDirty(true);setNotice(undefined);};
  const selectedKey=data?.credentials.find(c=>c.id===key);
  const modelCredentials=data?.credentials.filter(c=>c.purpose==="model"&&!c.revoked)??[];
  const apiCredentials=data?.credentials.filter(c=>c.purpose==="api"&&c.targetId===run.target?.id&&c.audienceURL===run.target?.url&&!c.revoked)??[];
  const choice=(model:string,role?:ModelRole):ModelChoice=>{
    const inherited=role?overrideKeys[role]:undefined;
    if(inherited)return {model,credentialId:inherited.id,credentialVersion:inherited.version};
    if(!selectedKey)throw new Error("Configure or select an OpenCode secret in Cloudflare first");
    return {model,credentialId:selectedKey.id,credentialVersion:keyVersion};
  };
  const saveDraft=async()=>{
    if(conflictRef.current)throw new Error("Setup changed in another tab. Reload the saved setup before saving or testing.");
    const profile:ModelProfile|undefined=defaultModel&&selectedKey?{default:choice(defaultModel),overrides:Object.fromEntries(Object.entries(overrides).filter(([,id])=>!!id).map(([role,id])=>[role,choice(id!,role as ModelRole)]))}:undefined;
    const selectedAPI=apiCredentials.find(c=>c.id===apiKey);
    const draft={publicAPI,...(profile?{profile}:{}),...(!publicAPI&&selectedAPI?{apiCredential:{id:selectedAPI.id,version:selectedAPI.version}}:{}),
      ...(!publicAPI?{endpoint,expectedStatus:Number(expectedStatus),...(expectedText?{expectedText}:{})}:{})};
    const saved=await action<SetupDraft>("setup.save",{runId:run.id,revision:formRevision.current,draft});
    formRevision.current=saved.revision;dirtyRef.current=false;setDirty(false);setData(old=>old?{...old,draft:saved}:old);return {saved,profile};
  };
  const testModels=()=>perform(async()=>{
    const current=await catalogs(true);setModels(current.models);setStale(current.stale);setCatalogErrors(current.failures);
    const {profile}=await saveDraft();if(!profile)throw new Error("Choose a default model and OpenCode key");
    const choices=[profile.default,...Object.values(profile.overrides)],unique=new Map(choices.map(c=>[JSON.stringify(c),c!]));
    for(const selected of unique.values()){
      setNotice("Testing "+(models.find(m=>m.id===selected.model)?.name??selected.model)+"…");
      await action("model.test",{choice:selected,requestId:"model-test-"+crypto.randomUUID()});
    }
    await refresh();setNotice("Selected OpenCode models passed the native connection test.");
  });
  const testAPI=()=>perform(async()=>{await saveDraft();await action("api.test",{runId:run.id,requestId:"api-test-"+crypto.randomUUID()});await refresh();setNotice("Protected API access verified. Scanner authentication support varies by tool.");});
  const start=()=>perform(async()=>{
    if(dirtyRef.current||conflictRef.current||data?.draft?.revision!==formRevision.current)throw new Error("Reload or save and test the displayed configuration first");
    startRequest.current??="analysis-"+crypto.randomUUID();
    const result=await activate(run.id,formRevision.current,startRequest.current,ack,data?.definition?.version??0);onActivated(result.run,result.rootJob);
  });
  const liveDiscoveries=jobs.filter(j=>j.runId===run.id&&j.tool==="native_discovery");
  const discoveries=liveDiscoveries.length?liveDiscoveries:data?.discovery??[];
  const failed=discoveries.some(j=>["failed","invalid_result","integration_failed","interrupted"].includes(j.status));
  const ready=!!data&&canActivate(data)&&!dirty&&!conflict;
  return <section className="onboarding">
    <header className="onboarding-heading"><div><p>PentCloud assessment setup</p><h1>{run.target?.name??"Set up your run"}</h1><p className="onboarding-address">{run.target?.url}</p></div><Badge variant="secondary">{run.phase==="discovery"?"Discovery in progress":"Finish setup"}</Badge></header>
    <DiscoveryProgress jobs={discoveries} settled={data?.readiness?.discoverySettled===true} failed={failed} refreshing={busy} onRefresh={()=>void perform(async()=>{await refresh();})}>
      {failed&&<Checkbox checked={ack} onCheckedChange={setAck} label="I understand discovery was incomplete. Continue with that coverage gap once execution is safely settled."/>}
    </DiscoveryProgress>
    {conflict&&<div className="onboarding-error" role="alert"><p>Setup changed in another tab. Your edits have not been saved.</p><Button variant="secondary" disabled={busy} onClick={()=>void perform(async()=>{receive(await snapshot(run.id),true);setError(undefined);})}>Reload saved setup</Button></div>}{error&&!revokeOpen&&<Banner variant="error" role="alert" description={error}/>}{notice&&<Banner variant="secondary" role="status" description={notice}/>}
    <div className="onboarding-grid">
      <section className="onboarding-card onboarding-form" aria-label="OpenCode models">
        <h2>OpenCode models</h2><p>Use an OpenCode Console or Go key with permission to request models. Your OpenCode plan, privacy settings and budgets apply.</p>
        <Select label="OpenCode key" aria-label="OpenCode key" required value={key||null} disabled={busy} placeholder="Choose a Cloudflare secret" onValueChange={value=>{setKey(String(value??""));setKeyVersion(modelCredentials.find(c=>c.id===value)?.version??0);setOverrideKeys({});edit();}}>{modelCredentials.map(c=><Select.Option key={c.id} value={c.id}>{c.label}{c.missing?" · re-enter key":""}</Select.Option>)}</Select>
        <p>OpenCode keys are managed by Cloudflare. PentCloud stores the binding reference and test proof, never the key value.</p>
        <Collapsible><Collapsible.DefaultTrigger>Configure OpenCode in Cloudflare</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><p>In your app Worker, add an encrypted secret named <code>OPENCODE_GO_API_KEY</code> for Go or <code>OPENCODE_API_KEY</code> for Console. You can also bind an account Secrets Store secret using the same name. Deploy the change, then refresh setup.</p><ExternalLink href="https://dash.cloudflare.com/">Manage Cloudflare secrets</ExternalLink></Collapsible.DefaultPanel></Collapsible>
        <Button variant="ghost" disabled={busy} onClick={()=>void perform(async()=>{await refresh();})}>Refresh secret bindings</Button>
        <ModelSelect label="Default model" value={defaultModel} models={models} disabled={busy} onChange={value=>{setDefaultModel(value);edit();}}/>
        <Collapsible><Collapsible.DefaultTrigger>Choose models for individual agents</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="onboarding-form">{MODEL_ROLES.map(role=><ModelSelect key={role} label={role.charAt(0).toUpperCase()+role.slice(1)+" model"} value={overrides[role]??""} models={models} disabled={busy} inherit onChange={value=>{setOverrides({...overrides,[role]:value});setOverrideKeys({...overrideKeys,[role]:{id:key,version:keyVersion}});edit();}}/>)}</div></Collapsible.DefaultPanel></Collapsible>
        {stale&&<p className="onboarding-error">{catalogErrors.join("; ")||"Some catalog data is stale or unavailable."} Refresh the catalog; the server checks the selected model before testing.</p>}
        <p>Testing makes a small native OpenCode request and may use OpenCode credits. It does not contact your target.</p>
        <div className="onboarding-row"><Button variant="primary" disabled={busy||conflict||!key||!defaultModel||!!selectedKey?.revoked||!!selectedKey?.missing} onClick={()=>void testModels()}>Test selected models</Button><Button variant="ghost" disabled={busy} onClick={()=>void perform(async()=>{const next=await catalogs(true);setModels(next.models);setStale(next.stale);setCatalogErrors(next.failures);})}>Refresh catalog</Button></div>
        <p role="status">{data?.readiness?.modelsTested&&!dirty?"Models tested and ready":"Model connection tests required"}</p><ExternalLink href="https://opencode.ai/console">Manage OpenCode keys and plan</ExternalLink>
      </section>
      <section className="onboarding-card onboarding-form" aria-label="API test access">
        <h2>{run.target?.kind==="api"?"API test access":"Website test access"}</h2>
        {run.target?.kind!=="api"?<p>{run.target?.access?.loginConfigured?"Agents can fill the website's login form with Cloudflare-held credentials. Each run starts a fresh login; its agents reuse that run’s private browser state.":"Add optional Cloudflare login references in the saved target's network and login settings. This run uses the target settings captured when it started."}</p>:<>
          <Select label="Access type" aria-label="API access type" required value={publicAPI?"public":"authenticated"} disabled={busy} onValueChange={value=>{setPublicAPI(value==="public");edit();}}><Select.Option value="public">Public API / unauthenticated coverage</Select.Option><Select.Option value="authenticated">Authenticated API</Select.Option></Select>
          {!publicAPI&&<>
            {run.target.access?.apiConfigured?<Banner variant="secondary" description="This target uses its saved Cloudflare API credential binding. Test a protected endpoint below; key values stay in Cloudflare."/>:<>
            <Select label="Saved API key" aria-label="Saved API key" value={apiKey||null} placeholder="Choose a saved API key" disabled={busy} onValueChange={value=>{setAPIKey(String(value??""));edit();}}>{apiCredentials.map(c=><Select.Option key={c.id} value={c.id}>{c.label}{c.missing?" · re-enter key":""}</Select.Option>)}</Select>
            <Banner variant="secondary" description="For new credentials, configure Cloudflare API authentication in the saved target’s settings, then start a fresh run to use it. Existing saved keys remain available above."/>
            <Button variant="ghost" disabled={busy||!apiKey} onClick={()=>{setRevoking(apiCredentials.find(c=>c.id===apiKey));setRevokeOpen(true);}}>Revoke selected API key</Button>
            </>}
            <Input label="Protected read-only test endpoint" value={endpoint} onValueChange={value=>{setEndpoint(value);edit();}} disabled={busy}/>
            <Input label="Expected success status" value={expectedStatus} onValueChange={value=>{setExpectedStatus(value);edit();}} disabled={busy}/>
            <Input label="Response must contain (optional)" value={expectedText} onValueChange={value=>{setExpectedText(value);edit();}} disabled={busy}/>
            <p>The test compares an anonymous GET with an authenticated GET. A public 200 response alone does not prove the key works.</p>
            <Button variant="secondary" disabled={busy||!apiKey&&!run.target.access?.apiConfigured||!endpoint} onClick={()=>void testAPI()}>Test protected API access</Button>
          </>}
          <p>Saved keys are injected by the API request tool. Most stock scanners do not accept arbitrary authorization headers; reports must distinguish authenticated requests from unauthenticated scanner coverage.</p>
        </>}
        {run.target?.kind==="api"&&<DefinitionUpload targetId={run.target.id} version={data?.definition?.version??0} disabled={busy} onSaved={refresh}/>}
        <Button variant="secondary" disabled={busy||conflict||!dirty} onClick={()=>void perform(async()=>{await saveDraft();await refresh();setNotice("Setup saved.");})}>Save setup</Button>
        <p role="status">{data?.readiness?.apiTested&&!dirty?"API access choice ready":"Save your access choice and test required credentials"}</p>
      </section>
    </div>
    <footer className="onboarding-card onboarding-row"><div><h2>Open your chat</h2><p>Chat uses OpenCode credits and pins this configuration. You can discuss your project and read supplied files while discovery runs. Assessment tools become available after discovery safely finishes.</p></div><Button variant="primary" disabled={busy||!ready} onClick={()=>void start()}>{busy?"Working…":"Open chat"}</Button></footer>
    <Dialog.Root open={revokeOpen} onOpenChange={setRevokeOpen} onOpenChangeComplete={open=>{if(!open)setRevoking(undefined);}}><Dialog size="sm" className="grid gap-4"><Dialog.Title>Revoke saved credential</Dialog.Title><Dialog.Description>Stop future use of {revoking?.label??"this credential"} in every run using it. Already sent requests cannot be retracted.</Dialog.Description>{error&&<Banner variant="error" role="alert" description={error}/>}<div className="onboarding-row"><Button variant="secondary" disabled={busy} onClick={()=>setRevokeOpen(false)}>Keep credential</Button><Button variant="primary" disabled={busy} onClick={()=>void perform(async()=>{await action("credential.revoke",{id:revoking!.id,revision:revoking!.version});setRevokeOpen(false);edit();await refresh();})}>Revoke credential</Button></div></Dialog></Dialog.Root>
  </section>;
}
function ModelSelect({label,value,onChange,models,disabled,inherit=false}:{label:string;value:string;onChange:(value:string)=>void;models:OpenCodeModel[];disabled:boolean;inherit?:boolean}) {
  return <Select label={label} aria-label={label} required={!inherit} value={value||null} placeholder={inherit?"Use default model":"Choose an OpenCode model"} onValueChange={value=>onChange(String(value??""))} disabled={disabled} renderValue={selected=>models.find(model=>model.id===selected)?.name??String(selected||"Use default model")}>
    {inherit&&<Select.Option value="">Use default model</Select.Option>}
    {value&&!models.some(model=>model.id===value)&&<Select.Option value={value}>Saved model: {value}</Select.Option>}
    {(["go","console"] as const).map(route=><Select.Group key={route}><Select.GroupLabel>{route==="go"?"OpenCode Go":"OpenCode Console"}</Select.GroupLabel>{models.filter(model=>model.route===route).map(model=><Select.Option key={model.id} value={model.id}>{model.name}</Select.Option>)}</Select.Group>)}
  </Select>;
}
function DefinitionUpload({targetId,disabled,version,onSaved}:{targetId?:string;disabled:boolean;version:number;onSaved:()=>Promise<unknown>}) {
  const [message,setMessage]=useState(""),[pending,setPending]=useState(false);
  return <div className="onboarding-form"><h3>Reusable API definition</h3><p>Optional JSON or YAML, up to 2 MiB. Remove secrets first. Definitions become audited input files in each new run and remain in Git history.</p><input type="file" aria-label="API definition file" accept=".json,.yaml,.yml" disabled={disabled||pending||!targetId} onChange={e=>{
    const file=e.target.files?.[0];if(!file)return;e.target.value="";
    void(async()=>{setPending(true);try{if(file.size>2*1024*1024)throw new Error("Definition exceeds 2 MiB");const sha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,"0")).join("");const response=await fetch("/v1/ui/targets/"+encodeURIComponent(targetId!)+"/definition?name="+encodeURIComponent(file.name),{method:"POST",body:file,headers:{"Content-Type":"application/octet-stream","X-Content-SHA256":sha256,"If-Match":String(version)}});const value=await response.json() as {error?:string};if(!response.ok)throw new Error(value.error??"Definition upload failed");await onSaved();setMessage("Definition saved: "+file.name+". It will be copied into this run when analysis starts.");}catch(e){setMessage(e instanceof Error?e.message:"Definition upload failed");}finally{setPending(false);}})();
  }}/><p role="status">{pending?"Saving definition…":message}</p></div>;
}
