import type {BrowserContext,Page} from "@cloudflare/playwright";
import type {BrowserConnection} from "agents/browser";
import {assertTargetRequest,type ScopedTarget} from "../../../../shared/target-access";
export type BrowserAuthState=Awaited<ReturnType<BrowserContext["storageState"]>>;
export interface LoginFields {pageURL:string;usernameSelector:string;passwordSelector:string}
export function validateBrowserState(target:ScopedTarget,raw:unknown):BrowserAuthState {
 if(JSON.stringify(raw).length>256*1024)throw new Error("413: Browser authentication state is too large");
 const state=raw as BrowserAuthState,host=new URL(target.url).hostname,origin=new URL(target.url).origin;
 if(!state||!Array.isArray(state.cookies)||!Array.isArray(state.origins)||state.cookies.length>200||state.origins.length>8)throw new Error("400: Invalid browser authentication state");
 for(const cookie of state.cookies){const domain=cookie.domain?.replace(/^\./,"");if(!domain||!(host===domain||host.endsWith("."+domain))||typeof cookie.value!=="string")throw new Error("403: Cookie origin does not match the target");}
 if(state.origins.some(item=>item.origin!==origin||!Array.isArray(item.localStorage)))throw new Error("403: Browser storage origin does not match the target");
 return structuredClone(state);
}
/** Keep the native browser tool, but do not expose policy-changing CDP operations. */
export function assertBrowserCommand(target:ScopedTarget,method:string,params:Record<string,unknown>={}){
 const targetMethods=new Set(["Target.getTargets","Target.getTargetInfo","Target.createTarget","Target.closeTarget","Target.activateTarget","Target.attachToTarget","Target.detachFromTarget"]);
 if(!(method.startsWith("Input.")||method.startsWith("Emulation.")||method.startsWith("Page.")||method.startsWith("DOM.")||method.startsWith("DOMSnapshot.")||method.startsWith("Accessibility.")||method.startsWith("Runtime.")||method.startsWith("Network.")||targetMethods.has(method)||method==="Browser.getVersion")||
  ["Network.loadNetworkResource","Network.setExtraHTTPHeaders","Page.setBypassCSP","Page.removeScriptToEvaluateOnNewDocument"].includes(method))throw new Error("403: This CDP operation is unavailable for managed targets");
 if((method==="Page.navigate"||method==="Target.createTarget")&&params.url!=="about:blank")assertTargetRequest(target,String(params.url));
 if(method==="Page.navigate"&&params.url==="about:blank")return;
}
/** Scope the SDK's existing CDP capability to one private browser context. */
export function guardBrowserCDP(client:BrowserConnection["cdp"],target:ScopedTarget,contextId:string,assertReady:()=>void=()=>{}){
 const sessions=new Set<string>();
 const permitted=async(targetId:string)=>{
  assertReady();
  const result=await client.send("Target.getTargets") as {targetInfos:{targetId:string;browserContextId?:string}[]};
  if(!result.targetInfos.some(t=>t.targetId===targetId&&t.browserContextId===contextId))throw new Error("403: Browser target is outside this managed context");
 };
 return new Proxy(client,{get:(client,key)=>{
  if(key==="attachToTarget")return async(id:string,opts?:Parameters<typeof client.attachToTarget>[1])=>{await permitted(id);const session=await client.attachToTarget(id,opts);sessions.add(session);return session;};
  if(key==="send")return async(method:string,raw:Record<string,unknown>={},opts?:Parameters<typeof client.send>[2])=>{
   assertReady();
   assertBrowserCommand(target,method,raw);
   if(opts?.sessionId&&!sessions.has(opts.sessionId)||typeof raw.sessionId==="string"&&!sessions.has(raw.sessionId))throw new Error("403: Unowned CDP session");
   const params={...raw};if(method==="Target.createTarget")params.browserContextId=contextId;
   if(typeof params.targetId==="string")await permitted(params.targetId);
   const result=await client.send(method,params,opts);
   if(method==="Target.getTargets")return {targetInfos:(result as {targetInfos:{browserContextId?:string}[]}).targetInfos.filter(t=>t.browserContextId===contextId)};
   if(method==="Target.attachToTarget"&&result&&typeof result==="object"&&"sessionId" in result)sessions.add(String(result.sessionId));
   return result;
  };
  const value=Reflect.get(client,key,client);return typeof value==="function"?value.bind(client):value;
 }});
}
export async function fillLogin(target:ScopedTarget,page:Page,input:LoginFields,resolve:(name:string)=>Promise<string>){
 const config=target.access?.login;if(!config)throw new Error("409: Configure login references on the saved target first");
 const audience={...target,url:config.url};assertTargetRequest(audience,input.pageURL);assertTargetRequest(audience,page.url());
 if(new URL(page.url()).href!==new URL(input.pageURL).href)throw new Error("409: Login page changed; inspect it again");
 const verifiedURL=page.url();
 for(const selector of [input.usernameSelector,input.passwordSelector])if(typeof selector!=="string"||!selector||selector.length>512)throw new Error("400: Choose bounded login field selectors");
 const username=await resolve(config.usernameBinding),password=await resolve(config.passwordBinding);
 assertTargetRequest(audience,page.url());
 if(page.url()!==verifiedURL)throw new Error("409: Login page changed; inspect it again");
 await page.evaluate(({url,userSelector,passwordSelector,username,password})=>{
  if(location.href!==url)throw new Error("Login page changed");
  const user=document.querySelector(userSelector),pass=document.querySelector(passwordSelector);
  if(!(user instanceof HTMLInputElement)||!(pass instanceof HTMLInputElement)||pass.type!=="password"||user===pass||user.disabled||pass.disabled||user.readOnly||pass.readOnly)throw new Error("Choose editable username and password fields");
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;
  set.call(user,username);user.dispatchEvent(new Event("input",{bubbles:true}));user.dispatchEvent(new Event("change",{bubbles:true}));
  set.call(pass,password);pass.dispatchEvent(new Event("input",{bubbles:true}));pass.dispatchEvent(new Event("change",{bubbles:true}));
 },{url:verifiedURL,userSelector:input.usernameSelector,passwordSelector:input.passwordSelector,username,password});
 return {filled:true as const,message:"Credentials filled. Submit using the browser tool and verify the authenticated result."};
}
