import {boundedText} from './target-check';
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
  const a=raw.data?.attributes;if(a?.handle!==id)throw Error('502: Program identity mismatch');if(a.submission_state!=='open')throw Error('409: Program is not accepting assessments');name=a.name;policy=a.policy;
 }else{
  if(raw.id?.toLowerCase()!==id.toLowerCase())throw Error('502: Program identity mismatch');
  if(['closed','paused','disabled','inactive'].includes(String(raw.status?.value).toLowerCase()))throw Error('409: Program is not accepting assessments');
  const rules=raw.rulesOfEngagement?.content;if(!rules||typeof rules.description!=='string')throw Error('409: Program rules are unavailable to this account');name=raw.name;
  policy=rules.description+'\nTesting requirements: '+JSON.stringify(rules.testingRequirements??{});
 }
 if(typeof name!=='string'||typeof policy!=='string'||!policy.trim()||policy.length>64000)throw Error('409: Review the selected program rules before testing');
 return {platform:config.platform,name,sourceURL:url,policy,checkedAt:Date.now()};
}
