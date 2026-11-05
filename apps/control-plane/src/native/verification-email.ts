import PostalMime from 'postal-mime';
import type {VerificationDelivery} from './login-challenge';
type Input={to:string;headers:Headers;raw:string|ReadableStream<Uint8Array>};
/** Headers joins duplicates with commas. Only the first, prepended result is trusted.
 * Quoted strings and RFC comments cannot supply authentication method results. */
function authenticationResult(value:string){
 if(value.length>16384)return;let comment=0,quoted=false,escaped=false,first='';
 for(const char of value){
  if(escaped){escaped=false;continue;}
  if(char==='\\'&&(comment||quoted)){escaped=true;continue;}
  if(comment){if(char==='(')comment++;else if(char===')')comment--;continue;}
  if(quoted){if(char==='"')quoted=false;continue;}
  if(char==='('){comment++;first+=' ';continue;}
  if(char===')')return;
  if(char==='"'){quoted=true;first+=' ';continue;}
  if(char===',')break;first+=char;
 }
 return !comment&&!quoted&&!escaped&&/^mx\.cloudflare\.net\s*;/i.test(first)?first:undefined;
}
/** Only Cloudflare-authenticated, bounded verification data is retained. */
export async function readVerificationEmail(input:Input):Promise<VerificationDelivery|undefined>{
 const auth=authenticationResult(input.headers.get('Authentication-Results')??'');if(!auth)return;
 let bytes:Uint8Array;
 if(typeof input.raw==='string'){bytes=new TextEncoder().encode(input.raw);if(bytes.length>256*1024)return;}
 else{
  const reader=input.raw.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>256*1024)return;chunks.push(part.value);}bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 try{
  const email=await PostalMime.parse(bytes),from=email.from?.address?.toLowerCase(),sentAt=Date.parse(email.date??'');
  if(!from||!Number.isFinite(sentAt)||!input.to||/[\r\n]/.test(input.to))return;
  if(/(?:^|;)\s*dmarc=fail(?:\s|;|$)/i.test(auth))return;
  if(!/(?:^|;)\s*dmarc=pass(?:\s|;|$)/i.test(auth)&&![...auth.matchAll(/(?:^|;)\s*dkim=pass(?:\s+([^;]*))?(?=;|$)/gi)].some(m=>m[1]?.match(/\bheader\.d=([a-z0-9.-]+)(?=\s|$)/i)?.[1]?.toLowerCase()===from.split('@')[1]))return;
  const content=verificationContent(email.text,email.html);if(!content)return;
  const id=email.messageId?.trim();if(!id||id.length>256||/[\r\n]/.test(id))return;
  return {id,to:input.to.toLowerCase(),from,sentAt,...content};
 }catch{return undefined;}
}
/** Shared deterministic extraction; mail is data, never agent instructions. */
export function verificationContent(plain?:string,html?:string):Pick<VerificationDelivery,'code'|'excerpt'|'links'>|undefined{
  const text=(plain?.trim()?plain:html?.replace(/<[^>]*>/g,' ')??'').slice(0,32000);
  const marked=[...text.matchAll(/(?:verification|confirmation|security|login|one[- ]time|authentication|code|otp)[^\d\r\n]{0,48}\b(\d{4,10})\b/gi)].map(m=>m[1]!);
  const candidates=[...new Set(marked.length?marked:[...text.matchAll(/\b\d{4,10}\b/g)].map(m=>m[0]).filter(v=>!(v.length===4&&Number(v)>=1900&&Number(v)<=2100)))];
  const links=[...new Set([...((html??'').slice(0,32000)+' '+text).matchAll(/https:\/\/[^\s<>"']+/g)].map(m=>m[0].replace(/&amp;/g,'&').replace(/[).,]+$/,'')))].filter(value=>{try{const u=new URL(value);return !u.username&&!u.password&&value.length<=2048;}catch{return false;}}).slice(0,8);
  const code=candidates.length===1?candidates[0]:undefined,excerpt=code?undefined:text.trim().slice(0,1000);
  if(!code&&!links.length&&!excerpt)return;
  return {...(code?{code}:{}),...(excerpt?{excerpt}:{}),links};
}
