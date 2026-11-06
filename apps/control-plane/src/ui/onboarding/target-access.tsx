import {useEffect,useRef,useState} from "react";
import {Badge,Banner,Button,Checkbox,Collapsible,Combobox,InlineCopyText,Input,LinkButton,Select,Text} from "@cloudflare/kumo";
import type {SavedTarget} from "../../native/onboarding";
import {targetSecretBindings} from "../../../../../shared/target-access";
import type {BountyStatus} from "../../../../../shared/bounty-connections";
import type {VerificationProvider} from "../../../../../shared/target-access";
import {ExternalLink} from "../components/external-link";
import {action} from "./api";
type Perform=(fn:()=>Promise<void>)=>Promise<void>;
type Summary={id:string;name:string;platform:string};
type Preview={program:Summary&{url:string};assets:{value:string;type:string}[]};

export function ProgramPicker({disabled,onPick,perform,targetURL=""}:{disabled:boolean;targetURL?:string;onPick:(id:string,url?:string)=>void|Promise<void>;perform:Perform}){
 const [programs,setPrograms]=useState<Summary[]>([]),[selected,setSelected]=useState<Summary|null>(null),[info,setInfo]=useState<Preview>(),[asset,setAsset]=useState(""),[concrete,setConcrete]=useState("");
 const [state,setState]=useState('idle'),[error,setError]=useState<string>();
 const loading=useRef(false),choice=useRef(0);
 const load=async()=>{if(loading.current)return;loading.current=true;setState('loading');setError(undefined);try{
  const status=await action<BountyStatus>('bounty.status',{});
  if(!status.connections.some(c=>c.status==='ready')){setPrograms([]);setState('locked');return;}
  setPrograms((await action<{programs:Summary[]}>("scope.names",{})).programs);setState('ready');
 }catch(e){setState('failed');setError(e instanceof Error?e.message:'Programs unavailable');}finally{loading.current=false;}};
 const choose=(program:Summary|null)=>{setSelected(program);setInfo(undefined);setAsset("");setConcrete("");setError(undefined);const generation=++choice.current;if(program)void action<Preview>("scope.preview",{programId:program.id}).then(preview=>{if(choice.current===generation)setInfo(preview);}).catch(e=>{if(choice.current===generation)setError(e.message);});};
 const value=asset.includes("*")?concrete:asset;
 return <Collapsible onOpenChange={open=>{if(open)void load();}}><Collapsible.DefaultTrigger>Find a bounty program</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid gap-4 py-3">
  {state==='locked'?<><Text>Connect a platform to unlock its programs.</Text><div><LinkButton variant="secondary" href="/dashboard?view=bounty">Set up bug bounty</LinkButton></div></>:<>
   <Combobox items={programs} value={selected} onValueChange={choose} itemToStringLabel={p=>p.name+" · "+p.platform} isItemEqualToValue={(a,b)=>a.id===b.id} disabled={disabled||state!=='ready'} label="Program">
    <Combobox.TriggerInput placeholder="Search or browse programs"/>
    <Combobox.Content><Combobox.List>{(p:Summary)=><Combobox.Item key={p.id} value={p}>{p.name} · {p.platform}</Combobox.Item>}</Combobox.List><Combobox.Empty>No matching programs</Combobox.Empty></Combobox.Content>
   </Combobox>
   {state==='loading'&&<Text role="status">Checking connections…</Text>}
   {info&&<>
    <ExternalLink href={info.program.url}>Review {info.program.name} rules</ExternalLink>
    <Select label="Website or API" placeholder={targetURL?"Keep the current target address":"Choose a target"} value={asset||null} disabled={disabled} onValueChange={v=>setAsset(String(v??""))}>{info.assets.map((a,i)=><Select.Option key={i} value={a.value}>{a.value}</Select.Option>)}</Select>
    {(asset.includes("*")||!info.assets.length)&&<Input label="Concrete target address" placeholder="Enter the full target address" value={concrete} onValueChange={setConcrete} disabled={disabled}/>}
    <Button type="button" variant="secondary" disabled={disabled||!(value||(!info.assets.length&&concrete)||targetURL)} onClick={()=>void perform(async()=>{const raw=value||concrete||targetURL;await onPick(info.program.id,/^https?:\/\//i.test(raw)?raw:"https://"+raw);})}>Use selected program</Button>
   </>}
  </>}
  {error&&<Banner variant="error" description={<Text>{error}</Text>}/>}
 </div></Collapsible.DefaultPanel></Collapsible>;
}

type SecretKind="username"|"password"|"api"|"headers"|"totp";
export function TargetAccessEditor({target,disabled,perform,onChanged}:{target:SavedTarget;disabled:boolean;perform:Perform;onChanged:()=>Promise<void>}){
 const prior=target.access;
 const [names,setNames]=useState<Awaited<ReturnType<typeof targetSecretBindings>>>(),[checks,setChecks]=useState<Partial<Record<SecretKind,string>>>({}),[checking,setChecking]=useState<Partial<Record<SecretKind,boolean>>>({});
 useEffect(()=>{let active=true;void targetSecretBindings(target.id).then(value=>{if(active)setNames(value);});return()=>{active=false;};},[target.id]);
 const [headers,setHeaders]=useState(!!prior?.headerBinding),[login,setLogin]=useState(!!prior?.login),[loginURL,setLoginURL]=useState(prior?.login?.url??"");
 const [api,setAPI]=useState(!!prior?.api),[apiHeader,setAPIHeader]=useState(prior?.api?.header??"Authorization"),[apiScheme,setAPIScheme]=useState(prior?.api?.scheme??"bearer");
 const [verification,setVerification]=useState(prior?.login?.verification?.kind??"none"),[sender,setSender]=useState(prior?.login?.verification?.kind==="email"?prior.login.verification.sender:"");
 const [provider,setProvider]=useState<VerificationProvider>(prior?.login?.verification?.kind==='email'?prior.login.verification.provider??'cloudflare':'cloudflare');
 const refs=names?{username:prior?.login?.usernameBinding??names.username,password:prior?.login?.passwordBinding??names.password,api:prior?.api?.binding??names.api,headers:prior?.headerBinding??names.headers,totp:prior?.login?.verification?.kind==="totp"?prior.login.verification.binding:names.totp}:undefined;
 const check=async(kind:SecretKind)=>{setChecking(value=>({...value,[kind]:true}));try{const result=await action<{status:string}>("access.check",{id:target.id,revision:target.revision,kind});setChecks(value=>({...value,[kind]:result.status==="ready"?"Ready in Cloudflare · authentication not tested":result.status==="invalid"?"Invalid format":"Missing or unreadable in Cloudflare"}));}catch(e){setChecks(value=>({...value,[kind]:e instanceof Error?e.message:'Check failed'}));}finally{setChecking(value=>({...value,[kind]:false}));}};
 const row=(kind:SecretKind,label:string)=>refs&&<div className="grid gap-1.5"><Text as="strong">{label}</Text><div className="flex min-w-0 flex-wrap items-center gap-2"><InlineCopyText variant="body" truncate={false} className="max-w-full break-all text-left font-mono text-base" labels={{copyAction:"Copy "+label+" secret name",copied:"Copied"}}>{refs[kind]}</InlineCopyText><Button type="button" variant="secondary" disabled={disabled} loading={checking[kind]??false} onClick={()=>void check(kind)}>Check {label.toLowerCase()}</Button></div>{checks[kind]&&<Text role="status">{checks[kind]}</Text>}</div>;
 const save=()=>perform(async()=>{if(!refs)return;await action("access.save",{id:target.id,revision:target.revision,access:{headers:prior?.headers??[],...(headers?{headerBinding:refs.headers}:{}),...(login?{login:{url:loginURL,usernameBinding:refs.username,passwordBinding:refs.password,...(verification==="totp"?{verification:{kind:"totp",binding:refs.totp}}:verification==="email"?{verification:{kind:"email",sender,provider}}:{})}}:{}),...(api?{api:{url:target.url,binding:refs.api,header:apiHeader,scheme:apiScheme}}:{})}});await onChanged();});
 return <Collapsible><Collapsible.DefaultTrigger>Network and login settings</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid max-w-2xl gap-5 py-3">
  {prior?.program&&<div className="flex flex-wrap items-center gap-2"><Badge className="text-base" variant="secondary">{prior.program.name}</Badge><ExternalLink href={prior.program.url}>Program rules</ExternalLink><Button type="button" variant="ghost" disabled={disabled} onClick={()=>void perform(async()=>{await action("scope.import",{id:target.id,revision:target.revision,programId:prior.program!.id});await onChanged();})}>Refresh scope</Button><Button type="button" variant="ghost" disabled={disabled} onClick={()=>void perform(async()=>{await action("scope.detach",{id:target.id,revision:target.revision});await onChanged();})}>Detach program</Button></div>}
  <Text>Copy the names below into Cloudflare secrets or Secrets Store bindings. Values stay in Cloudflare.</Text>
  {!refs&&<Text role="status">Loading secret references…</Text>}
  <Checkbox label="Required request headers" checked={headers} onCheckedChange={setHeaders} disabled={disabled}/>
  {headers&&<>{row("headers","Headers")}<Collapsible><Collapsible.DefaultTrigger>Header format</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><Text>Enter the program’s required header names and values as a JSON object. Cookies, authorization and Cloudflare identity headers are reserved.</Text></Collapsible.DefaultPanel></Collapsible></>}
  <Checkbox label="Browser login" checked={login} onCheckedChange={setLogin} disabled={disabled}/>
  {login&&<div className="grid gap-4"><Input label="Login page" type="url" required value={loginURL} onValueChange={setLoginURL} disabled={disabled} placeholder="Enter the full sign-in page address"/>{row("username","Username")}{row("password","Password")}<Text>Each run logs in fresh. Its agents share that run’s login. Check verifies availability; the agent confirms authentication.</Text>
   <Select label="Login verification" value={verification} items={{none:'None',totp:'Authenticator code',email:'Email code or link'}} onValueChange={v=>setVerification(String(v) as typeof verification)} disabled={disabled}/>
   {verification==="totp"&&<>{row("totp","Authenticator seed")}<Text>Store the test account’s Base32 seed or otpauth URI. The agent reads the short-lived code; the seed stays in Cloudflare.</Text></>}
   {verification==="email"&&<div className="grid gap-3"><Select label="Email receiver" value={provider} items={{cloudflare:'Cloudflare Email Routing',agentmail:'AgentMail'}} onValueChange={v=>setProvider(v as VerificationProvider)} disabled={disabled}/>
    <Input label="Verification sender address or domain" placeholder="Enter the sender address or domain" value={sender} onValueChange={setSender} disabled={disabled}/>
    <Text>Save these settings, then set up and check forwarding in Bug bounty.</Text><div><LinkButton variant="secondary" href={'/dashboard?view=bounty&target='+encodeURIComponent(target.id)}>Set up email forwarding</LinkButton></div>
   </div>}
  </div>}
  {target.kind==="api"&&<><Checkbox label="API authentication" checked={api} onCheckedChange={setAPI} disabled={disabled}/>{api&&<div className="grid gap-3">{row("api","API key")}<Select label="API credential format" value={apiScheme} items={{bearer:'Bearer token',header:'API key header'}} disabled={disabled} onValueChange={v=>{setAPIScheme(v as "bearer"|"header");if(v==="bearer")setAPIHeader("Authorization");}}/>{apiScheme==="header"&&<Input label="API authorization header" value={apiHeader} onValueChange={setAPIHeader} disabled={disabled}/>}<Text>Test authentication with the protected API check during run setup.</Text></div>}</>}
  <Banner variant="secondary" description={<Text>Browser and managed HTTP controls apply to this target. Scanner runtimes have direct Internet access; scope is not enforced there.</Text>}/>
  <div><Button type="button" variant="secondary" disabled={disabled||!refs||login&&(!loginURL.trim()||verification==="email"&&!sender.trim())} onClick={()=>void save()}>Save target settings</Button></div>
 </div></Collapsible.DefaultPanel></Collapsible>;
}
