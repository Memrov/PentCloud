import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {withNativeTestHarness} from './lib/native-test-harness.mjs';

const root=resolve(import.meta.dirname,'..');
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

test('always cleanup succeeds without credentials or dependencies when no journal exists',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-absent-cleanup-'));
  try{
    const child=spawnSync(process.execPath,[join(root,'scripts/ci/cleanup.mjs')],{encoding:'utf8',env:{RUNNER_TEMP:directory}});
    assert.equal(child.status,0);assert.equal(child.stderr,'');
  }finally{await rm(directory,{recursive:true,force:true});}
});

const owner={repository:'Memrov/PentCloud',accountId:'a'.repeat(32),runId:'12345',attempt:'2'};
const nonce='0123456789ab';
async function journalFixture(fn){
  const cleanup=await import('./ci/cleanup.mjs');
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-cleanup-test-')),path=join(directory,'cleanup.json');
  try{const journal=await cleanup.createCleanupJournal(path,owner,nonce);await fn({cleanup,path,journal,persist:()=>cleanup.saveCleanupJournal(path,journal)});}
  finally{await rm(directory,{recursive:true,force:true});}
}
function provider(){
  const scripts=new Map(),tokens=[],policies=[],deletes=[];
  const api={async request(path,{method='GET',body}={}){
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
  return {api,scripts,tokens,policies,deletes};
}

test('cleanup reconciles an attempted probe deployment after Wrangler loses its response',async()=>journalFixture(async({cleanup,path,journal,persist})=>{
  const fixture=provider();fixture.scripts.set('unrelated-worker',true);
  await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,deploy:async()=>{fixture.scripts.set(journal.probe.name,true);throw Error('PRIVATE_DEPLOY_BODY');}}));
  const restored=await cleanup.readCleanupJournal(path,owner);
  await cleanup.cleanupOwnedResources({api:fixture.api,journal:restored,persist:()=>cleanup.saveCleanupJournal(path,restored)});
  assert.deepEqual([...fixture.scripts.keys()],['unrelated-worker']);
  assert(restored.probe.removed);
}));

test('probe name collision is never claimed or deleted',async()=>journalFixture(async({cleanup,journal,persist})=>{
  const fixture=provider();fixture.scripts.set(journal.probe.name,true);
  await assert.rejects(cleanup.deployProbe({api:fixture.api,journal,persist,deploy:async()=>assert.fail('colliding deploy')}));
  await cleanup.cleanupOwnedResources({api:fixture.api,journal,persist});
  assert(fixture.scripts.has(journal.probe.name));assert.equal(fixture.deletes.length,0);
}));

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
  const params={source:{type:'artifacts.repo',namespace:'ci-work',repoName:'ci-owned'},payload:{ref:identity.ref,after:identity.commit}};
  const instance=(overrides={})=>({status:'complete',params,trigger:{source:'event'},...overrides});
  const unrelated={commit:{...params,payload:{...params.payload,after:'d'.repeat(40)}},repo:{...params,source:{...params.source,repoName:'other-repo'}},branch:{...params,payload:{...params.payload,ref:'refs/heads/ci-proof'}},namespace:{...params,source:{...params.source,namespace:'other-namespace'}}};
  const api={async request(path){requests.push(path);if(path.includes('?per_page='))return ['old',...Object.keys(unrelated),'owned'].map(id=>({id,trigger_source:'event'}));for(const [id,value] of Object.entries(unrelated))if(path.endsWith('/'+id+'?simple=true'))return instance({status:'errored',params:value});if(path.endsWith('/owned?simple=true'))return instance();if(path.endsWith('/owned?simple=false'))return instance({steps:[{type:'step',name:'validate committed result',success:true}]});throw Error('Unexpected request');}};
  const value=await waitForWorkflowProof({api,path:'/accounts/test/workflows/test/instances',before:new Set(['old']),identity});
  assert.deepEqual(value,{kind:'wiring',instanceId:'owned'});assert(!requests.some(path=>path.includes('/old?')||Object.keys(unrelated).some(id=>path.endsWith('/'+id+'?simple=false'))));
  const failedApi={request:async path=>path.includes('?per_page=')?[{id:'owned',trigger_source:'event'}]:instance({steps:[]})};
  await assert.rejects(waitForWorkflowProof({api:failedApi,path:'/instances',before:new Set(),identity}),/CI_WORKFLOW_STEP_MISSING/);
  const manuallyStarted={request:async path=>path.includes('?per_page=')?[{id:'owned',trigger_source:'event'}]:instance({trigger:{source:'api'}})};
  await assert.rejects(waitForWorkflowProof({api:manuallyStarted,path:'/instances',before:new Set(),identity,timeoutMs:0}),/CI_WORKFLOW_PROOF_TIMEOUT/);
});
