import {addressParser} from 'postal-mime';
import {verificationContent} from './verification-email';
import type {VerificationDelivery} from './login-challenge';
type Env={PENTCLOUD_AGENTMAIL_INBOX?:string;AGENTMAIL_API_KEY?:string|{get():Promise<string>}};
type Window={createdAt:number;expiresAt:number;account?:string;sender:string};
const email=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export function agentMailAddress(env:Env){const value=env.PENTCLOUD_AGENTMAIL_INBOX?.trim().toLowerCase();return value&&email.test(value)&&env.AGENTMAIL_API_KEY?value:undefined;}
function addresses(value:string){try{return addressParser(value,{flatten:true}).flatMap(a=>a.address?[a.address.toLowerCase()]:[]);}catch{return [];}}
function senderMatches(from:string,sender:string){const domain=from.split('@')[1];return !sender||(sender.includes('@')?from===sender:domain===sender||domain?.endsWith('.'+sender));}
function recipientMatches(m:Record<string,any>,account?:string){
 if(!account)return true;
 const originalTo=Object.entries(m.headers??{}).find(([k])=>k.toLowerCase()==='to')?.[1];
 const recipients=(typeof originalTo==='string'?[originalTo]:Array.isArray(m.to)?m.to:[]).flatMap(v=>typeof v==='string'?addresses(v):[]);
 return recipients.length===1&&recipients[0]===account.toLowerCase();
}
async function boundedJSON(response:Response){
 if(!response.ok||response.redirected||!response.body){await response.body?.cancel();throw Error('unavailable');}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>512*1024)throw Error('too large');chunks.push(item.value);}const bytes=new Uint8Array(size);let at=0;for(const item of chunks){bytes.set(item,at);at+=item.length;}return JSON.parse(new TextDecoder().decode(bytes));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Only called for a pending verification. Never returns bodies, attachments or provider errors. */
export async function readAgentMail(env:Env,window:Window,options:{fetcher?:typeof fetch;now?:()=>number}={}):Promise<VerificationDelivery[]>{
 const now=options.now??Date.now;if(window.expiresAt<=now())return [];
 const inbox=agentMailAddress(env);if(!inbox)throw Error('409: Configure the AgentMail inbox and AGENTMAIL_API_KEY binding in Cloudflare');
 if(window.account&&!email.test(window.account))throw Error('409: AgentMail needs an email address in the target username secret; use Cloudflare receiving for other usernames');
 let stage='Cloudflare secret binding';try{
  const binding=env.AGENTMAIL_API_KEY!,key=typeof binding==='string'?binding:await binding.get();if(!key||key.length>8192||/[\r\n\0]/.test(key))throw Error('key');
  const prefix='https://api.agentmail.to/v0/inboxes/'+encodeURIComponent(inbox)+'/messages';
  const deadline=AbortSignal.timeout(Math.max(1,Math.min(8000,window.expiresAt-now())));
  const get=async(url:string)=>{stage='network';const response=await (options.fetcher??fetch)(url,{method:'GET',headers:{Authorization:'Bearer '+key},redirect:'manual',signal:deadline});stage=response.ok?'response format':'API HTTP '+response.status;return boundedJSON(response);};
  const query=new URLSearchParams({limit:'20',labels:'received',after:new Date(window.createdAt-1000).toISOString()});
  const list=await get(prefix+'?'+query);if(!Array.isArray(list.messages)||list.messages.length>20)throw Error('shape');
  const delivered:VerificationDelivery[]=[];
  // Most recent first. Inspect at most three plausible messages per check.
  const candidates=list.messages.filter((m:Record<string,unknown>)=>typeof m?.message_id==='string'&&senderMatches(addresses(String(m.from??''))[0]??'',window.sender)&&recipientMatches(m,window.account)&&Date.parse(String(m.timestamp))>=window.createdAt).slice(0,3);
  for(const candidate of candidates){
   if(now()>=window.expiresAt)break;
   const m=await get(prefix+'/'+encodeURIComponent(candidate.message_id));
   const froms=addresses(String(m.from??'')),from=froms[0],auth=m.authentication_results;
   const domain=from?.split('@')[1],authenticated=auth?.dmarc!=='fail'&&(auth?.dmarc==='pass'&&auth.dmarc_domain?.toLowerCase()===domain||auth?.dkim==='pass'&&auth.dkim_domain?.toLowerCase()===domain);
   if(m.inbox_id!==inbox||m.message_id!==candidate.message_id||m.message_id.length>256||froms.length!==1||!from||!senderMatches(from,window.sender)||!authenticated||!Array.isArray(m.labels)||!m.labels.includes('received')||m.labels.some((v:unknown)=>typeof v==='string'&&/spam|blocked|unauthenticated|trash/i.test(v))||!Number.isFinite(m.size)||m.size>256*1024)continue;
   const sentAt=Date.parse(m.timestamp),receivedAt=Date.parse(m.created_at);if(!Number.isFinite(sentAt)||!Number.isFinite(receivedAt)||sentAt<window.createdAt||receivedAt<window.createdAt||sentAt>now()+60000||receivedAt>now()+60000)continue;
   if(!recipientMatches(m,window.account)||!m.message_id||/[\r\n]/.test(m.message_id)||m.size<0)continue;
   if(m.text!==undefined&&typeof m.text!=='string'||m.html!==undefined&&typeof m.html!=='string')continue;
   const content=verificationContent(m.text,m.html);if(!content)continue;
   delivered.push({id:m.message_id,provider:'agentmail',to:inbox,from,sentAt,...(window.account?{account:window.account}:{}),...content});
  }
  return delivered;
 }catch{throw Error('503: AgentMail '+stage+' unavailable; check the inbox binding and message-read permission, then retry');}
}
