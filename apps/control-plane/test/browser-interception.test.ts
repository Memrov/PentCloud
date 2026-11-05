import {it,expect,vi} from 'vitest';
const fixture=vi.hoisted(()=>({listeners:new Map<string,()=>void>()}));
vi.mock('@cloudflare/puppeteer',()=>({default:{connect:async()=>({
 target:()=>({createCDPSession:async()=>({on:()=>{},send:async()=>({})})}),
 on:(event:string,listener:()=>void)=>fixture.listeners.set(event,listener),
 disconnect:async()=>fixture.listeners.get('disconnected')?.(),
})}}));
import {interceptBrowserContext} from '../src/native/browser-interception';
it('invalidates and retires managed access when the trusted CDP connection is lost',async()=>{
 let retired=0;
 const guard=await interceptBrowserContext({} as never,'fixture','context',async()=>new Response(),async()=>{retired++;});
 await guard.disconnect();
 expect(retired).toBe(1);expect(()=>guard.assertConnected()).toThrow(/interception/i);
});
