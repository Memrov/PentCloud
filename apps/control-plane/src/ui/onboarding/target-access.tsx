import {useEffect,useRef,useState} from "react";
import {Badge,Banner,Button,Checkbox,Collapsible,Combobox,InlineCopyText,Input,Select,Text} from "@cloudflare/kumo";
import type {SavedTarget} from "../../native/onboarding";
import {targetSecretBindings} from "../../../../../shared/target-access";
import {ExternalLink} from "../components/external-link";
import {action} from "./api";
type Perform=(fn:()=>Promise<void>)=>Promise<void>;
type Summary={id:string;name:string;platform:string};
type Preview={program:Summary&{url:string};assets:{value:string;type:string}[]};

export function ProgramPicker({disabled,onPick,perform,targetURL=""}:{disabled:boolean;targetURL?:string;onPick:(id:string,url?:string)=>void|Promise<void>;perform:Perform}){
 const [programs,setPrograms]=useState<Summary[]>([]),[selected,setSelected]=useState<Summary|null>(null),[info,setInfo]=useState<Preview>(),[asset,setAsset]=useState(""),[concrete,setConcrete]=useState(""),[loadState,setLoadState]=useState("idle");
 const loading=useRef(false),choice=useRef(0);
 const load=()=>{if(loading.current)return;loading.current=true;setLoadState("loading");void perform(async()=>{try{setPrograms((await action<{programs:Summary[]}>("scope.names",{})).programs);setLoadState("ready");}catch(error){loading.current=false;setLoadState("failed");throw error;}});};
 const choose=(program:Summary|null)=>{setSelected(program);setInfo(undefined);setAsset("");setConcrete("");const generation=++choice.current;if(program)void perform(async()=>{const preview=await action<Preview>("scope.preview",{programId:program.id});if(choice.current===generation)setInfo(preview);});};
 const value=asset.includes("*")?concrete:asset;
 return <Collapsible onOpenChange={open=>{if(open)load();}}><Collapsible.DefaultTrigger>Find a bounty program</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid gap-4 py-3">
  <Combobox items={programs} value={selected} onValueChange={choose} itemToStringLabel={p=>p.name+" · "+p.platform} isItemEqualToValue={(a,b)=>a.id===b.id} disabled={disabled} label="Program">
   <Combobox.TriggerInput placeholder="Search or browse programs"/>
   <Combobox.Content><Combobox.List>{(p:Summary)=><Combobox.Item key={p.id} value={p}>{p.name} · {p.platform}</Combobox.Item>}</Combobox.List><Combobox.Empty>{loadState==="failed"?"Programs unavailable. Close and reopen to retry.":loadState==="ready"?"No matching programs":"Loading programs…"}</Combobox.Empty></Combobox.Content>
  </Combobox>
  {info&&<>
   <ExternalLink href={info.program.url}>Review {info.program.name} rules</ExternalLink>
   <Select label="Website or API" placeholder={targetURL?"Keep the current target address":"Choose a target"} value={asset||null} disabled={disabled} onValueChange={v=>setAsset(String(v??""))}>{info.assets.map((a,i)=><Select.Option key={i} value={a.value}>{a.value}</Select.Option>)}</Select>
   {(asset.includes("*")||!info.assets.length)&&<Input label="Concrete target address" placeholder="https://app.example.com" value={concrete} onValueChange={setConcrete} disabled={disabled}/>}
   <Button type="button" variant="secondary" disabled={disabled||!(value||(!info.assets.length&&concrete)||targetURL)} onClick={()=>void perform(async()=>{const raw=value||concrete||targetURL;await onPick(info.program.id,/^https?:\/\//i.test(raw)?raw:"https://"+raw);})}>Use selected program</Button>
  </>}
 </div></Collapsible.DefaultPanel></Collapsible>;
}

type SecretKind="username"|"password"|"api"|"headers";
export function TargetAccessEditor({target,disabled,perform,onChanged}:{target:SavedTarget;disabled:boolean;perform:Perform;onChanged:()=>Promise<void>}){
 const prior=target.access;
 const [names,setNames]=useState<Awaited<ReturnType<typeof targetSecretBindings>>>(),[checks,setChecks]=useState<Partial<Record<SecretKind,string>>>({});
 useEffect(()=>{let active=true;void targetSecretBindings(target.id).then(value=>{if(active)setNames(value);});return()=>{active=false;};},[target.id]);
 const [headers,setHeaders]=useState(!!prior?.headerBinding),[login,setLogin]=useState(!!prior?.login),[loginURL,setLoginURL]=useState(prior?.login?.url??new URL("login",target.url.endsWith("/")?target.url:target.url+"/").href);
 const [api,setAPI]=useState(!!prior?.api),[apiHeader,setAPIHeader]=useState(prior?.api?.header??"Authorization"),[apiScheme,setAPIScheme]=useState(prior?.api?.scheme??"bearer");
 const refs=names?{username:prior?.login?.usernameBinding??names.username,password:prior?.login?.passwordBinding??names.password,api:prior?.api?.binding??names.api,headers:prior?.headerBinding??names.headers}:undefined;
 const check=(kind:SecretKind)=>perform(async()=>{const result=await action<{status:string}>("access.check",{id:target.id,revision:target.revision,kind});setChecks(value=>({...value,[kind]:result.status==="ready"?"Ready in Cloudflare · authentication not tested":result.status==="invalid"?"Invalid format":"Missing or unreadable in Cloudflare"}));});
 const row=(kind:SecretKind,label:string)=>refs&&<div className="grid gap-2"><Text as="strong">{label}</Text><div className="flex min-w-0 flex-wrap items-center gap-2"><InlineCopyText className="max-w-full break-all text-base" labels={{copyAction:"Copy "+label+" secret name",copied:"Copied"}}>{refs[kind]}</InlineCopyText><Button type="button" variant="secondary" disabled={disabled} onClick={()=>void check(kind)}>Check {label.toLowerCase()}</Button></div>{checks[kind]&&<Text role="status">{checks[kind]}</Text>}</div>;
 const save=()=>perform(async()=>{if(!refs)return;await action("access.save",{id:target.id,revision:target.revision,access:{headers:prior?.headers??[],...(headers?{headerBinding:refs.headers}:{}),...(login?{login:{url:loginURL,usernameBinding:refs.username,passwordBinding:refs.password}}:{}),...(api?{api:{url:target.url,binding:refs.api,header:apiHeader,scheme:apiScheme}}:{})}});await onChanged();});
 return <Collapsible><Collapsible.DefaultTrigger>Network and login settings</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid gap-5 py-3">
  {prior?.program&&<div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{prior.program.name}</Badge><ExternalLink href={prior.program.url}>Program rules</ExternalLink><Button type="button" variant="ghost" disabled={disabled} onClick={()=>void perform(async()=>{await action("scope.import",{id:target.id,revision:target.revision,programId:prior.program!.id});await onChanged();})}>Refresh scope</Button><Button type="button" variant="ghost" disabled={disabled} onClick={()=>void perform(async()=>{await action("scope.detach",{id:target.id,revision:target.revision});await onChanged();})}>Detach program</Button></div>}
  <Text>Copy these names into your Cloudflare Worker secrets or Secrets Store bindings. Your setup assistant can help. Credentials stay in Cloudflare.</Text>
  <Checkbox label="Required request headers" checked={headers} onCheckedChange={setHeaders} disabled={disabled}/>
  {headers&&<>{row("headers","Headers")}<Text>Use a JSON object of header names and values, for example {`{"X-Bug-Bounty":"your-researcher-name"}`}. Cloudflare identity, cookies and authorization headers are reserved.</Text></>}
  <Checkbox label="Browser login" checked={login} onCheckedChange={setLogin} disabled={disabled}/>
  {login&&<div className="grid gap-4"><Input label="Login page" value={loginURL} onValueChange={setLoginURL} disabled={disabled}/>{row("username","Username")}{row("password","Password")}<Text>Each run logs in fresh. Its agents share that run’s login. Check verifies the secret is readable; the agent confirms authentication in the browser.</Text></div>}
  {target.kind==="api"&&<><Checkbox label="API authentication" checked={api} onCheckedChange={setAPI} disabled={disabled}/>{api&&<div className="grid gap-3">{row("api","API key")}<Select label="API credential format" value={apiScheme} disabled={disabled} onValueChange={v=>{setAPIScheme(v as "bearer"|"header");if(v==="bearer")setAPIHeader("Authorization");}}><Select.Option value="bearer">Bearer token</Select.Option><Select.Option value="header">API key header</Select.Option></Select>{apiScheme==="header"&&<Input label="API authorization header" value={apiHeader} onValueChange={setAPIHeader} disabled={disabled}/>}<Text>Verify authentication using the read-only API check during run setup.</Text></div>}</>}
  <Banner variant="secondary" description="Browser and managed HTTP controls apply to this target. Kali has direct Internet access; scope is not enforced there. Review program rules before every run."/>
  <div><Button type="button" variant="secondary" disabled={disabled||!refs} onClick={()=>void save()}>Save target settings</Button></div>
 </div></Collapsible.DefaultPanel></Collapsible>;
}
