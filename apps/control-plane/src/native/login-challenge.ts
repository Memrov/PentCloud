import type {VerificationProvider} from '../../../../shared/target-access';
export interface VerificationDelivery {id:string;to:string;from:string;sentAt:number;code?:string;links:string[];provider?:VerificationProvider;account?:string}
export interface VerificationScope {key:string;owner:string;recipient:string;sender:string;targetURL:string;purpose:'login'|'setup';provider?:VerificationProvider;account?:string}
interface Entry extends VerificationScope {operationId:string;createdAt:number;expiresAt:number;message?:VerificationDelivery}
interface IO {get(key:string):unknown;put(key:string,value:unknown):void;remove(key:string):unknown;list(prefix:string):Array<{key:string;value:unknown}>;now?:()=>number}
/** A pending code delivery, not an inbox or an archive. */
export class LoginChallenges {
 constructor(private readonly io:IO){}
 private now(){return(this.io.now??Date.now)();}
 private key(id:string){return 'verification:challenge:'+id;}
 clear(id:string){this.io.remove(this.key(id));}
 expire(){for(const row of this.io.list('verification:'))if((row.value as {expiresAt?:number}).expiresAt!<=this.now())this.io.remove(row.key);}
 begin(scope:VerificationScope,operationId:string){
  this.expire();const prior=this.io.get(this.key(scope.key)) as Entry|undefined;
  const others=this.io.list('verification:challenge:').filter(row=>{const e=row.value as Entry;return row.key!==this.key(scope.key)&&(e.provider??'cloudflare')===(scope.provider??'cloudflare')&&e.recipient.toLowerCase()===scope.recipient.toLowerCase();});
  if(others.some(row=>{const e=row.value as Entry;return e.purpose==='login'&&(scope.purpose==='setup'||e.account===scope.account);}))throw Error('409: Another login is pending for this target; finish it first');
  if(scope.provider==='agentmail'&&scope.purpose==='setup'&&others.length)throw Error('409: Another forwarding setup is pending; finish it first');
  if(scope.purpose==='login')for(const row of others)if((row.value as Entry).purpose==='setup')this.io.remove(row.key);
  if(prior?.owner===scope.owner&&prior.operationId===operationId)return {expiresAt:prior.expiresAt};
  if(this.io.list('verification:challenge:').length>=64&&!prior)throw Error('429: Too many pending verification requests');
  const entry:Entry={...scope,operationId,createdAt:Math.floor(this.now()/1000)*1000,expiresAt:this.now()+10*60*1000};this.io.put(this.key(scope.key),entry);return {expiresAt:entry.expiresAt};
 }
 receive(message:VerificationDelivery){
  this.expire();let delivered=false;
  if(!Number.isFinite(message.sentAt)||message.sentAt>this.now()+60000||!message.id||message.id.length>256)return false;
  for(const row of this.io.list('verification:challenge:')){
   const entry=row.value as Entry;if((entry.provider??'cloudflare')!==(message.provider??'cloudflare')||entry.account!==message.account||entry.recipient.toLowerCase()!==message.to.toLowerCase()||message.sentAt<entry.createdAt)continue;
   const from=message.from.toLowerCase(),domain=from.split('@')[1],sender=entry.sender.toLowerCase();
   if(sender.includes('@')?sender!==from:sender?domain!==sender&&!domain?.endsWith('.'+sender):entry.purpose!=='setup')continue;
   const seenKey='verification:seen:'+(entry.provider??'cloudflare')+':'+entry.recipient.toLowerCase(),seen=(this.io.get(seenKey) as {ids:string[];expiresAt:number}|undefined)?.ids??[];
   if(seen.includes(message.id))continue;
   this.io.put(seenKey,{ids:[...seen,message.id].slice(-32),expiresAt:this.now()+10*60*1000});
   this.io.put(row.key,{...entry,message:structuredClone(message)});delivered=true;
  }
  return delivered;
 }
 pending(key:string,owner:string){this.expire();const entry=this.io.get(this.key(key)) as Entry|undefined;if(entry?.owner===owner)return structuredClone(entry);}
 peek(key:string,owner:string){
  this.expire();const entry=this.io.get(this.key(key)) as Entry|undefined;
  if(!entry||entry.owner!==owner||!entry.message)return undefined;return structuredClone(entry.message);
 }
 consume(key:string,owner:string,messageId:string){
  this.expire();
  const entry=this.io.get(this.key(key)) as Entry|undefined;if(!entry||entry.owner!==owner||entry.message?.id!==messageId)throw Error('409: Verification message changed or expired');
  const {message:_message,...rest}=entry;this.io.put(this.key(key),rest);
 }
}
