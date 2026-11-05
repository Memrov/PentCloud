import {boundedText} from './target-check';
import {BOUNTY_PLATFORMS,type BountyPlatform,type BountyConnection} from '../../../../shared/bounty-connections';
type ConnectionReceipt={fingerprint:string;checkedAt:number};
function supportedPlatform(platform:string){
 const config=BOUNTY_PLATFORMS.find(p=>p.id===platform);if(!config)throw Error('400: Unsupported bug bounty connection');
 if('development' in config)throw Error('409: '+config.name+' is in development; account connections are unavailable');
 return config;
}
/** A check receipt only. Credential values remain in native Cloudflare bindings. */
export class BountyConnections {
 constructor(private readonly env:object,private readonly io:{get<T>(key:string):T|undefined;put(key:string,value:unknown):void;remove(key:string):unknown;fetcher?:typeof fetch;now?:()=>number}){}
 private now(){return(this.io.now??Date.now)();}
 private key(platform:BountyPlatform){return 'bounty:connection:'+platform;}
 private async credential(platform:BountyPlatform){
  const config=supportedPlatform(platform);
  const token=await platformToken(this.env,config.token),username=platform==='hackerone'?Reflect.get(this.env,'PENTCLOUD_HACKERONE_USERNAME'):undefined;
  if(platform==='hackerone'&&(typeof username!=='string'||!/^[-_a-z0-9]{1,100}$/i.test(username)))throw Error('409: Configure PENTCLOUD_HACKERONE_USERNAME');
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([token,username])));
  return {token,username,fingerprint:[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')};
 }
 async status(platform:BountyPlatform):Promise<BountyConnection>{
  if(BOUNTY_PLATFORMS.some(p=>p.id===platform&&'development' in p))return {platform,status:'development'};
  let credential:Awaited<ReturnType<BountyConnections['credential']>>;try{credential=await this.credential(platform);}catch{return {platform,status:'missing'};}
  const receipt=this.io.get<ConnectionReceipt>(this.key(platform));
  return {platform,status:receipt?.fingerprint===credential.fingerprint&&receipt.checkedAt>this.now()-24*3600000?'ready':'unchecked',...(receipt?{checkedAt:receipt.checkedAt,expiresAt:receipt.checkedAt+24*3600000}:{})};
 }
 async list(){return Promise.all(BOUNTY_PLATFORMS.map(p=>this.status(p.id)));}
 async require(platform:string){
  supportedPlatform(platform);
  if(!BOUNTY_PLATFORMS.some(p=>p.id===platform)||(await this.status(platform as BountyPlatform)).status!=='ready')throw Error('409: Check this platform connection in Dashboard → Bug bounty first');
 }
 async check(platform:BountyPlatform){
  supportedPlatform(platform);
  this.io.remove(this.key(platform));const credential=await this.credential(platform),headers=new Headers({Accept:'application/json','User-Agent':'PentCloud connection check'});
  const url=platform==='hackerone'?'https://api.hackerone.com/v1/hackers/programs?page%5Bsize%5D=1':'https://api.intigriti.com/external/researcher/v1/programs?limit=1&offset=0';
  headers.set('Authorization',platform==='hackerone'?'Basic '+btoa(credential.username+':'+credential.token):'Bearer '+credential.token);
  let response:Response;try{response=await(this.io.fetcher??fetch)(url,{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw Error('503: Platform connection unavailable; retry the check');}
  if(!response.ok){await response.body?.cancel();throw Error(response.status===401?'409: Platform credential is invalid or expired':response.status===403?'409: This credential cannot read programs':'503: Platform connection unavailable; retry the check');}
  let records:unknown;try{const body=JSON.parse(await boundedText(response,512*1024));records=platform==='hackerone'?body.data:body.records;}catch{}
  if(!Array.isArray(records))throw Error('502: Unexpected platform connection response');
  if((await this.credential(platform)).fingerprint!==credential.fingerprint)throw Error('409: Platform binding changed; check the connection again');
  this.io.put(this.key(platform),{fingerprint:credential.fingerprint,checkedAt:this.now()});return this.status(platform);
 }
}
export function platformBinding(programId:string){
 if(/^hackerone:[a-z0-9_-]{1,100}$/i.test(programId))return {platform:'hackerone' as const,binding:'PENTCLOUD_HACKERONE_API_TOKEN',username:'PENTCLOUD_HACKERONE_USERNAME'};
 if(/^intigriti:[a-f0-9-]{36}$/i.test(programId))return {platform:'intigriti' as const,binding:'PENTCLOUD_INTIGRITI_API_TOKEN'};
 return undefined;
}
export async function platformToken(env:object,binding:string){
 const value:unknown=Reflect.get(env,binding);let token:unknown;
 try{token=typeof value==='string'?value:value&&typeof value==='object'&&typeof Reflect.get(value,'get')==='function'?await(value as {get():Promise<string>}).get():undefined;}catch{}
 if(typeof token!=='string'||!token.trim()||token.length>8192||/[\r\n\0]/.test(token))throw Error('409: Configure '+binding+' in Cloudflare');return token;
}
export interface ProgramAccess {platform:'hackerone'|'intigriti';name:string;sourceURL:string;policy:string;checkedAt:number}
export async function checkProgramAccess(programId:string,credentials:{token:string;username?:string},fetcher:typeof fetch=fetch):Promise<ProgramAccess>{
 const config=platformBinding(programId);if(!config)throw Error('409: This platform has no supported account connection');
 const id=programId.slice(programId.indexOf(':')+1),headers=new Headers({Accept:'application/json','User-Agent':'PentCloud program access'});
 let url:string;
 if(config.platform==='hackerone'){
  if(!credentials.username||!/^[-_a-z0-9]{1,100}$/i.test(credentials.username))throw Error('409: Configure PENTCLOUD_HACKERONE_USERNAME');
  url='https://api.hackerone.com/v1/hackers/programs/'+id;headers.set('Authorization','Basic '+btoa(credentials.username+':'+credentials.token));
 }else{url='https://api.intigriti.com/external/researcher/v1/programs/'+id;headers.set('Authorization','Bearer '+credentials.token);}
 let response:Response;try{response=await fetcher(url,{headers,redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw Error('503: Program access check unavailable; retry later');}
 if(!response.ok){await response.body?.cancel();if(response.status===401)throw Error('409: Platform credential is invalid or expired');if([403,404].includes(response.status))throw Error('409: This account cannot access the selected program');throw Error('503: Program access check unavailable (HTTP '+response.status+'); retry later');}
 let raw:Record<string,any>;try{raw=JSON.parse(await boundedText(response,512*1024));}catch{throw Error('502: Invalid program response');}
 let name:string,policy:string;
 if(config.platform==='hackerone'){
  const record=raw.data??raw,a=record.attributes;if(a?.handle!==id||record.type&&record.type!=='program')throw Error('502: Program identity mismatch');if(a.submission_state!=='open')throw Error('409: Program is not accepting assessments');name=a.name;policy=a.policy;
 }else{
  if(raw.id?.toLowerCase()!==id.toLowerCase())throw Error('502: Program identity mismatch');
  if(['closed','paused','disabled','inactive'].includes(String(raw.status?.value).toLowerCase()))throw Error('409: Program is not accepting assessments');
  const rules=raw.rulesOfEngagement?.content;if(!rules||typeof rules.description!=='string')throw Error('409: Program rules are unavailable to this account');name=raw.name;
  policy=rules.description+'\nTesting requirements: '+JSON.stringify(rules.testingRequirements??{});
 }
 if(typeof name!=='string'||typeof policy!=='string'||!policy.trim()||policy.length>64000)throw Error('409: Review the selected program rules before testing');
 return {platform:config.platform,name,sourceURL:url,policy,checkedAt:Date.now()};
}
