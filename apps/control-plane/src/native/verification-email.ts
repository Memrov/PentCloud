import PostalMime from 'postal-mime';
import type {VerificationDelivery} from './login-challenge';
type Input={to:string;headers:Headers;raw:string|ReadableStream<Uint8Array>};
/** Only Cloudflare-authenticated, bounded verification data is retained. */
export async function readVerificationEmail(input:Input):Promise<VerificationDelivery|undefined>{
 const result=input.headers.get('Authentication-Results')??'',first=result.split(/,\s*(?=[^;,\s]+;)/)[0]??'';
 if(!/^mx\.cloudflare\.net\s*;/i.test(first)||!/(?:^|;)\s*dmarc=pass(?:\s|;|$)/i.test(first))return;
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
  const text=(email.text??email.html?.replace(/<[^>]*>/g,' ')??'').slice(0,32000);
  const marked=[...text.matchAll(/(?:verification|confirmation|security|login|one[- ]time|authentication|code|otp)[^\d\r\n]{0,48}\b(\d{4,10})\b/gi)].map(m=>m[1]!);
  const candidates=[...new Set(marked.length?marked:[...text.matchAll(/\b\d{4,10}\b/g)].map(m=>m[0]).filter(v=>!(v.length===4&&Number(v)>=1900&&Number(v)<=2100)))];
  if(candidates.length>1)return;
  const links=[...new Set([...((email.html??'')+' '+text).matchAll(/https:\/\/[^\s<>"']+/g)].map(m=>m[0].replace(/&amp;/g,'&').replace(/[).,]+$/,'')))].filter(value=>{try{const u=new URL(value);return !u.username&&!u.password&&value.length<=2048;}catch{return false;}}).slice(0,8);
  if(!candidates.length&&!links.length)return;
  const id=email.messageId?.trim();if(!id||id.length>256||/[\r\n]/.test(id))return;
  return {id,to:input.to.toLowerCase(),from,sentAt,...(candidates[0]?{code:candidates[0]}:{}),links};
 }catch{return undefined;}
}
