import {it,expect,vi} from "vitest";
import {validateBrowserState,assertBrowserCommand,fillLogin,fillVerification} from "../src/native/browser-target-access";
const target={url:"https://example.com/",access:{headers:[],login:{url:"https://example.com/login",usernameBinding:"PENTCLOUD_TARGET_USER",passwordBinding:"PENTCLOUD_TARGET_PASS"}}};
it("retains native browser clicks, typing and viewport control",()=>{
 for(const method of ["Input.dispatchMouseEvent","Input.dispatchKeyEvent","Input.insertText","Emulation.setDeviceMetricsOverride"])expect(()=>assertBrowserCommand(target,method)).not.toThrow();
});
it("keeps only this target's authenticated state and rejects unrelated origins",()=>{
 const good={cookies:[{name:"session",value:"private-cookie",domain:"example.com",path:"/",expires:-1,httpOnly:true,secure:true,sameSite:"Lax"}],origins:[{origin:"https://example.com",localStorage:[{name:"auth",value:"private-token"}]}]};
 expect(validateBrowserState(target,good)).toEqual(good);
 expect(()=>validateBrowserState(target,{...good,cookies:[{...good.cookies[0],domain:"attacker.test"}]})).toThrow(/origin|target/);
 expect(()=>validateBrowserState(target,{cookies:[],origins:[{origin:"https://attacker.test",localStorage:[]}]})).toThrow();
});
it("prevents browser scripts from replacing the trusted network layer or opening another context",()=>{
 for(const method of ["Fetch.disable","Target.createBrowserContext","Target.sendMessageToTarget","ServiceWorker.enable","Network.loadNetworkResource","Network.setRequestInterception","Network.continueInterceptedRequest","Browser.close"])
  expect(()=>assertBrowserCommand(target,method,{})).toThrow(/managed/i);
 expect(()=>assertBrowserCommand(target,"Page.navigate",{url:"https://outside.test/"})).toThrow();
 expect(()=>assertBrowserCommand(target,"Page.navigate",{url:"https://example.com/login"})).not.toThrow();
 expect(()=>assertBrowserCommand(target,"Runtime.evaluate",{expression:"document.title"})).not.toThrow();
});
it("does not read a password when the page has left its credential audience",async()=>{
 let reads=0;await expect(fillLogin(target,{url:()=>"https://outside.test/",evaluate:async()=>{throw new Error("must not run");}} as never,{pageURL:"https://example.com/login",usernameSelector:"#username",passwordSelector:"#password"},async()=>{reads++;return "secret";})).rejects.toThrow();expect(reads).toBe(0);
});
it("pins the inspected login URL across asynchronous secret resolution",async()=>{
 let url="https://example.com/login",evaluated=false;
 const page={url:()=>url,evaluate:async()=>{evaluated=true;}};
 await expect(fillLogin(target,page as never,{pageURL:url,usernameSelector:'#user',passwordSelector:'#pass'},async()=>{url='https://example.com/untrusted';return 'secret';})).rejects.toThrow(/page|target/i);
 expect(evaluated).toBe(false);
});
it('fills a trusted verification code without returning it, fenced across async work',async()=>{
 let url='https://example.com/verify',filled='';const page={url:()=>url,evaluate:async(_fn:unknown,args:{code:string})=>{filled=args.code;}};
 const result=await fillVerification(target,page as never,{pageURL:url,codeSelector:'#code'},async()=> '384217');
 expect(filled).toBe('384217');expect(JSON.stringify(result)).not.toContain(filled);
 filled='';await expect(fillVerification(target,page as never,{pageURL:url,codeSelector:'#code'},async()=>{url='https://outside.test/';return '384217';})).rejects.toThrow();expect(filled).toBe('');
});
it('masks a filled verification code with the native password input before screenshots',async()=>{
 class Field {type='text';disabled=false;readOnly=false;private current='';set value(v:string){this.current=v;}get value(){return this.current;}dispatchEvent(){}}
 const field=new Field(),url='https://example.com/verify';
 vi.stubGlobal('HTMLInputElement',Field);vi.stubGlobal('document',{querySelector:()=>field,querySelectorAll:()=>[field]});vi.stubGlobal('location',{href:url});
 try{await fillVerification(target,{url:()=>url,evaluate:async(fn:Function,args:unknown)=>fn(args)} as never,{pageURL:url,codeSelector:'#code'},async()=> '384217');expect(field.value).toBe('384217');expect(field.type).toBe('password');}finally{vi.unstubAllGlobals();}
});
it('fills and masks the six separate one-character inputs used by real verification forms',async()=>{
 class Field {type='text';disabled=false;readOnly=false;maxLength=1;private current='';set value(v:string){this.current=v;}get value(){return this.current;}dispatchEvent(){}}
 const fields=Array.from({length:6},()=>new Field()),url='https://example.com/verify';
 vi.stubGlobal('HTMLInputElement',Field);vi.stubGlobal('document',{querySelector:()=>fields[0],querySelectorAll:()=>fields});vi.stubGlobal('location',{href:url});
 try{await fillVerification(target,{url:()=>url,evaluate:async(fn:Function,args:unknown)=>fn(args)} as never,{pageURL:url,codeSelector:'input[aria-label$="digit"]'},async()=> '384217');expect(fields.map(f=>f.value).join('')).toBe('384217');expect(fields.every(f=>f.type==='password'&&f.value.length===1)).toBe(true);}finally{vi.unstubAllGlobals();}
});
