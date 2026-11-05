import {it,expect,vi} from 'vitest';
const fixture=vi.hoisted(()=>({listeners:new Map<string,()=>void>(),root:new Map<string,(value:unknown)=>unknown>(),child:new Map<string,(value:unknown)=>unknown>(),sent:[] as {method:string;params:unknown}[]}));
vi.mock('@cloudflare/puppeteer',()=>({default:{connect:async()=>({
 target:()=>({createCDPSession:async()=>({on:(name:string,listener:(value:unknown)=>unknown)=>fixture.root.set(name,listener),send:async()=>({}),connection:()=>({session:()=>({on:(name:string,listener:(value:unknown)=>unknown)=>fixture.child.set(name,listener),send:async(method:string,params:unknown)=>{fixture.sent.push({method,params});return {};}})})})}),
 on:(event:string,listener:()=>void)=>fixture.listeners.set(event,listener),
 disconnect:async()=>fixture.listeners.get('disconnected')?.(),
})}}));
import {interceptBrowserContext} from '../src/native/browser-interception';
it('invalidates and retires managed access when the trusted CDP connection is lost',async()=>{
 let retired=0;
 const guard=await interceptBrowserContext({} as never,'fixture','context',async()=>new Headers(),async()=>{retired++;});
 await guard.disconnect();
 expect(retired).toBe(1);expect(()=>guard.assertConnected()).toThrow(/interception/i);
});
it('continues browser transport with edited headers on every hop without copying bodies or responses',async()=>{
 fixture.sent.length=0;const visited:string[]=[];
 const guard=await interceptBrowserContext({} as never,'fixture','context',async request=>{visited.push(request.url);if(request.url.endsWith('/excluded'))throw Error('excluded');return new Headers({...request.headers,'X-Researcher':'fixture'});});
 fixture.root.get('Target.attachedToTarget')!({sessionId:'child',targetInfo:{browserContextId:'context'}});
 await vi.waitFor(()=>expect(fixture.child.has('Fetch.requestPaused')).toBe(true));
 for(const url of ['https://example.com/login','https://example.com/redirect','https://example.com/excluded'])await fixture.child.get('Fetch.requestPaused')!({requestId:url,request:{url,method:'POST',headers:{Cookie:'login=private'},hasPostData:true}});
 expect(visited).toHaveLength(3);const continued=fixture.sent.filter(c=>c.method==='Fetch.continueRequest');
 expect(continued).toHaveLength(2);expect(continued[0]!.params).toMatchObject({headers:expect.arrayContaining([{name:'cookie',value:'login=private'},{name:'x-researcher',value:'fixture'}])});
 expect(continued[0]!.params).not.toHaveProperty('postData');expect(fixture.sent.some(c=>c.method==='Fetch.fulfillRequest')).toBe(false);
 expect(fixture.sent.filter(c=>c.method==='Fetch.failRequest')).toHaveLength(1);await guard.disconnect();
});
