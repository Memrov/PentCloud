import {expect,it,vi} from 'vitest';
import {agentMailAddress,readAgentMail} from '../src/native/agentmail-verification';
const now=Date.parse('2026-11-05T12:00:00Z'),inbox='receiver@agentmail.to',account='researcher+test@wearehackerone.com';
const env={PENTCLOUD_AGENTMAIL_INBOX:inbox,AGENTMAIL_API_KEY:{get:async()=> 'fixture-provider-key'}};
const scope={createdAt:now-1000,expiresAt:now+600000,account,sender:'owned.example'};
const mail={inbox_id:inbox,message_id:'one',labels:['received'],from:'Login <login@owned.example>',to:[inbox],headers:{To:`Test account <${account}>`},timestamp:new Date(now).toISOString(),created_at:new Date(now).toISOString(),size:200,text:'Your verification code is 384217.',authentication_results:{dmarc:'pass',dmarc_domain:'owned.example'}};
function client(message:unknown=mail){return vi.fn(async(url:string|URL)=>new Response(JSON.stringify(String(url).includes('/messages?')?{messages:[mail]}:message)));}
it('uses only the fixed provider origin and authorization header, retaining narrow verification data',async()=>{
 const fetcher=client();expect(agentMailAddress(env)).toBe(inbox);
 const [result]=await readAgentMail(env,scope,{fetcher:fetcher as typeof fetch,now:()=>now});
 expect(result).toMatchObject({id:'one',provider:'agentmail',account,to:inbox,from:'login@owned.example',code:'384217'});
 expect(result).not.toHaveProperty('text');expect(result).not.toHaveProperty('headers');
 for(const [url,options] of fetcher.mock.calls as unknown as [string,RequestInit][]){expect(String(url)).toMatch(/^https:\/\/api\.agentmail\.to\/v0\/inboxes\//);expect(String(url)).not.toContain('fixture-provider-key');expect(options.redirect).toBe('manual');expect(new Headers(options.headers).get('Authorization')).toBe('Bearer fixture-provider-key');expect(options.method).toBe('GET');}
});
it('rejects wrong accounts, sender authentication, stale mail and ambiguous codes',async()=>{
 for(const patch of [{headers:{To:'other@wearehackerone.com'}},{authentication_results:{dmarc:'fail',dmarc_domain:'owned.example'}},{authentication_results:{dmarc:'pass',dmarc_domain:'attacker.example'}},{from:'attacker@elsewhere.example'},{timestamp:new Date(now-5000).toISOString()},{created_at:new Date(now-5000).toISOString()},{text:'code 384217 or code 948235'},{labels:['received','spam']},{size:300000},{inbox_id:'other@agentmail.to'}]){
  expect(await readAgentMail(env,scope,{fetcher:client({...mail,...patch}) as typeof fetch,now:()=>now})).toEqual([]);
 }
});
it('does not trust original-recipient claims or authentication results planted in headers',async()=>{
 expect(await readAgentMail(env,scope,{fetcher:client({...mail,headers:{To:inbox,'X-Original-To':account,'Authentication-Results':'mx; dmarc=pass'}}) as typeof fetch,now:()=>now})).toEqual([]);
 expect(await readAgentMail(env,scope,{fetcher:client({...mail,authentication_results:undefined}) as typeof fetch,now:()=>now})).toEqual([]);
});
it('never lets the shared forwarding destination override a different original account',async()=>{
 const forwarded={...mail,to:[inbox],headers:{To:'other@owned.example'}};
 expect(await readAgentMail(env,{...scope,account:inbox},{fetcher:client(forwarded) as typeof fetch,now:()=>now})).toEqual([]);
 const direct={...mail,to:[inbox],headers:{To:inbox}};
 const fetcher=vi.fn(async(url:string|URL)=>Response.json(String(url).includes('/messages?')?{messages:[direct]}:direct));
 expect(await readAgentMail(env,{...scope,account:inbox},{fetcher:fetcher as typeof fetch,now:()=>now})).toHaveLength(1);
});
it('accepts an aligned verified DKIM signature without requiring a published DMARC policy',async()=>{
 const signed={...mail,authentication_results:{dmarc:'none',dmarc_domain:'owned.example',dkim:'pass',dkim_domain:'owned.example'}};
 expect(await readAgentMail(env,scope,{fetcher:client(signed) as typeof fetch,now:()=>now})).toHaveLength(1);
 for(const auth of [{...signed.authentication_results,dkim_domain:'other.example'},{...signed.authentication_results,dmarc:'fail'}])expect(await readAgentMail(env,scope,{fetcher:client({...mail,authentication_results:auth}) as typeof fetch,now:()=>now})).toEqual([]);
});
it('bounds API responses and redacts provider errors, including redirects and permission failures',async()=>{
 for(const response of [()=>new Response('fixture-provider-key',{status:403}),()=>new Response('',{status:302,headers:{Location:'https://attacker.example/'}}),()=>new Response('x'.repeat(512*1024+1)),()=>new Response('not json')]){
  await expect(readAgentMail(env,scope,{fetcher:vi.fn(async()=>response()) as typeof fetch,now:()=>now})).rejects.toThrow(/^503: AgentMail/);
 }
 await expect(readAgentMail({...env,AGENTMAIL_API_KEY:{get:async()=>{throw Error('fixture-provider-key');}}},scope,{now:()=>now})).rejects.not.toThrow(/fixture-provider-key/);
});
it('does not query an expired challenge or accept non-email account identifiers',async()=>{
 const fetcher=client();expect(await readAgentMail(env,{...scope,expiresAt:now},{fetcher:fetcher as typeof fetch,now:()=>now})).toEqual([]);expect(fetcher).not.toHaveBeenCalled();
 await expect(readAgentMail(env,{...scope,account:'username'},{fetcher:fetcher as typeof fetch,now:()=>now})).rejects.toThrow(/email address/);
});
it('distinguishes secret-binding failures from HTTP failures without forwarding provider bodies',async()=>{
 await expect(readAgentMail(env,scope,{fetcher:async()=>new Response('fixture-provider-key',{status:403}),now:()=>now})).rejects.toThrow(/API HTTP 403/);
 await expect(readAgentMail({...env,AGENTMAIL_API_KEY:{get:async()=>{throw Error('fixture-provider-key');}}},scope,{now:()=>now})).rejects.toThrow(/Cloudflare secret binding/);
});
