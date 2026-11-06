import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {withNativeTestHarness} from './lib/native-test-harness.mjs';

const root=resolve(import.meta.dirname,'..');
test('probe readiness retries only bounded propagation failures and cancels discarded bodies',async()=>{
  const {waitForProbeReady}=await import('./ci/install.mjs');
  let time=0,calls=0,cancelled=0;const statuses=[null,401,403,404,502,503,525,526,530,200],observed=[];
  const result=await waitForProbeReady({now:()=>time,sleep:async ms=>{time+=ms;},onStatus:status=>observed.push(status),request:async()=>{
    calls++;const status=statuses.shift();if(status===null)throw Error('PRIVATE_NETWORK_BODY');
    return new Response(new ReadableStream({cancel(){cancelled++;}}),{status});
  }});
  assert.equal(result.status,200);assert.equal(calls,10);assert.equal(cancelled,8);assert.deepEqual(observed,['network-pending',401,403,404,502,503,525,526,530,200]);
  await result.body.cancel();time=0;calls=0;
  await assert.rejects(waitForProbeReady({timeoutMs:5000,now:()=>time,sleep:async ms=>{time+=ms;},request:async()=>{calls++;return new Response(null,{status:503});}}),/CI_PROBE_READINESS_TIMEOUT/);
  assert(calls<=4);
  calls=0;await assert.rejects(waitForProbeReady({request:async()=>{calls++;return new Response(null,{status:500});}}),/CI_PROBE_UNEXPECTED_STATUS/);assert.equal(calls,1);
});
test('Access readiness waits for policy propagation but fails bounded persistent denial',async()=>{
  const {waitForAccessReady}=await import('./ci/install.mjs');
  let time=0,calls=0;const statuses=[401,403,200],headers={'CF-Access-Client-Id':'private-id','CF-Access-Client-Secret':'private-secret'};
  const result=await waitForAccessReady({origin:'https://install.heflare.app',headers,now:()=>time,sleep:async ms=>{time+=ms;},fetcher:async(url,options)=>{
    assert.equal(url,'https://install.heflare.app/v1/runs?view=all');assert.equal(options.redirect,'manual');assert.equal(options.headers,headers);calls++;
    return new Response(null,{status:statuses.shift()});
  }});
  assert.equal(result.status,200);assert.equal(calls,3);
  time=0;calls=0;
  await assert.rejects(waitForAccessReady({origin:'https://install.heflare.app',headers,timeoutMs:5000,now:()=>time,sleep:async ms=>{time+=ms;},fetcher:async()=>{calls++;return new Response(null,{status:401});}}),/CI_ACCESS_READINESS_TIMEOUT/);
  assert(calls<=4);
  await assert.rejects(waitForAccessReady({origin:'https://install.heflare.app',headers,fetcher:async()=>new Response(null,{status:500})}),/CI_ACCESS_UNEXPECTED_STATUS/);
});

test('Access readiness checks each exact endpoint and accepts an authenticated absent Kali route',async()=>{
  const {waitForAccessReady}=await import('./ci/install.mjs');
  const attempts=new Map();let time=0;
  const fetcher=async url=>{const path=new URL(url).pathname,n=attempts.get(path)??0;attempts.set(path,n+1);return new Response(null,{status:n===0?401:path==='/v1/toolbox/status'?404:200});};
  for(const path of ['/v1/runs','/v1/onboarding','/v1/lifecycle','/v1/toolbox/status']){
    const expectedStatus=path==='/v1/toolbox/status'?404:200;
    const response=await waitForAccessReady({origin:'https://install.heflare.app',headers:{},path,expectedStatus,fetcher,now:()=>time,sleep:async ms=>{time+=ms;}});
    assert.equal(response.status,expectedStatus);assert.equal(attempts.get(path),2);
  }
});
test('installation failures never print assertion values or provider messages',()=>{
  const privateValue='unexpected-private-operator@example.invalid';
  const child=spawnSync(process.execPath,[join(root,'scripts/ci/install.mjs')],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false',PENTCLOUD_INSTALL_CONFIG:JSON.stringify({accountId:privateValue,zoneId:'b'.repeat(32),hostname:'install.heflare.app',team:'https://private-team.cloudflareaccess.com',emails:[privateValue]})}});
  assert.equal(child.status,1);
  assert(!child.stderr.includes(privateValue),'private assertion value reached stderr');
  assert.match(child.stderr,/CI_INSTALL_FAILED/);
  assert(!child.stderr.includes('AssertionError'));
});

test('native Artifacts probe reads Blob text and rejects a missing file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-probe-test-'));
  try{
    await writeFile(join(directory,'worker.mjs'),`import probe from ${JSON.stringify(join(root,'scripts/ci/probe-worker.mjs'))};
export default {fetch(request){const url=new URL(request.url),missing=url.searchParams.has('missing');return probe.fetch(request,{CI_PROBE_TOKEN:'fixture-token',CI_PROBE_EXPIRES_AT:String(Date.now()+(url.searchParams.has('expired')?-60000:60000)),ARTIFACTS:{get:async()=>({readFile:async()=>missing?null:new Blob(['owned evidence 🧪']),[Symbol.dispose](){}})}})}};`);
    await writeFile(join(directory,'wrangler.json'),JSON.stringify({name:'ci-probe-fixture',main:'worker.mjs',compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat']}));
    await withNativeTestHarness({root:directory,workers:[{configPath:'wrangler.json'}]},async server=>{
      const send=path=>server.fetch('https://probe.test'+path,{method:'POST',headers:{Authorization:'Bearer fixture-token','Content-Type':'application/json'},body:JSON.stringify({action:'artifacts',repo:'ci-owned',commit:'a'.repeat(40),expected:'owned evidence 🧪'})});
      assert.equal((await send('/')).status,200);
      const missing=await send('/?missing');assert.equal(missing.status,500);
      assert.deepEqual(await missing.json(),{error:'Installation probe failed',action:'artifacts'});
      assert.equal((await send('/?expired')).status,404);
    });
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('native Loader probe executes with a real workerd Loader binding',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-loader-probe-test-'));
  try{
    await writeFile(join(directory,'worker.mjs'),`import probe from ${JSON.stringify(join(root,'scripts/ci/probe-worker.mjs'))};
export default {fetch(request,env){return probe.fetch(request,{...env,CI_PROBE_TOKEN:'fixture-token',CI_PROBE_EXPIRES_AT:String(Date.now()+60000)})}};`);
    await writeFile(join(directory,'wrangler.json'),JSON.stringify({name:'ci-loader-probe-fixture',main:'worker.mjs',compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat'],worker_loaders:[{binding:'LOADER'}]}));
    await withNativeTestHarness({root:directory,workers:[{configPath:'wrangler.json'}]},async server=>{
      const result=await server.fetch('https://probe.test/',{method:'POST',headers:{Authorization:'Bearer fixture-token','Content-Type':'application/json'},body:JSON.stringify({action:'loader'})});
      assert.equal(result.status,200);assert.deepEqual(await result.json(),{loader:'passed'});
    });
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('always cleanup succeeds without credentials or dependencies when no journal exists',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-absent-cleanup-'));
  try{
    const child=spawnSync(process.execPath,[join(root,'scripts/ci/cleanup.mjs')],{encoding:'utf8',env:{RUNNER_TEMP:directory}});
    assert.equal(child.status,0);assert.equal(child.stderr,'');
  }finally{await rm(directory,{recursive:true,force:true});}
});

const owner={repository:'Memrov/PentCloud',accountId:'a'.repeat(32),runId:'12345',attempt:'2'};
const nonce='0123456789ab';
const zoneId='c'.repeat(32);
async function journalFixture(fn){
  const cleanup=await import('./ci/cleanup.mjs');
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-cleanup-test-')),path=join(directory,'cleanup.json');
  try{const journal=await cleanup.createCleanupJournal(path,owner,nonce);await fn({cleanup,path,journal,persist:()=>cleanup.saveCleanupJournal(path,journal)});}
  finally{await rm(directory,{recursive:true,force:true});}
}
function provider(){
  const scripts=new Map(),tokens=[],policies=[],domains=[],dns=[],deletes=[];
  const api={async request(path,{method='GET',body,envelope=false}={}){
    const url=new URL(path,'https://fixture.invalid');
    if(url.pathname==='/zones/'+zoneId)return {id:zoneId,name:'heflare.app',status:'active',account:{id:owner.accountId}};
    if(url.pathname==='/zones/'+zoneId+'/dns_records'){
      const result=dns.filter(value=>value.name===url.searchParams.get('name'));
      return envelope?{result,result_info:{total_pages:1}}:result;
    }
    if(url.pathname.endsWith('/workers/domains'))return domains.map(value=>({...value}));
    const domain=url.pathname.match(/\/workers\/domains\/([^/]+)$/);
    if(domain){
      const index=domains.findIndex(value=>value.id===domain[1]);
      if(method==='DELETE'){if(index>=0)domains.splice(index,1);deletes.push(path);return null;}
      return index<0?null:{...domains[index]};
    }
    if(path.endsWith('/workers/scripts'))return [...scripts.keys()].map(id=>({id}));
    const worker=path.match(/\/workers\/scripts\/([^/]+)(?:\/settings)?$/);
    if(worker){if(method==='DELETE'){scripts.delete(worker[1]);deletes.push(path);return null;}return scripts.has(worker[1])?{name:worker[1]}:null;}
    if(path.endsWith('/access/apps/app-owned'))return {id:'app-owned',type:'self_hosted',domain:'install.heflare.app'};
    const list=path.includes('/access/service_tokens')?tokens:policies;
    if(method==='GET')return list.map(value=>({...value}));
    if(method==='POST'){const value={...body,id:body.decision?'policy-owned':'token-owned',client_id:'PRIVATE_CLIENT',client_secret:'PRIVATE_SECRET'};list.push(value);return value;}
    if(method==='DELETE'){const id=path.split('/').at(-1),index=list.findIndex(value=>value.id===id);if(index>=0)list.splice(index,1);deletes.push(path);return null;}
    throw Error('Unexpected fixture request');
  }};
  api.list=path=>api.request(path);
  return {api,scripts,tokens,policies,domains,dns,deletes};
}
const probeDomain=(journal,overrides={})=>({id:'domain-owned',hostname:'pentcloud-ci-12345-2-0123456789ab-probe.heflare.app',service:journal.probe.name,zone_id:zoneId,zone_name:'heflare.app',environment:'production',...overrides});
async function paginateDomains(fixture){
  const {CloudflareApi}=await import('./lib/private-install.mjs'),pages=[];
  const paginated=new CloudflareApi('fixture-token',async value=>{
    const url=new URL(value);assert(url.pathname.endsWith('/workers/domains'));
    const page=Number(url.searchParams.get('page'));pages.push(page);
    return Response.json({success:true,result:fixture.domains.slice(page-1,page),result_info:{total_pages:fixture.domains.length}});
  });
  fixture.api.list=path=>paginated.list(path);return pages;
}

test('cleanup reconciles an attempted probe deployment after Wrangler loses its response',async()=>journalFixture(async({cleanup,path,journal,persist})=>{
  const fixture=provider();fixture.scripts.set('unrelated-worker',true);
  await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>{fixture.scripts.set(journal.probe.name,true);fixture.domains.push(probeDomain(journal));throw Error('PRIVATE_DEPLOY_BODY');}}));
  const restored=await cleanup.readCleanupJournal(path,owner);
  await cleanup.cleanupOwnedResources({api:fixture.api,journal:restored,persist:()=>cleanup.saveCleanupJournal(path,restored)});
  assert.deepEqual([...fixture.scripts.keys()],['unrelated-worker']);
  assert.equal(fixture.domains.length,0);assert(restored.probe.removed&&restored.domain.removed);
  assert(fixture.deletes[0].endsWith('/workers/domains/domain-owned'));
}));

test('probe name collision is never claimed or deleted',async()=>journalFixture(async({cleanup,journal,persist})=>{
  const fixture=provider();fixture.scripts.set(journal.probe.name,true);
  await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>assert.fail('colliding deploy')}));
  await cleanup.cleanupOwnedResources({api:fixture.api,journal,persist});
  assert(fixture.scripts.has(journal.probe.name));assert.equal(fixture.deletes.length,0);
}));

test('probe deployment checkpoints its exact custom domain and removes it before its Worker',async()=>journalFixture(async({cleanup,path,journal,persist})=>{
  const fixture=provider();assert.equal(cleanup.probeHostname(journal),'pentcloud-ci-12345-2-0123456789ab-probe.heflare.app');
  await cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>{
    const saved=await cleanup.readCleanupJournal(path,owner);
    assert(saved.probe.attempted&&saved.domain.attempted);assert.equal(saved.domain.zoneId,zoneId);
    fixture.scripts.set(journal.probe.name,true);fixture.domains.push(probeDomain(journal));
  }});
  assert.equal(journal.domain.id,'domain-owned');
  await cleanup.cleanupOwnedResources({api:fixture.api,journal,persist});
  assert.equal(fixture.domains.length,0);assert.equal(fixture.scripts.size,0);
  assert.deepEqual(fixture.deletes,[`/accounts/${owner.accountId}/workers/domains/domain-owned`,`/accounts/${owner.accountId}/workers/scripts/${journal.probe.name}`]);
}));

test('existing custom-domain and DNS hostnames are never claimed or overwritten',async()=>{
  for(const kind of ['domain','dns'])await journalFixture(async({cleanup,journal,persist})=>{
    const fixture=provider();
    if(kind==='domain')fixture.domains.push(probeDomain(journal,{service:'foreign-worker'}));
    else fixture.dns.push({id:'foreign-dns',name:'pentcloud-ci-12345-2-0123456789ab-probe.heflare.app'});
    await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>assert.fail('colliding domain deploy')}));
    assert.equal(journal.probe.attempted,false);assert.equal(journal.domain.attempted,false);
    await cleanup.cleanupOwnedResources({api:fixture.api,journal,persist});assert.equal(fixture.deletes.length,0);
  });
});

test('custom-domain preflight verifies the selected testing zone and its account',async()=>journalFixture(async({cleanup,journal,persist})=>{
  const fixture=provider(),request=fixture.api.request.bind(fixture.api);
  for(const foreign of [{name:'production.example'},{account:{id:'d'.repeat(32)}},{status:'pending'}]){
    fixture.api.request=async(path,options)=>path==='/zones/'+zoneId?{...await request(path,options),...foreign}:request(path,options);
    await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>assert.fail('foreign zone deploy')}));
    assert.equal(journal.probe.attempted,false);assert.equal(fixture.deletes.length,0);
  }
}));

test('custom-domain cleanup refuses changed hostnames, associations and identities',async()=>{
  for(const change of [{service:'foreign-worker'},{hostname:'foreign.heflare.app'},{zone_id:'d'.repeat(32)},{id:'replacement-domain'}])await journalFixture(async({cleanup,journal,persist})=>{
    const fixture=provider();
    await cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>{fixture.scripts.set(journal.probe.name,true);fixture.domains.push(probeDomain(journal));}});
    Object.assign(fixture.domains[0],change);
    await assert.rejects(cleanup.cleanupOwnedResources({api:fixture.api,journal,persist}));
    assert.equal(fixture.deletes.length,0);assert(fixture.scripts.has(journal.probe.name));
  });
});

test('custom-domain deletion reconciles a lost response before removing its Worker',async()=>journalFixture(async({cleanup,path,journal,persist})=>{
  const fixture=provider();
  await cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>{fixture.scripts.set(journal.probe.name,true);fixture.domains.push(probeDomain(journal));}});
  const request=fixture.api.request.bind(fixture.api);
  fixture.api.request=async(path,options)=>{const result=await request(path,options);if(options?.method==='DELETE'&&path.endsWith('/workers/domains/domain-owned'))throw Error('PRIVATE_DELETE_BODY');return result;};
  await assert.rejects(cleanup.cleanupOwnedResources({api:fixture.api,journal,persist}));
  assert.equal(fixture.domains.length,0);assert(fixture.scripts.has(journal.probe.name));
  const restored=await cleanup.readCleanupJournal(path,owner);
  await cleanup.cleanupOwnedResources({api:fixture.api,journal:restored,persist:()=>cleanup.saveCleanupJournal(path,restored)});
  assert(restored.domain.removed&&restored.probe.removed);assert.equal(fixture.scripts.size,0);
}));

test('custom-domain deletion requires its freshly read receipt to prove the exact association',async()=>journalFixture(async({cleanup,journal,persist})=>{
  const fixture=provider();
  await cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>{fixture.scripts.set(journal.probe.name,true);fixture.domains.push(probeDomain(journal));}});
  const request=fixture.api.request.bind(fixture.api);
  fixture.api.request=(path,options)=>!options?.method&&path.endsWith('/workers/domains/domain-owned')?Promise.resolve({id:'foreign-id',hostname:'foreign.heflare.app',service:'foreign-worker'}):request(path,options);
  await assert.rejects(cleanup.cleanupOwnedResources({api:fixture.api,journal,persist}));
  assert.equal(fixture.deletes.length,0);assert(fixture.scripts.has(journal.probe.name));assert.equal(fixture.domains.length,1);
}));

test('custom-domain collision checks and lost-response cleanup inspect all inventory pages',async()=>{
  await journalFixture(async({cleanup,journal,persist})=>{
    const fixture=provider();fixture.domains.push(probeDomain(journal,{id:'unrelated-domain',hostname:'unrelated.heflare.app',service:'foreign-worker'}),probeDomain(journal,{service:'foreign-worker'}));
    const pages=await paginateDomains(fixture);
    await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>assert.fail('later-page collision')}));
    assert(pages.includes(2));assert.equal(journal.probe.attempted,false);assert.equal(fixture.deletes.length,0);
  });
  await journalFixture(async({cleanup,journal,persist})=>{
    const fixture=provider();fixture.domains.push(probeDomain(journal,{id:'unrelated-domain',hostname:'unrelated.heflare.app',service:'foreign-worker'}));
    const pages=await paginateDomains(fixture);
    await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,zoneId,deploy:async()=>{fixture.scripts.set(journal.probe.name,true);fixture.domains.push(probeDomain(journal));throw Error('lost deploy');}}));
    await cleanup.cleanupOwnedResources({api:fixture.api,journal,persist});
    assert(pages.includes(2));assert.deepEqual(fixture.domains.map(value=>value.id),['unrelated-domain']);assert.equal(fixture.scripts.size,0);
  });
});

test('Access cleanup survives a lost create response and journals no credentials',async()=>journalFixture(async({cleanup,path,journal,persist})=>{
  const fixture=provider();fixture.tokens.push({id:'unrelated-token',name:'unrelated'});fixture.policies.push({id:'unrelated-policy',name:'unrelated'});
  const request=fixture.api.request.bind(fixture.api);
  fixture.api.request=async(path,options)=>{const result=await request(path,options);if(options?.method==='POST'&&path.endsWith('/policies'))throw Error('PRIVATE_PROVIDER_BODY');return result;};
  await assert.rejects(cleanup.withCIProbeAccess({api:fixture.api,journal,persist,appId:'app-owned',origin:'https://install.heflare.app'},async()=>assert.fail('lost create response cannot continue')));
  const restored=await cleanup.readCleanupJournal(path,owner);
  await cleanup.cleanupOwnedResources({api:fixture.api,journal:restored,persist:()=>cleanup.saveCleanupJournal(path,restored)});
  assert.deepEqual(fixture.tokens.map(value=>value.id),['unrelated-token']);
  assert.deepEqual(fixture.policies.map(value=>value.id),['unrelated-policy']);
  const saved=await readFile(path,'utf8');for(const marker of ['PRIVATE_CLIENT','PRIVATE_SECRET','PRIVATE_PROVIDER_BODY'])assert(!saved.includes(marker));
}));

test('an interrupted job can reconcile unknown Access IDs from exact task names',async()=>journalFixture(async({cleanup,path,journal,persist})=>{
  const fixture=provider();journal.access.appId='app-owned';journal.access.tokenAttempted=true;journal.access.policyAttempted=true;
  fixture.tokens.push({id:'token-created-before-interruption',name:journal.access.name},{id:'token-unrelated',name:journal.access.name+'-other'});
  fixture.policies.push({id:'policy-created-before-interruption',name:journal.access.name},{id:'policy-unrelated',name:journal.access.name+'-other'});
  await persist();const restored=await cleanup.readCleanupJournal(path,owner);
  await cleanup.cleanupOwnedResources({api:fixture.api,journal:restored,persist:()=>cleanup.saveCleanupJournal(path,restored)});
  assert.deepEqual(fixture.tokens.map(value=>value.id),['token-unrelated']);assert.deepEqual(fixture.policies.map(value=>value.id),['policy-unrelated']);
}));

test('Access reconciliation searches all provider inventory pages',async()=>journalFixture(async({cleanup,journal,persist})=>{
  const fixture=provider();journal.access.appId='app-owned';journal.access.tokenAttempted=true;
  fixture.tokens.push({id:'owned-on-later-page',name:journal.access.name});
  const request=fixture.api.request.bind(fixture.api);
  fixture.api.list=path=>request(path);
  fixture.api.request=(path,options)=>options?.method==='DELETE'?request(path,options):Promise.resolve([]);
  await cleanup.cleanupOwnedResources({api:fixture.api,journal,persist});assert.equal(fixture.tokens.length,0);
}));

test('cleanup refuses ambiguous or renamed resources and journals from a different owner',async()=>journalFixture(async({cleanup,path,journal,persist})=>{
  const fixture=provider();journal.access.appId='app-owned';journal.access.tokenAttempted=true;journal.access.tokenId='known-token';
  fixture.tokens.push({id:'known-token',name:'someone-elses-token'},{id:'different-token',name:journal.access.name});await persist();
  await assert.rejects(cleanup.cleanupOwnedResources({api:fixture.api,journal,persist}));assert.equal(fixture.deletes.length,0);
  await assert.rejects(cleanup.readCleanupJournal(path,{...owner,runId:'999'}));
}));

test('Workflow proof correlates repo, branch and commit and requires the validation step',async()=>{
  const {waitForWorkflowProof}=await import('./ci/install.mjs');
  const identity={namespace:'ci-work',repo:'ci-owned',ref:'refs/heads/attempts/ci-owned',commit:'c'.repeat(40)},requests=[];
  const params={type:'cf.artifacts.repo.pushed',source:{namespace:'ci-work',repoName:'ci-owned'},payload:{ref:identity.ref,after:identity.commit}};
  const instance=(overrides={})=>({status:'complete',params,trigger:{source:'event'},...overrides});
  const unrelated={eventType:{...params,type:'cf.artifacts.repo.cloned'},sourceType:{...params,source:{...params.source,type:'another-source'}},commit:{...params,payload:{...params.payload,after:'d'.repeat(40)}},repo:{...params,source:{...params.source,repoName:'other-repo'}},branch:{...params,payload:{...params.payload,ref:'refs/heads/ci-proof'}},namespace:{...params,source:{...params.source,namespace:'other-namespace'}}};
  const api={async request(path){requests.push(path);if(path.includes('?per_page='))return ['old',...Object.keys(unrelated),'owned'].map(id=>({id,trigger_source:'event'}));for(const [id,value] of Object.entries(unrelated))if(path.endsWith('/'+id+'?simple=true'))return instance({status:'errored',params:value});if(path.endsWith('/owned?simple=true'))return instance();if(path.endsWith('/owned?simple=false'))return instance({steps:[{type:'step',name:'validate committed result-1',success:true}]});throw Error('Unexpected request');}};
  const value=await waitForWorkflowProof({api,path:'/accounts/test/workflows/test/instances',before:new Set(['old']),identity,timeoutMs:0});
  assert.deepEqual(value,{kind:'wiring',instanceId:'owned'});assert(!requests.some(path=>path.includes('/old?')||Object.keys(unrelated).some(id=>path.endsWith('/'+id+'?simple=false'))));
  const failedApi={request:async path=>path.includes('?per_page=')?[{id:'owned',trigger_source:'event'}]:instance({steps:[]})};
  await assert.rejects(waitForWorkflowProof({api:failedApi,path:'/instances',before:new Set(),identity,timeoutMs:0}),/CI_WORKFLOW_STEP_MISSING/);
  const wrongStep={request:async path=>path.includes('?per_page=')?[{id:'owned',trigger_source:'event'}]:instance({steps:[{type:'step',name:'validate committed result-extra',success:true}]})};
  await assert.rejects(waitForWorkflowProof({api:wrongStep,path:'/instances',before:new Set(),identity,timeoutMs:0}),/CI_WORKFLOW_STEP_MISSING/);
  const manuallyStarted={request:async path=>path.includes('?per_page=')?[{id:'owned',trigger_source:'event'}]:instance({trigger:{source:'api'}})};
  await assert.rejects(waitForWorkflowProof({api:manuallyStarted,path:'/instances',before:new Set(),identity,timeoutMs:0}),/CI_WORKFLOW_PROOF_TIMEOUT/);
});
