import {boundedText} from './target-check';
import {BOUNTY_PLATFORMS,type BountyPlatform,type BountyConnection} from '../../../../shared/bounty-connections';
type ConnectionReceipt={fingerprint:string;checkedAt:number;expiresAt?:number};
const connectionURL:Record<BountyPlatform,string>={hackerone:'https://api.hackerone.com/v1/hackers/programs?page%5Bsize%5D=1',intigriti:'https://api.intigriti.com/external/researcher/v1/programs?limit=1&offset=0',bugcrowd:'https://hacker-api.bugcrowd.com/v1/engagements?limit=1',yeswehack:'https://api.yeswehack.com/user'};

/** Provider-native authentication only; values come from Cloudflare bindings. */
function providerHeaders(platform:BountyPlatform,token:string,username?:unknown):{headers:Headers;expiresAt?:number}{
 const headers=new Headers({Accept:'application/json','User-Agent':'PentCloud program access'});
 if(platform==='hackerone'){
  if(typeof username!=='string'||!/^[-_a-z0-9]{1,100}$/i.test(username))throw Error('409: Configure PENTCLOUD_HACKERONE_USERNAME');
  headers.set('Authorization','Basic '+btoa(username+':'+token));
 }else if(platform==='bugcrowd'){
  const pair=token.replace(/^Token +/i,'').trim();if(!/^[^:\s]+:[^:\s]+$/.test(pair))throw Error('409: Store the Bugcrowd Hacker API token as ID:secret in Cloudflare');
  headers.set('Authorization','Token '+pair);
 }else if(platform==='yeswehack'){
  const jwt=token.replace(/^Bearer +/i,'').trim();let expiresAt:number;
  try{const parts=jwt.split('.');if(parts.length!==3||parts.some(p=>!/^[-_A-Za-z0-9]+$/.test(p)))throw Error();
   const claims=JSON.parse(atob(parts[1]!.replace(/-/g,'+').replace(/_/g,'/')));if(typeof claims.exp!=='number'||!Number.isFinite(claims.exp)||claims.exp<=0)throw Error();expiresAt=claims.exp*1000;
  }catch{throw Error('409: Use a YesWeHack researcher access token (JWT), not a manager PAT');}
  // The expiry claim only shortens cache lifetime. A live authenticated profile
  // check, not these unverified claims, proves the credential works.
  headers.set('Authorization','Bearer '+jwt);return {headers,expiresAt};
 }else headers.set('Authorization','Bearer '+token);
 return {headers};
}
async function providerJSON(url:string,headers:Headers,platform:BountyPlatform,fetcher:typeof fetch,maximum=512*1024):Promise<Record<string,any>>{
 let response:Response;try{response=await fetcher(url,{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw Error('503: Platform connection unavailable; retry the check');}
 if(!response.ok){
  let code:unknown;if(platform==='bugcrowd'&&response.status===403){try{code=JSON.parse(await boundedText(response,4096)).errors?.[0]?.code;}catch{}}else await response.body?.cancel();
  if(code==='hacker_api_disabled'||code==='forbidden')throw Error('409: Enable Bugcrowd Hacker API access for this account');
  if(code==='identity_not_verified')throw Error('409: Complete Bugcrowd identity verification before using its Hacker API');
  if(code==='insufficient_scope')throw Error('409: Bugcrowd token needs read:engagement_list');
  if(response.status===401)throw Error('409: Platform credential is invalid or expired; renew it in Cloudflare and check again');
  if([403,404].includes(response.status))throw Error('409: This account or credential cannot access the selected program');
  throw Error('503: Platform connection unavailable (HTTP '+response.status+'); retry later');
 }
 try{const body=JSON.parse(await boundedText(response,maximum));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();return body;}catch{throw Error('502: Unexpected platform connection response');}
}
/** A check receipt only. Credential values remain in native Cloudflare bindings. */
export class BountyConnections {
 constructor(private readonly env:object,private readonly io:{get<T>(key:string):T|undefined;put(key:string,value:unknown):void;remove(key:string):unknown;fetcher?:typeof fetch;now?:()=>number}){}
 private now(){return(this.io.now??Date.now)();}
 private key(platform:BountyPlatform){return 'bounty:connection:'+platform;}
 private async credential(platform:BountyPlatform){
  const config=BOUNTY_PLATFORMS.find(p=>p.id===platform);if(!config)throw Error('400: Unsupported bug bounty connection');
  const token=await platformToken(this.env,config.token),username=platform==='hackerone'?Reflect.get(this.env,'PENTCLOUD_HACKERONE_USERNAME'):undefined,auth=providerHeaders(platform,token,username);
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([token,username])));
  return {...auth,fingerprint:[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')};
 }
 async status(platform:BountyPlatform):Promise<BountyConnection>{
  let credential:Awaited<ReturnType<BountyConnections['credential']>>;try{credential=await this.credential(platform);}catch{return {platform,status:'missing'};}
  const receipt=this.io.get<ConnectionReceipt>(this.key(platform)),expiresAt=receipt?Math.min(receipt.expiresAt??receipt.checkedAt+24*3600000,credential.expiresAt??Infinity):0;
  return {platform,status:receipt?.fingerprint===credential.fingerprint&&expiresAt>this.now()?'ready':'unchecked',...(receipt?{checkedAt:receipt.checkedAt,expiresAt}: {})};
 }
 async list(){return Promise.all(BOUNTY_PLATFORMS.map(p=>this.status(p.id)));}
 async require(platform:string){
  if(!BOUNTY_PLATFORMS.some(p=>p.id===platform)||(await this.status(platform as BountyPlatform)).status!=='ready')throw Error('409: Check this platform connection in Dashboard → Bug bounty first');
 }
 async check(platform:BountyPlatform){
  if(!BOUNTY_PLATFORMS.some(p=>p.id===platform))throw Error('400: Unsupported bug bounty connection');
  this.io.remove(this.key(platform));const credential=await this.credential(platform);
  if(credential.expiresAt!==undefined&&credential.expiresAt<=this.now())throw Error('409: YesWeHack token expired; renew the Cloudflare secret and check again');
  const body=await providerJSON(connectionURL[platform],credential.headers,platform,this.io.fetcher??fetch);
  if(platform==='yeswehack'?typeof body.username!=='string'||!body.username.trim():!Array.isArray(platform==='intigriti'?body.records:body.data))throw Error('502: Unexpected platform connection response');
  const current=await this.credential(platform);if(current.fingerprint!==credential.fingerprint)throw Error('409: Platform binding changed; check the connection again');
  const expiresAt=Math.min(this.now()+24*3600000,current.expiresAt??Infinity);if(expiresAt<=this.now())throw Error('409: Platform token expired during the check; renew it in Cloudflare');
  this.io.put(this.key(platform),{fingerprint:credential.fingerprint,checkedAt:this.now(),expiresAt});return this.status(platform);
 }
}
function remoteProgramId(programId:string,platform:BountyPlatform){
 const id=programId.slice(programId.indexOf(':')+1);
 if(platform==='bugcrowd'){
  if(/^[-_a-z0-9.]{1,160}$/i.test(id))return id;
  try{const url=new URL(id);if(url.origin!=='https://bugcrowd.com'||url.username||url.password||url.search||url.hash)return;
   return url.pathname.match(/^\/(?:engagements\/)?([-_a-z0-9.]{1,160})\/?$/i)?.[1];
  }catch{return;}
 }
 return (platform==='intigriti'?/^[a-f0-9-]{36}$/i:platform==='hackerone'?/^[-_a-z0-9]{1,100}$/i:/^[-_a-z0-9]{1,160}$/i).test(id)?id:undefined;
}
export function platformBinding(programId:string){
 const config=BOUNTY_PLATFORMS.find(p=>programId.startsWith(p.id+':'));if(!config||!remoteProgramId(programId,config.id))return;
 return {platform:config.id,binding:config.token,...('username' in config?{username:config.username}:{})};
}
export async function platformToken(env:object,binding:string){
 const value:unknown=Reflect.get(env,binding);let token:unknown;
 try{token=typeof value==='string'?value:value&&typeof value==='object'&&typeof Reflect.get(value,'get')==='function'?await(value as {get():Promise<string>}).get():undefined;}catch{}
 if(typeof token!=='string'||!token.trim()||token.length>8192||/[\r\n\0]/.test(token))throw Error('409: Configure '+binding+' in Cloudflare');return token;
}
export interface ProgramAccess {platform:BountyPlatform;name:string;sourceURL:string;policy:string;checkedAt:number}
export async function checkProgramAccess(programId:string,credentials:{token:string;username?:string},fetcher:typeof fetch=fetch):Promise<ProgramAccess>{
 const config=platformBinding(programId);if(!config)throw Error('409: This platform has no supported account connection');
 const id=remoteProgramId(programId,config.platform)!,{headers}=providerHeaders(config.platform,credentials.token,credentials.username);
 let url:string,name:string,policy:string;
 if(config.platform==='bugcrowd'){
  // The Hacker API's native unlimited listing resolves catalog engagement codes
  // to UUIDs without another catalog, paging loop or persistent mapping store.
  const list=await providerJSON('https://hacker-api.bugcrowd.com/v1/engagements',headers,config.platform,fetcher,4*1024*1024);
  if(!Array.isArray(list.data)||list.pagination?.has_more!==false)throw Error('503: Bugcrowd returned an incomplete engagement list; retry later');
  const matches=list.data.filter((r:any)=>r.attributes?.code===id);if(matches.length!==1)throw Error('409: This account cannot access the selected Bugcrowd engagement');
  const record=matches[0],a=record.attributes;if(record.type!=='engagement'||typeof record.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(record.id))throw Error('502: Program identity mismatch');
  if(a.state!=='in_progress')throw Error('409: Bugcrowd engagement is paused or not accepting assessments');
  url='https://hacker-api.bugcrowd.com/v1/engagements/'+record.id+'/scope';const scope=await providerJSON(url,headers,config.platform,fetcher);
  if(scope.engagement_id!==record.id||!Array.isArray(scope.in_scope)||!Array.isArray(scope.out_of_scope)||!Array.isArray(scope.vrt_exclusions))throw Error('502: Program scope identity mismatch');
  if(!scope.in_scope.some((v:any)=>typeof v.value==='string'&&v.value.trim()&&v.value!=='REDACTED')||[...scope.in_scope,...scope.out_of_scope].some((v:any)=>v.value==='REDACTED'))throw Error('409: Bugcrowd scope is unavailable or paused');
  name=a.name??id;
  const notes=[...scope.in_scope.filter((v:any)=>typeof v.description==='string'&&v.description.trim()).map((v:any)=>({asset:v.value,description:v.description})),...scope.out_of_scope.filter((v:any)=>typeof v.reason==='string'&&v.reason.trim()).map((v:any)=>({excludedAsset:v.value,reason:v.reason}))];
  const restrictions=scope.vrt_exclusions.map((v:any)=>({type:v.exclusion_type,categories:v.vrt_ids?.map((r:any)=>r.id),allTargets:v.all_targets,targets:v.targets?.map((r:any)=>r.name),targetGroups:v.target_groups?.map((r:any)=>r.name),notes:v.notes}));
  policy='Review the full published brief at https://bugcrowd.com/engagements/'+id+'. The Hacker API provides eligibility and scope data, not the complete brief.\nScope notes: '+JSON.stringify(notes)+'\nVulnerability restrictions: '+JSON.stringify(restrictions);
 }else{
  url=config.platform==='hackerone'?'https://api.hackerone.com/v1/hackers/programs/'+id:config.platform==='intigriti'?'https://api.intigriti.com/external/researcher/v1/programs/'+id:'https://api.yeswehack.com/programs/'+id;
  const raw=await providerJSON(url,headers,config.platform,fetcher);
  if(config.platform==='hackerone'){
   const record=raw.data??raw,a=record.attributes;if(a?.handle!==id||record.type&&record.type!=='program')throw Error('502: Program identity mismatch');if(a.submission_state!=='open')throw Error('409: Program is not accepting assessments');name=a.name;policy=a.policy;
  }else if(config.platform==='intigriti'){
   if(raw.id?.toLowerCase()!==id.toLowerCase())throw Error('502: Program identity mismatch');
   if(['closed','paused','disabled','inactive'].includes(String(raw.status?.value).toLowerCase()))throw Error('409: Program is not accepting assessments');
   const rules=raw.rulesOfEngagement?.content;if(!rules||typeof rules.description!=='string')throw Error('409: Program rules are unavailable to this account');name=raw.name;
   policy=rules.description+'\nTesting requirements: '+JSON.stringify(rules.testingRequirements??{});
  }else{
   if(raw.slug!==id)throw Error('502: Program identity mismatch');if(raw.disabled!==false||raw.archived!==false)throw Error('409: Program is not accepting assessments');
   name=raw.title;if(typeof raw.rules!=='string'||!raw.rules.trim())throw Error('409: Program rules are unavailable to this account');
   policy=raw.rules+'\nTesting requirements: '+JSON.stringify({accountAccess:raw.account_access,userAgent:raw.user_agent,qualifying:raw.qualifying_vulnerability,nonQualifying:raw.non_qualifying_vulnerability,outOfScope:raw.out_of_scope,vpnRequired:raw.vpn_active});
  }
 }
 if(typeof name!=='string'||!name.trim()||typeof policy!=='string'||!policy.trim()||policy.length>64000)throw Error('409: Review the selected program rules before testing');
 return {platform:config.platform,name,sourceURL:url,policy,checkedAt:Date.now()};
}
