import {useState} from "react";
import {Badge,Banner,Button,Checkbox,Collapsible,Input,InputArea,Select,Text} from "@cloudflare/kumo";
import type {SavedTarget} from "../../native/onboarding";
import {ExternalLink} from "../components/external-link";
import {action} from "./api";
type Perform=(fn:()=>Promise<void>)=>Promise<void>;
type Summary={id:string;name:string;platform:string;url:string};
type Preview={program:Summary;assets:{value:string;type:string}[];assetCount:number;exclusionCount:number;publishedAt:string};

export function ProgramPicker({disabled,onPick,perform,targetURL=""}:{disabled:boolean;targetURL?:string;onPick:(id:string,url?:string)=>void|Promise<void>;perform:Perform}){
 const [query,setQuery]=useState(""),[platform,setPlatform]=useState(""),[programs,setPrograms]=useState<Summary[]>([]),[info,setInfo]=useState<Preview>(),[asset,setAsset]=useState(""),[concrete,setConcrete]=useState(""),[searched,setSearched]=useState(false),[total,setTotal]=useState(0);
 const search=()=>perform(async()=>{const result=await action<{programs:Summary[];total:number}>("scope.search",{query,platform});setPrograms(result.programs);setTotal(result.total);setSearched(true);setInfo(undefined);setAsset("");});
 const choose=(programId:string)=>perform(async()=>{setInfo(undefined);setAsset("");setConcrete("");setInfo(await action<Preview>("scope.preview",{programId}));});
 const value=asset.includes("*")?concrete:asset;
 return <Collapsible><Collapsible.DefaultTrigger>Find a bounty program</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid gap-4 py-3">
  <Text>Choose a program and a website or API. Review its official rules before testing; the public catalog is a starting point.</Text>
  <Input label="Program name" value={query} onValueChange={setQuery} disabled={disabled} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();void search();}}}/>
  <Select label="Bounty platform" value={platform} disabled={disabled} onValueChange={v=>setPlatform(String(v))}><Select.Option value="">All platforms</Select.Option><Select.Option value="hackerone">HackerOne</Select.Option><Select.Option value="bugcrowd">Bugcrowd</Select.Option><Select.Option value="intigriti">Intigriti</Select.Option><Select.Option value="yeswehack">YesWeHack</Select.Option></Select>
  <Button type="button" variant="secondary" disabled={disabled} onClick={()=>void search()}>Search programs</Button>
  {searched&&<Text role="status">{total} matching programs{total>50?". Showing the first 50; narrow your search.":"."}</Text>}
  {programs.length>0&&<Select label="Program" placeholder="Choose a program" value={info?.program.id??null} disabled={disabled} onValueChange={v=>{if(v)void choose(String(v));}}>{programs.map(p=><Select.Option key={p.id} value={p.id}>{p.name} · {p.platform}</Select.Option>)}</Select>}
  {info&&<>
   <ExternalLink href={info.program.url}>Review {info.program.name} scope and rules</ExternalLink>
   <Text>{info.exclusionCount} exclusions · Catalog published {new Date(info.publishedAt).toLocaleDateString()}</Text>
   <Select label="Program asset" placeholder={targetURL?"Keep the current target address":"Choose a website or API"} value={asset||null} disabled={disabled} onValueChange={v=>setAsset(String(v??""))}>{info.assets.map((a,i)=><Select.Option key={i} value={a.value}>{a.value}</Select.Option>)}</Select>
   {asset.includes("*")&&<Input label="Concrete target address" placeholder="https://app.example.com" value={concrete} onValueChange={setConcrete} disabled={disabled}/>}
   {info.assetCount>info.assets.length&&<Text>Some assets are not websites or APIs, or exceed the preview limit. You can enter an eligible concrete address yourself.</Text>}
   <Button type="button" variant="secondary" disabled={disabled||!(value||targetURL)} onClick={()=>void perform(async()=>{const raw=value||targetURL;await onPick(info.program.id,/^https?:\/\//i.test(raw)?raw:"https://"+raw);})}>Use selected program</Button>
  </>}
 </div></Collapsible.DefaultPanel></Collapsible>;
}

export function TargetAccessEditor({target,disabled,perform,onChanged}:{target:SavedTarget;disabled:boolean;perform:Perform;onChanged:()=>Promise<void>}){
 const prior=target.access;
 const [headers,setHeaders]=useState((prior?.headers??[]).map(h=>h.name+": "+h.value).join("\n"));
 const [login,setLogin]=useState(!!prior?.login),[loginURL,setLoginURL]=useState(prior?.login?.url??new URL("login",target.url.endsWith("/")?target.url:target.url+"/").href);
 const [username,setUsername]=useState(prior?.login?.usernameBinding??""),[password,setPassword]=useState(prior?.login?.passwordBinding??"");
 const [api,setAPI]=useState(!!prior?.api),[apiBinding,setAPIBinding]=useState(prior?.api?.binding??""),[apiHeader,setAPIHeader]=useState(prior?.api?.header??"Authorization"),[apiScheme,setAPIScheme]=useState(prior?.api?.scheme??"bearer");
 const save=()=>perform(async()=>{
  const required=headers.split(/\r?\n/).filter(line=>line.trim()).map(line=>{const colon=line.indexOf(":");if(colon<1)throw new Error("Use one Header-Name: value per line");return {name:line.slice(0,colon).trim(),value:line.slice(colon+1).trim()};});
  await action("access.save",{id:target.id,revision:target.revision,access:{headers:required,...(login?{login:{url:loginURL,usernameBinding:username,passwordBinding:password}}:{}),...(api?{api:{url:target.url,binding:apiBinding,header:apiHeader,scheme:apiScheme}}:{})}});await onChanged();
 });
 return <Collapsible><Collapsible.DefaultTrigger>Network and login settings</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid gap-5 py-3">
  {prior?.program&&<div className="grid gap-2"><Badge variant="secondary">{prior.program.name}</Badge><Text>{prior.program.deny.length} applicable exclusions · Published {new Date(prior.program.publishedAt).toLocaleDateString()}. Requests stay within {target.url}.</Text><ExternalLink href={prior.program.url}>Review program rules</ExternalLink><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={disabled} onClick={()=>void perform(async()=>{await action("scope.import",{id:target.id,revision:target.revision,programId:prior.program!.id});await onChanged();})}>Refresh program scope</Button><Button type="button" variant="ghost" disabled={disabled} onClick={()=>void perform(async()=>{await action("scope.detach",{id:target.id,revision:target.revision});await onChanged();})}>Detach program</Button></div></div>}
  <InputArea label="Required request headers" description="Nonsecret researcher identification only. One Header-Name: value per line." rows={3} value={headers} onValueChange={setHeaders} disabled={disabled}/>
  <Checkbox label="Cloudflare login" checked={login} onCheckedChange={setLogin} disabled={disabled}/>
  {login&&<div className="grid gap-3"><Input label="Login page" value={loginURL} onValueChange={setLoginURL} disabled={disabled}/><Input label="Username secret binding" placeholder="PENTCLOUD_TARGET_DEMO_USERNAME" value={username} onValueChange={setUsername} disabled={disabled}/><Input label="Password secret binding" placeholder="PENTCLOUD_TARGET_DEMO_PASSWORD" value={password} onValueChange={setPassword} disabled={disabled}/><Text>The agent identifies the form. Cloudflare supplies the credentials; browser state is reused for this target.</Text></div>}
  {target.kind==="api"&&<><Checkbox label="Cloudflare API credential" checked={api} onCheckedChange={setAPI} disabled={disabled}/>{api&&<div className="grid gap-3"><Input label="API key secret binding" placeholder="PENTCLOUD_TARGET_DEMO_API_KEY" value={apiBinding} onValueChange={setAPIBinding} disabled={disabled}/><Select label="API credential format" value={apiScheme} disabled={disabled} onValueChange={v=>{setAPIScheme(v as "bearer"|"header");if(v==="bearer")setAPIHeader("Authorization");}}><Select.Option value="bearer">Bearer token</Select.Option><Select.Option value="header">API key header</Select.Option></Select>{apiScheme==="header"&&<Input label="API authorization header" value={apiHeader} onValueChange={setAPIHeader} disabled={disabled}/>}</div>}</>}
  <Text>Enter Cloudflare binding names here. Your setup assistant can create the encrypted Worker secrets or Secrets Store bindings; values stay in Cloudflare.</Text>
  <Banner variant="secondary" description="Managed access supports HTTP and HTTPS on ports 80 and 443. Other protocols are blocked in Kali. Browser WebSockets are disabled. Some targets may need additional capabilities."/>
  <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={disabled} onClick={()=>void save()}>Save target settings</Button>{prior?.login&&<Button type="button" variant="ghost" disabled={disabled} onClick={()=>void perform(async()=>{await action("access.clearlogin",{id:target.id,revision:target.revision});})}>Forget saved login</Button>}</div>
 </div></Collapsible.DefaultPanel></Collapsible>;
}
