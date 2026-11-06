import {digest} from "./domain";
interface Receipt {name:string;state:string;fingerprint:string;arguments?:Record<string,unknown>;result?:unknown;startedAt?:number}
/** Pack calls share the attempt's durable remote fence; an uncertain RPC is never replayed. */
export async function journalPackCall(storage:DurableObjectStorage,key:string,input:Record<string,unknown>,send:()=>Promise<unknown>):Promise<unknown> {
  const fingerprint=await digest(input);
  const reservation=await storage.transaction(async tx=>{
    const attempt=await tx.get<{result?:unknown;proposal?:unknown}>("attempt");
    if(attempt?.result||attempt?.proposal||await tx.get("cancelled"))throw Error("409: Attempt stopped");
    const current=await tx.get<Receipt>(key);
    if(current){
      if(current.fingerprint!==fingerprint)throw Error("409: Tool call identity changed");
      if(["completed","reconciled"].includes(current.state))return {dispatch:false as const,result:current.result};
      throw Error("409: Tool outcome is unknown or already started; automatic retry is fenced");
    }
    if([...await tx.list<Receipt>({prefix:"remote:"})].some(([,r])=>["started","unknown","running"].includes(r.state)))throw Error("409: Another remote operation is unresolved");
    await tx.put(key,{name:"pentcloud_tool",state:"started",fingerprint,arguments:input,startedAt:Date.now()} satisfies Receipt);
    return {dispatch:true as const};
  });
  if(!reservation.dispatch)return reservation.result;
  try {
    const result=await send(),record=(await storage.get<Receipt>(key))!;
    await storage.put(key,{...record,state:"completed",result});return result;
  }catch {
    const record=await storage.get<Receipt>(key);
    if(record?.state!=="completed")await storage.put(key,{...record!,state:"unknown"});
    throw Error("409: Tool outcome is unknown; do not repeat the scan");
  }
}

/** Keep machine-readable discovery metadata independent from the bounded model preview. */
export function packResultPreview(value:unknown,pack:string,evidence:string[]):Record<string,unknown>{
 const r=value as Record<string,unknown>;let httpStatus:unknown;
 if(pack==="web-context"&&typeof r.stdout==="string")try{const parsed=JSON.parse(r.stdout);httpStatus=(Array.isArray(parsed)?parsed[0]:parsed)?.http_status;}catch{}
 const serialized=JSON.stringify(value);
 if(serialized.length<=30000)return {...r,httpStatus,evidence};
 return {pack,exitCode:r.exitCode,timedOut:r.timedOut,truncated:r.truncated,image:r.image,instance:r.instance,toolVersion:r.toolVersion,httpStatus,stdout:typeof r.stdout==="string"?r.stdout.slice(0,18000):undefined,stderr:typeof r.stderr==="string"?r.stderr.slice(0,4000):undefined,preview:typeof r.stdout!=="string"?serialized.slice(0,22000):undefined,modelPreviewTruncated:true,evidence};
}

/** Replay against the original request identity before touching mutable workspace files. */
export async function replayPackCall(storage:DurableObjectStorage,key:string,requestDigest:string):Promise<{result:unknown}|undefined>{
 const receipt=await storage.get<Receipt>(key);if(!receipt)return;
 if(receipt.arguments?.requestDigest!==requestDigest)throw Error("409: Tool call identity changed");
 if(["completed","reconciled"].includes(receipt.state))return {result:receipt.result};
 throw Error("409: Tool outcome is unknown or already started; automatic retry is fenced");
}
