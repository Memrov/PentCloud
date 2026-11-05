import { describe, expect, it } from 'vitest';
import { OnboardingStore } from '../src/native/onboarding';
import { normalizeTargetURL, checkAddress } from '../src/native/target-check';
import { normalizeCatalog } from '../src/native/opencode-models';

function fixture(fetcher?:typeof fetch) {
  const records = new Map<string, unknown>(); let time=1000000,bound="bound-test-key",targetSecret="cloudflare-api-secret";
  const store=new OnboardingStore({
    get:<T>(key:string)=>structuredClone(records.get(key)) as T|undefined,
    put:(key:string,value:unknown)=>{records.set(key,structuredClone(value));},
    list:<T>(prefix:string)=>[...records].filter(([k])=>k.startsWith(prefix)).map(([,v])=>structuredClone(v) as T),
    remove:(key:string)=>{records.delete(key);}, now:()=>time,
    fetcher:fetcher??(async()=>Response.json({data:[{id:'test-model',name:'Test model',type:'chat',capabilities:{tools:{supported:true}},limit:{context:128000,output:8192},api:{'chat-completions':{base_url:'https://opencode.ai/inference/go/openai/v1'}}}]})),
    probe:async()=>{}, boundGoKey:()=>bound,
    readTargetSecret:async()=>targetSecret,
  });
  return {store,records,setTargetSecret:(value:string)=>{targetSecret=value;},setBoundKey:(value:string)=>{bound=value;},advance:(ms:number)=>{time+=ms;}};
}
describe('saved targets and credential readiness',()=>{
  it('checks native credential readiness without claiming a login or persisting values',async()=>{
    const {store,records}=fixture();const t=store.saveTarget({id:'target-secrets',kind:'website',name:'Example',url:'example.com'},null,'owner');
    const result=await store.checkTargetSecret(t.id,t.revision,'password','owner');
    expect(result).toMatchObject({ready:true,authenticated:false,status:'ready'});
    expect(JSON.stringify([...records.values()])).not.toContain('cloudflare-api-secret');
    await expect(store.checkTargetSecret(t.id,t.revision+1,'password','owner')).rejects.toThrow(/changed/i);
  });
  it('keeps API roots, schemes and ports distinct and removes URL credentials',()=>{
    expect(normalizeTargetURL('EXAMPLE.com')).toBe('https://example.com/');
    expect(normalizeTargetURL('http://Example.com:8080/v2/')).toBe('http://example.com:8080/v2/');
    expect(()=>normalizeTargetURL('https://user:secret@example.com/')).toThrow(/credential/i);
    expect(()=>normalizeTargetURL('file:///tmp/file')).toThrow();
  });
  it('saves reusable targets without allocating runs and rejects stale edits',()=>{
    const {store,records}=fixture();
    const target=store.saveTarget({id:'target-one',kind:'api',name:'My API',url:'example.com/v1'},null,'owner');
    expect(store.targets()).toEqual([target]);
    expect([...records.keys()].some(k=>k.startsWith('run:'))).toBe(false);
    expect(()=>store.saveTarget({...target,url:'example.com/v2'},target.revision-1,'owner')).toThrow(/changed/);
    const next=store.saveTarget({...target,url:'example.com/v2'},target.revision,'owner');
    expect(next.revision).toBe(target.revision+1);
  });
  it('keeps Cloudflare login references and required headers on the target for later runs',()=>{
    const {store,records}=fixture();const target=store.saveTarget({id:'target-login',kind:'website',name:'Site',url:'https://example.com/'},null,'owner');
    const configured=store.saveTargetAccess(target.id,target.revision,{headers:[{name:'X-Researcher',value:'researcher'}],login:{url:'https://example.com/login',usernameBinding:'PENTCLOUD_TARGET_USER',passwordBinding:'PENTCLOUD_TARGET_PASS'}},'owner');
    expect(store.target(target.id).access?.login?.passwordBinding).toBe('PENTCLOUD_TARGET_PASS');
    expect(()=>store.saveTargetAccess(target.id,target.revision,{headers:[]},'owner')).toThrow(/changed/);
    const renamed=store.saveTarget({...configured,name:'Renamed'},configured.revision,'owner');expect(renamed.access).toEqual(configured.access);
    expect(()=>store.saveTarget({...renamed,url:'https://other.example/'},renamed.revision,'owner')).toThrow();
    expect([...records.keys()].some(key=>key.startsWith('onboarding:value:'))).toBe(false);
  });
  it('tests a Cloudflare-held target API key without adding it to the application credential store',async()=>{
    const seen:Headers[]=[];const {store,records}=fixture(async(_url,init)=>{const headers=new Headers(init?.headers);seen.push(headers);return new Response(headers.has('Authorization')?'private':'denied',{status:headers.has('Authorization')?200:401});});
    const t=store.saveTarget({id:'bound-api',kind:'api',name:'API',url:'https://example.com/v1/'},null,'owner');
    const configured=store.saveTargetAccess(t.id,t.revision,{headers:[{name:'X-Researcher',value:'required'}],api:{url:t.url,binding:'PENTCLOUD_TARGET_API_KEY',header:'Authorization',scheme:'bearer'}},'owner');
    store.saveDraft('run-bound-api',{publicAPI:false,endpoint:'https://example.com/v1/me',expectedStatus:200},0,'owner');
    await expect(store.testAPI('run-bound-api',configured,'test-bound-api','owner')).resolves.toMatchObject({verified:true});
    expect(seen.map(h=>h.get('X-Researcher'))).toEqual(['required','required']);expect(seen.map(h=>h.get('Authorization'))).toEqual([null,'Bearer cloudflare-api-secret']);
    expect(JSON.stringify([...records.values()])).not.toContain('cloudflare-api-secret');
  });
  it('rejects a rotated native API credential after its successful read-only check',async()=>{
    const {store,setTargetSecret}=fixture(async(_url,init)=>new Response(new Headers(init?.headers).has('Authorization')?'private':'denied',{status:new Headers(init?.headers).has('Authorization')?200:401}));
    const t=store.saveTarget({id:'rotated-api',kind:'api',name:'API',url:'https://example.com/v1/'},null,'owner');
    const target=store.saveTargetAccess(t.id,t.revision,{headers:[],api:{url:t.url,binding:'PENTCLOUD_TARGET_API',header:'Authorization',scheme:'bearer'}},'owner');
    store.saveDraft('run-rotate',{publicAPI:false,endpoint:t.url+'me',expectedStatus:200},0,'owner');
    await store.testAPI('run-rotate',target,'check-original','owner');
    await expect(store.verifyAPIProof('run-rotate',target)).resolves.toMatchObject({credentialFingerprint:expect.any(String)});
    setTargetSecret('rotated-untested-key');await expect(store.verifyAPIProof('run-rotate',target)).rejects.toThrow(/changed|test/i);
  });
  it('refuses to persist OpenCode keys in application storage',()=>{
    const {store,records}=fixture();
    expect(()=>store.saveCredential({id:'model-key',purpose:'model',label:'OpenCode',value:'never-store-this'},null,'owner')).toThrow(/Cloudflare/);
    expect([...records.keys()].some(key=>key.startsWith('onboarding:value:'))).toBe(false);
  });
  it('stores keys write-only, versions replacement and invalidates revoked use',()=>{
    const {store}=fixture();
    store.saveTarget({id:'key-target',kind:'api',name:'API',url:'https://owned.example/'},null,'owner');
    const c=store.saveCredential({id:'key-one',purpose:'api',targetId:'key-target',scheme:'bearer',header:'Authorization',label:'API',value:'secret-one'},null,'owner');
    expect(JSON.stringify(store.credentials())).not.toContain('secret-one');
    expect(store.resolveCredential(c.id,c.version,'api','key-target')).toBe('secret-one');
    store.saveCredential({id:c.id,purpose:'api',targetId:'key-target',scheme:'bearer',header:'Authorization',label:'API',value:'secret-two'},c.version,'owner');
    expect(store.resolveCredential(c.id,c.version,'api','key-target')).toBe('secret-one');
    store.revokeCredential(c.id,2,'owner');
    expect(()=>store.resolveCredential(c.id,1,'api','key-target')).toThrow(/revoked/);
    expect(JSON.stringify(store.exportData())).not.toContain('secret-');
  });
  it('does not move an existing API credential to a target edited to a new audience',()=>{
    const {store}=fixture();
    const target=store.saveTarget({id:'target-one',kind:'api',name:'API',url:'https://owned.example/v1/'},null,'owner');
    const key=store.saveCredential({id:'api-one',purpose:'api',label:'Test',value:'original-key',targetId:target.id,header:'Authorization',scheme:'bearer'},null,'owner');
    const moved=store.saveTarget({...target,url:'https://other.example/v2/'},target.revision,'owner');
    expect(()=>store.apiConfig(moved,{id:key.id,version:key.version})).toThrow(/audience/i);
    expect(store.apiConfig(target,{id:key.id,version:key.version})).toMatchObject({targetURL:target.url});
    expect(()=>store.saveCredential({id:key.id,purpose:'api',label:'Test',value:'replacement',targetId:target.id,header:'Authorization',scheme:'bearer'},key.version,'owner')).toThrow(/audience/i);
  });
  it('requires actual model tests, deduplicates proofs and expires them',async()=>{
    const {store,advance}=fixture();
    const catalog=await store.catalog('go'); const model=catalog.models[0]!;
    const choice={model:model.id,credentialId:'bound-go',credentialVersion:0};
    expect(()=>store.pinnedModel(choice)).toThrow(/test/i);
    await store.testModel(choice,'test-one','owner');
    expect(store.pinnedModel(choice)).toMatchObject({id:'opencode-go:test-model',route:'go',credentialId:'bound-go'});
    advance(24*60*60*1000+1);
    expect(()=>store.pinnedModel(choice)).toThrow(/test/i);
  });
  it('does not reuse a connection proof after native secret rotation',async()=>{
    const {store,records,setBoundKey}=fixture();await store.catalog('go');
    const choice={model:'opencode-go:test-model',credentialId:'bound-go',credentialVersion:0};
    const first=await store.testModel(choice,'first','owner');
    store.saveDraft('run-one',{publicAPI:true,profile:{default:choice,overrides:{}}},0,'owner');
    setBoundKey('rotated-test-key');
    await expect(store.verifyModelProfile('run-one')).rejects.toThrow(/secret changed/);
    const second=await store.testModel(choice,'second','owner');
    expect(second.credentialFingerprint).not.toBe(first.credentialFingerprint);
    await expect(store.verifyModelProfile('run-one')).resolves.toBeDefined();
    expect(JSON.stringify([...records.values()])).not.toMatch(/bound-test-key|rotated-test-key/);
  });
  it('requires a fresh native-secret proof for new activation after a legacy upgrade',async()=>{
    const {store,records,setBoundKey}=fixture();await store.catalog('go');
    const choice={model:'opencode-go:test-model',credentialId:'bound-go',credentialVersion:0};
    await store.testModel(choice,'legacy','owner');
    const key='onboarding:model-proof:bound-go:0:opencode-go:test-model';
    const old=records.get(key) as Record<string,unknown>;delete old.credentialFingerprint;records.set(key,old);
    setBoundKey('rotated-key');store.saveDraft('new-run',{publicAPI:true,profile:{default:choice,overrides:{}}},0,'owner');
    await expect(store.verifyModelProfile('new-run')).rejects.toThrow(/test/i);
  });
  it('a stale asynchronous address response cannot validate an edited target',async()=>{
    const {store}=fixture();
    const target=store.saveTarget({id:'target-one',kind:'website',name:'Site',url:'example.com'},null,'owner');
    await store.checkTarget(target.id,target.revision,'check-one','owner',async()=>({status:200,url:target.url,classification:'reachable'}));
    expect(store.requireTargetProof(target.id,target.revision).classification).toBe('reachable');
    store.saveTarget({...target,url:'other.example'},target.revision,'owner');
    expect(()=>store.requireTargetProof(target.id,target.revision+1)).toThrow(/verify/i);
  });
  it('exports metadata and targets with values excluded and imports keys as missing',()=>{
    const {store}=fixture(); store.saveTarget({id:'target-one',kind:'api',name:'API',url:'example.com'},null,'owner');
    store.saveCredential({id:'api-key',purpose:'api',label:'Test',value:'do-not-export',targetId:'target-one',header:'Authorization',scheme:'bearer'},null,'owner');
    const data=store.exportData(); expect(JSON.stringify(data)).not.toContain('do-not-export');
    const other=fixture().store; other.importData(data,'owner');
    expect(other.targets()).toHaveLength(1);
    expect(()=>other.resolveCredential('api-key',1,'api','target-one')).toThrow(/missing|re-enter/i);
  });
  it('can import its own reusable-library export after an API target is deleted',()=>{
    const {store}=fixture();
    const t=store.saveTarget({id:'target-one',kind:'api',name:'API',url:'owned.example'},null,'owner');
    store.saveCredential({id:'old-key',purpose:'api',label:'Old key',value:'private-value',targetId:t.id,header:'Authorization',scheme:'bearer'},null,'owner');
    store.lifecycleTarget(t.id,t.revision,'delete','owner');
    const exported=store.exportData();
    expect(exported.credentials).toHaveLength(0);
    expect(()=>fixture().store.importData(exported,'owner')).not.toThrow();
  });
});
describe('bounded target checks',()=>{
  it('treats a protected response as reachable without proving authentication',async()=>{
    const value=await checkAddress('https://example.com/',async()=>new Response(null,{status:401}));
    expect(value).toMatchObject({status:401,classification:'needs-auth'});
  });
  it('does not silently adopt a redirected origin',async()=>{
    const value=await checkAddress('https://example.com/',async()=>new Response(null,{status:302,headers:{Location:'https://other.example/'}}));
    expect(value).toMatchObject({classification:'redirect-review',redirectURL:'https://other.example/'});
  });
});
describe('OpenCode-only catalog',()=>{
  it('maps native transports and rejects foreign destinations without importing arbitrary providers',()=>{
    const rows=normalizeCatalog({data:[{id:'claude-test',name:'Test',type:'chat',capabilities:{tools:{supported:true}},limit:{context:200000,output:8192},api:{messages:{base_url:'https://opencode.ai/inference/anthropic/v1'}}},{id:'bad',type:'chat',capabilities:{tools:{supported:true}},api:{responses:{base_url:'https://evil.example/'}}}]},'console');
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({id:'opencode:claude-test',adapter:'messages',baseURL:'https://opencode.ai/inference/anthropic/v1'});
  });
});

it('reports the catalog HTTP failure without returning upstream bodies or credentials',async()=>{
  const {store}=fixture(async()=>new Response('untrusted private body',{status:403}));
  await expect(store.catalog('go')).rejects.toThrow(/Go.*HTTP 403/);
  await expect(store.catalog('go')).rejects.not.toThrow(/untrusted private body/);
});
