import {describe,expect,it} from "vitest";
import {journalAPIRequest} from "../src/native/api-operation";
function storage(){
  const records=new Map<string,unknown>();let queue=Promise.resolve();
  const state={
    get:async(k:string)=>structuredClone(records.get(k)),
    put:async(k:string,v:unknown)=>{records.set(k,structuredClone(v));},
    list:async({prefix}:{prefix:string})=>new Map([...records].filter(([k])=>k.startsWith(prefix))),
    transaction:<T>(fn:(tx:any)=>Promise<T>)=>{const p=queue.then(()=>fn(state));queue=p.then(()=>undefined,()=>undefined);return p;},
  };return state as unknown as DurableObjectStorage;
}
describe("native API mutation receipts",()=>{
  it("dispatches an overlapping mutation identity once and replays only its durable result",async()=>{
    const state=storage();let entered!:()=>void,release!:()=>void,count=0;
    const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    const input={path:"https://owned.example/v1/items",method:"POST" as const,body:"{}"};
    const send=async()=>{count++;entered();await gate;return {status:201};};
    const first=journalAPIRequest(state,"remote:api-same",input,send);
    await started;
    await expect(journalAPIRequest(state,"remote:api-same",input,send)).rejects.toThrow(/unknown|already|unresolved/);
    release();expect(await first).toEqual({status:201});
    expect(await journalAPIRequest(state,"remote:api-same",input,send)).toEqual({status:201});
    expect(count).toBe(1);
  });
  it("retains an uncertain mutation and refuses a blind retry",async()=>{
    const state=storage(),input={path:"https://owned.example/v1/items",method:"DELETE" as const};
    let sends=0;const send=async()=>{sends++;throw new Error("connection lost");};
    await expect(journalAPIRequest(state,"remote:api-lost",input,send)).rejects.toThrow(/unknown/);
    await expect(journalAPIRequest(state,"remote:api-lost",input,send)).rejects.toThrow(/unknown/);
    expect(sends).toBe(1);
  });
});
