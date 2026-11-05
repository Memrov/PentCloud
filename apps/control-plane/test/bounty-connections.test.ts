import {expect,it} from 'vitest';
import {BountyConnections} from '../src/native/bounty-platform';

function fixture(){
 const records=new Map<string,unknown>(),env:Record<string,unknown>={PENTCLOUD_HACKERONE_USERNAME:'researcher',PENTCLOUD_HACKERONE_API_TOKEN:{get:async()=> 'fixture-only-token'}};
 let now=1000,requests:Request[]=[],reply=()=>Response.json({data:[]});
 const connections=new BountyConnections(env,{get:k=>records.get(k) as never,put:(k,v)=>records.set(k,v),remove:k=>records.delete(k),now:()=>now,fetcher:async(url,options)=>{requests.push(new Request(url,options));return reply();}});
 return {connections,records,env,requests,advance:(ms:number)=>{now+=ms;},reply:(fn:()=>Response)=>{reply=fn;}};
}
const jwt=(expiresAt:number)=>'eyJhbGciOiJIUzI1NiJ9.'+btoa(JSON.stringify({exp:expiresAt})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')+'.fixture-signature';
it('checks Bugcrowd with its Hacker API token pair and read-only engagement permission',async()=>{
 const f=fixture();f.env.PENTCLOUD_BUGCROWD_API_TOKEN='Token fixture-id:fixture-secret';f.reply(()=>Response.json({data:[],pagination:{has_more:false}}));
 expect((await f.connections.check('bugcrowd')).status).toBe('ready');expect(f.requests[0]?.url).toBe('https://hacker-api.bugcrowd.com/v1/engagements?limit=1');
 expect(f.requests[0]?.headers.get('Authorization')).toBe('Token fixture-id:fixture-secret');
 expect(JSON.stringify([...f.records.values()])).not.toContain('fixture-secret');
 f.env.PENTCLOUD_BUGCROWD_API_TOKEN='not-a-pair';await expect(f.connections.check('bugcrowd')).rejects.toThrow(/ID:secret/);
});
it('requires an authenticated YesWeHack profile and expires readiness with the researcher JWT',async()=>{
 const f=fixture();f.env.PENTCLOUD_YESWEHACK_API_TOKEN=jwt(61);f.reply(()=>Response.json({username:'fixture-researcher'}));
 expect((await f.connections.check('yeswehack')).status).toBe('ready');expect(f.requests[0]?.url).toBe('https://api.yeswehack.com/user');
 expect(f.requests[0]?.headers.get('Authorization')).toBe('Bearer '+f.env.PENTCLOUD_YESWEHACK_API_TOKEN);expect(f.requests[0]?.headers.has('X-AUTH-TOKEN')).toBe(false);
 f.advance(60000);await expect(f.connections.require('yeswehack')).rejects.toThrow(/Bug bounty/);await expect(f.connections.check('yeswehack')).rejects.toThrow(/expired/);
 expect(f.requests).toHaveLength(1);
});
it('rejects public program responses and manager PATs as researcher connection checks',async()=>{
 const f=fixture();f.env.PENTCLOUD_YESWEHACK_API_TOKEN=jwt(600);f.reply(()=>Response.json({items:[{slug:'public'}]}));
 await expect(f.connections.check('yeswehack')).rejects.toThrow(/response/);
 f.env.PENTCLOUD_YESWEHACK_API_TOKEN='ywh_pat_fixture';await expect(f.connections.check('yeswehack')).rejects.toThrow(/researcher.*JWT/i);
});
it('reports Bugcrowd API enrollment, identity and scope requirements without echoing provider bodies',async()=>{
 const f=fixture();f.env.PENTCLOUD_BUGCROWD_API_TOKEN='fixture-id:fixture-secret';
 for(const code of ['hacker_api_disabled','identity_not_verified','insufficient_scope']){
  f.reply(()=>Response.json({errors:[{code,detail:'private-provider-body'}]},{status:403}));
  await expect(f.connections.check('bugcrowd')).rejects.toThrow(code==='insufficient_scope'?/read:engagement_list/:code==='identity_not_verified'?/identity/i:/API access/i);
 }
});
it('unlocks only the platform whose Cloudflare credential passed a read-only API check',async()=>{
 const f=fixture();expect((await f.connections.status('hackerone')).status).toBe('unchecked');
 await expect(f.connections.require('hackerone')).rejects.toThrow(/Bug bounty/);
 expect((await f.connections.check('hackerone')).status).toBe('ready');
 await expect(f.connections.require('hackerone')).resolves.toBeUndefined();
 expect(f.requests[0]?.url).toBe('https://api.hackerone.com/v1/hackers/programs?page%5Bsize%5D=1');
 expect(f.requests[0]?.method).toBe('GET');expect(f.requests[0]?.redirect).toBe('manual');
 expect(f.requests[0]?.headers.get('Authorization')).toBe('Basic '+btoa('researcher:fixture-only-token'));
 expect((await f.connections.status('intigriti')).status).toBe('missing');
 expect(JSON.stringify(await f.connections.status('hackerone'))).not.toContain('fixture-only-token');
});
it('invalidates readiness when credentials change or its check expires, without another background request',async()=>{
 const f=fixture();await f.connections.check('hackerone');
 f.env.PENTCLOUD_HACKERONE_USERNAME='another';expect((await f.connections.status('hackerone')).status).toBe('unchecked');
 f.env.PENTCLOUD_HACKERONE_USERNAME='researcher';f.advance(24*3600000);expect((await f.connections.status('hackerone')).status).toBe('unchecked');expect(f.requests).toHaveLength(1);
});
it('checks the native Intigriti paginated response and never retains provider data',async()=>{
 const f=fixture();f.env.PENTCLOUD_INTIGRITI_API_TOKEN='fixture-intigriti';f.reply(()=>Response.json({records:[],maxCount:0}));
 expect((await f.connections.check('intigriti')).status).toBe('ready');
 expect(f.requests[0]?.url).toBe('https://api.intigriti.com/external/researcher/v1/programs?limit=1&offset=0');
 expect(f.requests[0]?.headers.get('Authorization')).toBe('Bearer fixture-intigriti');
 expect(JSON.stringify([...f.records.values()])).not.toContain('fixture-intigriti');
});
it('fails closed on rejected/malformed provider replies and on a binding changing during the check',async()=>{
 const f=fixture();await f.connections.check('hackerone');f.reply(()=>new Response('private-provider-body',{status:401}));
 await expect(f.connections.check('hackerone')).rejects.toThrow(/invalid|expired/i);await expect(f.connections.require('hackerone')).rejects.toThrow();
 f.reply(()=>Response.json({data:'private-provider-body'}));await expect(f.connections.check('hackerone')).rejects.not.toThrow(/private-provider-body|fixture-only-token/);
 f.reply(()=>{f.env.PENTCLOUD_HACKERONE_API_TOKEN='replacement-token';return Response.json({data:[]});});
 await expect(f.connections.check('hackerone')).rejects.toThrow(/changed/);await expect(f.connections.require('hackerone')).rejects.toThrow();
});
