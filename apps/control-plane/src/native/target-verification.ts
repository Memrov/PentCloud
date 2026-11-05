/** Small standards-based helpers; seeds and generated codes stay in trusted Workers. */
export function authenticator(value:string){
 try{
  if(value.length>2048)throw Error();let secret=value,digits=6,period=30,algorithm='SHA-1';
  if(value.startsWith('otpauth:')){
   const url=new URL(value);if(url.protocol!=='otpauth:'||url.hostname!=='totp')throw Error();
   for(const key of ['secret','digits','period','algorithm'])if(url.searchParams.getAll(key).length>1)throw Error();
   secret=url.searchParams.get('secret')??'';digits=Number(url.searchParams.get('digits')??6);period=Number(url.searchParams.get('period')??30);
   const name=(url.searchParams.get('algorithm')??'SHA1').toUpperCase();algorithm=({SHA1:'SHA-1',SHA256:'SHA-256',SHA512:'SHA-512'} as Record<string,string>)[name]??'';
  }
  const raw=secret.toUpperCase().replace(/[\s-]/g,'').replace(/=+$/,'');
  if(!/^[A-Z2-7]{16,256}$/.test(raw)||![6,8].includes(digits)||!Number.isInteger(period)||period<15||period>120||!algorithm)throw Error();
  let bits=0,buffer=0;const bytes:number[]=[];
  for(const char of raw){buffer=(buffer<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);bits+=5;if(bits>=8){bits-=8;bytes.push((buffer>>>bits)&255);buffer&=(1<<bits)-1;}}
  if(buffer!==0)throw Error();return {key:new Uint8Array(bytes),digits,period,algorithm};
 }catch{throw Error('409: Invalid authenticator secret. Use a Base32 seed or a TOTP setup URI.');}
}
export async function targetCode(value:string,now=Date.now()):Promise<string>{
 const {key,digits,period,algorithm}=authenticator(value);if(!Number.isFinite(now)||now<0)throw Error('409: Invalid authenticator time');
 const counter=new ArrayBuffer(8);new DataView(counter).setBigUint64(0,BigInt(Math.floor(now/1000/period)));
 const cryptoKey=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:algorithm},false,['sign']);
 const signature=new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,counter)),offset=signature[signature.length-1]!&15;
 const binary=((signature[offset]!&127)<<24)|(signature[offset+1]!<<16)|(signature[offset+2]!<<8)|signature[offset+3]!;
 return String(binary%(10**digits)).padStart(digits,'0');
}
export async function verificationAddress(base:string,targetId:string){
 if(!/^[a-z0-9._-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i.test(base)||!targetId||targetId.length>101)throw Error('409: Configure a valid verification email address');
 const [local,domain]=base.toLowerCase().split('@');if(domain==='localhost'||domain!.endsWith('.local'))throw Error('409: Invalid verification email address');
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(targetId));
 return local+'+'+[...new Uint8Array(hash)].slice(0,12).map(b=>b.toString(16).padStart(2,'0')).join('')+'@'+domain;
}
import {assertTargetRequest,type ScopedTarget} from '../../../../shared/target-access';
/** Short-lived codes may be shown to the current agent. Mail bodies and seeds are excluded. */
export function verificationChallenge(target:ScopedTarget,message:{code?:string;links:string[]}){
 const links=message.links.filter(url=>{try{assertTargetRequest(target,url);return new URL(url).protocol==='https:'&&new URL(url).origin===new URL(target.url).origin;}catch{return false;}});
 return {...(message.code?{code:message.code}:{}),links};
}
