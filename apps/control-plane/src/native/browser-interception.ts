import puppeteer,{type CDPSession} from "@cloudflare/puppeteer";
import {Buffer} from "node:buffer";
import {boundedEvidenceBytes} from "./evidence";

/** Native CDP interception includes redirects, which Playwright context.route skips.
 * New page/iframe/worker targets pause until their interception is installed. */
export async function interceptBrowserContext(binding:Parameters<typeof puppeteer.connect>[0],sessionId:string,contextId:string,fetcher:(request:Request)=>Promise<Response>,onDisconnect:()=>Promise<void>=async()=>{}){
 const browser=await puppeteer.connect(binding,sessionId),root=await browser.target().createCDPSession();
 let connected=true,retirement:Promise<void>|undefined;
 const retire=()=>{connected=false;if(!retirement){retirement=Promise.resolve().then(onDisconnect);void retirement.catch(()=>undefined);}return retirement;};
 browser.on("disconnected",()=>{void retire();});
 const pending=new Set<Promise<void>>();let failure:unknown;
 const install=async(session:CDPSession,owned:boolean)=>{
  session.on("Fetch.requestPaused",async event=>{
   try{
    const r=event.request;
    if(!/^https?:/.test(r.url))throw new Error("Unsupported browser transport");
    let body:Buffer|undefined;
    if(r.postDataEntries?.length){if(r.postDataEntries.some(entry=>entry.bytes===undefined))throw new Error("Unresolved browser upload");body=Buffer.concat(r.postDataEntries.map(entry=>Buffer.from(entry.bytes!,"base64")));}
    else if(r.postData!==undefined)body=Buffer.from(r.postData);
    else if(r.hasPostData)throw new Error("Unresolved browser upload");
    const response=await fetcher(new Request(r.url,{method:r.method,headers:r.headers,...(body?{body:new Uint8Array(body)}:{})}));
    const bytes=response.body?await boundedEvidenceBytes(response,8*1024*1024):new Uint8Array();
    const responseHeaders=[...response.headers].filter(([name])=>!["set-cookie","content-length","content-encoding"].includes(name)).map(([name,value])=>({name,value}));
    for(const value of response.headers.getSetCookie())responseHeaders.push({name:"set-cookie",value});
    await session.send("Fetch.fulfillRequest",{requestId:event.requestId,responseCode:response.status,responseHeaders,body:Buffer.from(bytes).toString("base64")});
   }catch{await session.send("Fetch.failRequest",{requestId:event.requestId,errorReason:"BlockedByClient"}).catch(()=>undefined);}
  });
  session.on("Target.attachedToTarget",event=>{
   const child=session.connection()?.session(event.sessionId);if(!child)return;
   const allowed=event.targetInfo.browserContextId===contextId||(owned&&!event.targetInfo.browserContextId);
   const work=(async()=>{
    if(allowed)await install(child,true);
    await child.send("Runtime.runIfWaitingForDebugger").catch(error=>{if(allowed)throw error;});
    if(!allowed)await child.detach().catch(()=>undefined);
   })().catch(async error=>{if(allowed){failure=error;await root.send("Target.closeTarget",{targetId:event.targetInfo.targetId}).catch(()=>undefined);await retire();}});
   pending.add(work);void work.finally(()=>pending.delete(work));
  });
  if(owned)await session.send("Fetch.enable",{patterns:[{urlPattern:"*",requestStage:"Request"}]});
  await session.send("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
 };
 try{
  await install(root,false);while(pending.size)await Promise.all([...pending]);
  if(failure)throw failure;
  return {assertConnected:()=>{if(!connected||failure)throw new Error("503: Browser interception lost; reconnect with a new guarded session");},disconnect:async()=>{await browser.disconnect();await retire();}};
 }catch(error){await browser.disconnect();await retire();throw error;}
}
