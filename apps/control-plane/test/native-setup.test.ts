import {describe,it,expect,vi} from 'vitest';
import {prepareSetupStorage,saveSetupKey,setupStatus} from '../src/native/setup';

describe('small first-run setup',()=>{
  it('checks native connections without creating resources or exposing secrets',async()=>{
    const create=vi.fn(),repo={info:async()=>({id:'repo'}),revokeToken:async()=>{},listTokens:async()=>({tokens:[]}),[Symbol.dispose]:()=>{}},env={ARTIFACTS:{get:async()=>repo,create},COORDINATOR:{},ATTEMPTS:{},MODEL_TESTS:{},RESULTS:{},BROWSER:{},AI:{},LOADER:{},CF_VERSION_METADATA:{id:'fixture'},TOOL_PACKS:{},OPENCODE_GO_API_KEY:'private-key'};
    const status=await setupStatus(env);
    expect(status.ready).toBe(true);expect(create).not.toHaveBeenCalled();expect(JSON.stringify(status)).not.toContain('private-key');
  });
  it('creates missing storage once, revokes the unused initial Git token and preserves existing repositories',async()=>{
    let exists=false,active=true;const revokeToken=vi.fn(async()=>{active=false;}),create=vi.fn(async()=>{exists=true;return {token:'private-git-token'};});
    const env={ARTIFACTS:{get:async()=>{if(!exists)throw {code:'NOT_FOUND'};return {info:async()=>({id:'repo',description:'PentCloud setup connection check'}),listTokens:async()=>({tokens:active?[{id:'initial-token-id',state:'active'}]:[]}),revokeToken,[Symbol.dispose]:()=>{}};},create}};
    await prepareSetupStorage(env);await prepareSetupStorage(env);expect(create).toHaveBeenCalledTimes(1);expect(revokeToken).toHaveBeenCalledWith('initial-token-id');
  });
  it('never treats a provider error as permission to create another repository',async()=>{
    const create=vi.fn();await expect(prepareSetupStorage({ARTIFACTS:{get:async()=>{throw Error('PRIVATE_PROVIDER_BODY');},create}})).rejects.toThrow('503: Could not prepare storage. Check the Artifacts binding and try again.');expect(create).not.toHaveBeenCalled();
  });
  it('verifies this exact Worker version before saving a model secret, without retaining API credentials',async()=>{
    const calls:{url:string;init:RequestInit|undefined}[]=[],fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(url),init});return Response.json({success:true});});
    await saveSetupKey({CF_VERSION_METADATA:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},{accountId:'a'.repeat(32),worker:'my-app',apiToken:'t'.repeat(40),key:'private-model-key',route:'go'},fetcher);
    expect(calls.map(c=>c.url)).toEqual(['https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/my-app/versions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/my-app/secrets']);
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({name:'OPENCODE_GO_API_KEY',type:'secret_text',text:'private-model-key'});expect(calls.every(c=>c.init?.redirect==='manual')).toBe(true);
  });
  it('rejects a different Worker and sanitizes authorization failures before any secret write',async()=>{
    const fetcher=vi.fn(async()=>new Response('PRIVATE_TOKEN_OR_PROVIDER_BODY',{status:403}));
    await expect(saveSetupKey({CF_VERSION_METADATA:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},{accountId:'a'.repeat(32),worker:'wrong-app',apiToken:'t'.repeat(40),key:'private-model-key',route:'go'},fetcher)).rejects.toThrow('403: Check the account, Worker name and required setup-token permissions.');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('recognizes an existing workspace without creating a setup repository',async()=>{
    const create=vi.fn(),env={ARTIFACTS:{get:async()=>{throw {code:'NOT_FOUND'};},list:async()=>({repos:[{id:'existing-data'}]}),create}};
    await prepareSetupStorage(env);expect(create).not.toHaveBeenCalled();expect((await setupStatus(env)).storage).toBe(true);
  });
  it('rejects malformed destinations and secrets before a network request',async()=>{
    const fetcher=vi.fn(),valid={accountId:'a'.repeat(32),worker:'my-app',apiToken:'t'.repeat(40),key:'private-model-key',route:'go'};
    for(const change of [{worker:'../other'},{accountId:'other/account'},{route:'unknown'},{route:['go']},{key:'secret\nvalue'},{apiToken:'private\ntoken'},{extra:'value'}])await expect(saveSetupKey({CF_VERSION_METADATA:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},{...valid,...change},fetcher)).rejects.toThrow(/^400:/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retries failed cleanup before declaring the setup-owned workspace ready',async()=>{
    let active=true,fail=true;const revokeToken=vi.fn(async()=>{if(fail){fail=false;throw Error('unavailable');}active=false;});
    const repo={info:async()=>({id:'setup-repo',description:'PentCloud setup connection check'}),listTokens:async()=>({tokens:active?[{id:'initial-token',state:'active'}]:[]}),revokeToken,[Symbol.dispose]:()=>{}},create=vi.fn(async()=>{throw {code:'ALREADY_EXISTS'};}),env={ARTIFACTS:{get:async()=>repo,create}};
    await expect(prepareSetupStorage(env)).rejects.toThrow(/^503:/);expect((await setupStatus(env)).storage).toBe(false);
    await prepareSetupStorage(env);expect((await setupStatus(env)).storage).toBe(true);expect(revokeToken).toHaveBeenCalledTimes(2);
  });
  it('rejects redirects without forwarding account credentials',async()=>{
    const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{Location:'https://foreign.invalid'}}));
    await expect(saveSetupKey({CF_VERSION_METADATA:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},{accountId:'a'.repeat(32),worker:'example-app',apiToken:'t'.repeat(40),key:'private-model-key',route:'go'},fetcher)).rejects.toThrow(/^403:/);expect(fetcher).toHaveBeenCalledTimes(1);
  });

});

describe('native Access bootstrap',()=>{
  const env={CF_VERSION_METADATA:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},input={accountId:'a'.repeat(32),worker:'pentcloud',apiToken:'t'.repeat(40),email:'owner@example.com',key:'private-model-key',route:'go'};
  it('verifies Worker ownership before creating an owner-only hostname policy and atomically saving native secrets',async()=>{
    const calls:{url:string;init?:RequestInit}[]=[];
    const fake=async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(url),...(init?{init}:{})});return Response.json({success:true,result:String(url).endsWith('/organizations')?{auth_domain:'team.cloudflareaccess.com'}:String(url).includes('/access/apps?')?[]:init?.method==='POST'?{id:'app-id',aud:'a'.repeat(64)}:{}});};
    const {configureSetupAccess}=await import('../src/native/setup');await configureSetupAccess(env,input,'https://customer.example/setup',fake);
    expect(calls[0]!.url).toContain('/versions/'+env.CF_VERSION_METADATA.id);
    const create=calls.find(c=>c.init?.method==='POST')!;expect(JSON.parse(String(create.init!.body))).toMatchObject({domain:'customer.example',type:'self_hosted',policies:[{decision:'allow',include:[{email:{email:'owner@example.com'}}]}]});
    const save=calls.at(-1)!;expect(save.url).toMatch(/\/secrets-bulk$/);expect(save.init?.method).toBe('PATCH');const secrets=JSON.parse(String(save.init!.body)).secrets;
    expect(Object.keys(secrets).sort()).toEqual(['ACCESS_AUD','ACCESS_TEAM_DOMAIN','OPENCODE_GO_API_KEY']);expect(secrets.ACCESS_AUD.text).toBe('a'.repeat(64));
    expect(calls.every(c=>c.init?.redirect==='manual')).toBe(true);
  });
  it('cannot reset an installation with existing Access settings',async()=>{
    const {configureSetupAccess}=await import('../src/native/setup'),fake=vi.fn();await expect(configureSetupAccess({...env,ACCESS_AUD:'configured'},input,'https://customer.example',fake)).rejects.toThrow(/^409:/);expect(fake).not.toHaveBeenCalled();
  });
  it('refuses to replace another Access application or policy',async()=>{
    const {configureSetupAccess}=await import('../src/native/setup');const fake=vi.fn(async(url:RequestInfo|URL,_init?:RequestInit)=>Response.json({success:true,result:String(url).endsWith('/organizations')?{auth_domain:'team.cloudflareaccess.com'}:String(url).includes('/access/apps?')?[{id:'other',name:'Someone else',domain:'customer.example',type:'self_hosted',aud:'a'.repeat(64)}]:{}}));
    await expect(configureSetupAccess(env,input,'https://customer.example',fake)).rejects.toThrow(/^409:/);expect(fake.mock.calls.every(call=>!call[1]?.method)).toBe(true);
  });
});
