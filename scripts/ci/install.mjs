#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {PackageInstaller,PACK_CLASSES} from '../lib/package-install.mjs';
import {privateJson,withStateLock,readJson} from '../lib/private-install.mjs';
import {privateProcess} from '../lib/private-process.mjs';
import {environment,client,validateAccount,stateLedger,withGit} from './artifacts.mjs';
import {cleanupPath,cleanupOwner,createCleanupJournal,saveCleanupJournal,deployProbe,probeHostname,withCIProbeAccess,cleanupOwnedResources} from './cleanup.mjs';

let stage='environment';
export async function waitForProbeReady({request,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=120000,onStatus=()=>{}}){
  const deadline=now()+timeoutMs;
  for(;;){
    let response;
    try{response=await request();}catch{onStatus('network-pending');}
    if(response){
      onStatus(response.status);
      if(response.status===200)return response;
      await response.body?.cancel();
      assert([401,403,404,502,503,525,526,530].includes(response.status),'CI_PROBE_UNEXPECTED_STATUS');
    }
    assert(now()<deadline,'CI_PROBE_READINESS_TIMEOUT');
    await sleep(Math.min(2000,deadline-now()));
  }
}
export async function waitForAccessReady({origin,headers,path='/v1/runs?view=all',expectedStatus=200,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=120000,onStatus=()=>{}}){
  assert(path.startsWith('/v1/')&&!path.startsWith('//')&&[200,404].includes(expectedStatus),'CI_ACCESS_CHECK_INVALID');
  const deadline=now()+timeoutMs;
  for(;;){
    const response=await fetcher(origin+path,{headers,redirect:'manual',signal:AbortSignal.timeout(60000)});
    onStatus(response.status);
    if(response.status===expectedStatus)return response;
    await response.body?.cancel();
    assert([302,303,401,403].includes(response.status),'CI_ACCESS_UNEXPECTED_STATUS');
    assert(now()<deadline,'CI_ACCESS_READINESS_TIMEOUT');
    await sleep(Math.min(2000,deadline-now()));
  }
}
export async function waitForWorkflowProof({api,path,before,identity,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=300000}){
  const matches=value=>{
    const params=value?.params,source=params?.source;
    return params?.type==='cf.artifacts.repo.pushed'&&(source?.type===undefined||source.type==='artifacts.repo')&&source?.namespace===identity.namespace&&source.repoName===identity.repo&&params.payload?.ref===identity.ref&&params.payload.after===identity.commit&&value.trigger?.source==='event';
  };
  const deadline=now()+timeoutMs;let own;
  for(;;){
    if(!own){
      const rows=await api.request(path+'?per_page=100&direction=desc');
      assert(Array.isArray(rows),'CI_WORKFLOW_LIST_INVALID');
      for(const row of rows){
        if(before.has(row.id)||row.trigger_source!=='event')continue;
        const candidate=await api.request(path+'/'+encodeURIComponent(row.id)+'?simple=true');
        if(matches(candidate)){own=row.id;break;}
      }
    }
    if(own){
      // Only the matching synthetic event's step metadata is inspected. Never log responses.
      const result=await api.request(path+'/'+encodeURIComponent(own)+'?simple=false');
      assert(matches(result),'CI_WORKFLOW_IDENTITY_CHANGED');
      assert(!['errored','terminated'].includes(result.status),'CI_WORKFLOW_EXECUTION_FAILED');
      if(result.status==='complete'){
        assert(Array.isArray(result.steps)&&result.steps.some(step=>step.type==='step'&&step.name==='validate committed result'&&step.success===true),'CI_WORKFLOW_STEP_MISSING');
        return {kind:'wiring',instanceId:own};
      }
    }
    assert(now()<deadline,'CI_WORKFLOW_PROOF_TIMEOUT');await sleep(5000);
  }
}
export async function main(){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),e=environment(),api=client(e);
  stage='account';
  await validateAccount(api,e);
  const directory=join(process.env.RUNNER_TEMP,'pentcloud-install-state'),ledger=join(process.env.RUNNER_TEMP,'pentcloud-install-ledger');
  stage='state';const checkpoint=await stateLedger(api,e,ledger,directory);
  await checkpoint();
  const config={schemaVersion:1,accountId:e.accountId,instance:'pentcloud-ci',accessTeamDomain:e.team,allowedEmails:e.emails};
  const images=JSON.parse(await readFile(join(process.env.RUNNER_TEMP,'pentcloud-pack-images.json'),'utf8'));
  const run=async(kind,args,options={})=>{
    if(kind==='wrangler')return privateProcess(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),...args],{cwd:root,...options});
    if(kind==='node')return privateProcess(process.execPath,args,{cwd:root,...options});
    if(kind==='build'){
      await privateProcess('bash',[join(root,'scripts/build-prompt-renderer.sh')],{cwd:root});
      return privateProcess(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'build'],{cwd:join(root,'apps/control-plane')});
    }
    return privateProcess(kind,args,{cwd:root,...options});
  };
  const installer=new PackageInstaller({config,profile:{domain:{zoneId:e.zoneId,hostname:e.hostname},images},stateDirectory:directory,root,api,run,checkpoint});
  stage='installation';
  await withStateLock(directory,async()=>{
    const previous=await readJson(join(directory,'manifest.json'),null);
    await installer.install({upgrade:!!previous,verify:false});
  });
  console.log('Package-only installation provisioned; verifying native services.');
  const base='/accounts/'+e.accountId,id='ci-'+process.env.GITHUB_RUN_ID+'-'+process.env.GITHUB_RUN_ATTEMPT;
  assert.match(id,/^ci-[0-9]+-[0-9]+$/);
  stage='probe-prepare';
  const journalPath=cleanupPath(),journal=await createCleanupJournal(journalPath,cleanupOwner(e.accountId)),persist=()=>saveCleanupJournal(journalPath,journal);
  const probeName=journal.probe.name,probeConfig=join(process.env.RUNNER_TEMP,'pentcloud-probe.json'),secret=randomBytes(32).toString('base64url');
  const probeOrigin='https://'+probeHostname(journal);
  await privateJson(probeConfig,{
    name:probeName,account_id:e.accountId,main:join(root,'scripts/ci/probe-worker.mjs'),
    compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,observability:{enabled:false},
    routes:[{pattern:probeHostname(journal),zone_id:e.zoneId,custom_domain:true}],
    browser:{binding:'BROWSER'},ai:{binding:'AI'},worker_loaders:[{binding:'LOADER'}],
    artifacts:[{binding:'ARTIFACTS',namespace:installer.names.namespace}],
    services:[{binding:'TOOL_PACKS',service:installer.names.gateway,entrypoint:'ToolPackGateway'}],
    vars:{APP_ORIGIN:installer.state.appUrl,CI_PROBE_EXPIRES_AT:String(Date.now()+60*60*1000)},
  });
  const proof={checks:[]};
  const requestProbe=(body,timeout=300000)=>fetch(probeOrigin,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(timeout)});
  const probe=async body=>{
    const response=await requestProbe(body);
    const result=await response.json().catch(()=>null);
    const checkpoints=['loader-create','loader-fetch','markdown-convert','markdown-result','browser-launch','browser-access','browser-navigate','browser-content','pack-ready','pack-command','pack-stop'];
    console.log(JSON.stringify({check:'native-'+body.action,...(body.pack?{pack:body.pack}:{}),status:response.status,...(checkpoints.includes(result?.checkpoint)?{checkpoint:result.checkpoint}:{})}));
    assert.equal(response.status,200,'Native service probe failed: '+body.action+(body.pack?' '+body.pack:''));
    assert(result&&!result.error,'Native probe reported failure');return result;
  };
  try{
    stage='probe-deploy';
    await deployProbe({api,journal,persist,zoneId:e.zoneId,deploy:()=>run('wrangler',['deploy','--config',probeConfig])});
    await installer.workerSecret(probeName,'CI_PROBE_TOKEN',secret);
    stage='probe-readiness';
    const probeReady=await waitForProbeReady({request:()=>requestProbe({action:'ready'},10000),onStatus:status=>console.log(JSON.stringify({check:stage,status}))});
    assert.deepEqual(await probeReady.json(),{ready:'passed'},'CI_PROBE_READINESS_INVALID');
    stage='access-probe';
    await withCIProbeAccess({api,journal,persist,appId:installer.state.resources.access.id,origin:installer.state.appUrl},async({headers})=>{
      for(const path of ['/v1/runs?view=all','/v1/onboarding','/v1/lifecycle']){
        stage='access-api-'+path.split('/').at(-1).split('?')[0];
        const r=await waitForAccessReady({origin:installer.state.appUrl,headers,path,onStatus:status=>console.log(JSON.stringify({check:stage,status}))});
        assert.equal(r.status,200,'Authenticated application check failed');
        await r.body?.cancel();
      }
      proof.checks.push('Access-authenticated API and Durable Objects');
      stage='access-no-kali';
      const missing=await waitForAccessReady({origin:installer.state.appUrl,headers,path:'/v1/toolbox/status',expectedStatus:404,onStatus:status=>console.log(JSON.stringify({check:stage,status}))});
      assert.equal(missing.status,404,'Package installation still exposes a Kali runtime');
      await missing.body?.cancel();
      for(const action of ['loader','markdown']){stage='native-'+action;await probe({action});proof.checks.push(action);}
      stage='native-browser';
      await probe({action:'browser',headers});proof.checks.push('Browser Run protected application');
    });
    assert(journal.access.policyRemoved&&journal.access.tokenRemoved,'CI_ACCESS_CLEANUP_PENDING');
    stage='artifacts-proof';
    const workflowPath=base+'/workflows/'+installer.names.workflow+'/instances';
    const before=new Set((await api.request(workflowPath+'?per_page=100&direction=desc')).map(x=>x.id));
    const evidenceBase=base+'/artifacts/namespaces/'+installer.names.namespace,repo=id,gitDir=join(process.env.RUNNER_TEMP,'pentcloud-evidence'),marker='PentCloud installation proof '+e.sha;
    await api.request(evidenceBase+'/repos',{method:'POST',body:{name:repo,description:'Synthetic installation CI evidence'}});
    await mkdir(gitDir,{recursive:true,mode:0o700});
    const commit=await withGit(api,evidenceBase,repo,'write',async(git,remote)=>{
      await git(['init','--initial-branch=attempts/'+id,gitDir]);
      await writeFile(join(gitDir,'evidence.txt'),marker,{mode:0o600});
      await git(['-C',gitDir,'add','evidence.txt']);
      await git(['-C',gitDir,'-c','user.name=PentCloud CI','-c','user.email=actions@users.noreply.github.com','commit','-m','Synthetic installation evidence']);
      await git(['-C',gitDir,'push',remote,'HEAD:refs/heads/attempts/'+id]);
      return (await git(['-C',gitDir,'rev-parse','HEAD'])).toString().trim();
    });
    await probe({action:'artifacts',repo,commit,expected:marker});proof.checks.push('Artifacts Git write and native binding read');
    stage='workflow-wiring';
    await waitForWorkflowProof({api,path:workflowPath,before,identity:{namespace:installer.names.namespace,repo,ref:'refs/heads/attempts/'+id,commit}});
    proof.checks.push('Artifacts push to Workflow wiring: exact synthetic commit reached validate committed result; unknown job ignored (not result acceptance)');
    stage='tool-packs';
    for(const pack of Object.keys(PACK_CLASSES)){
      await probe({action:'pack',pack,id});
      proof.checks.push('tool-pack '+pack);
      console.log('Verified and retired tool-pack '+pack+'.');
    }
    stage='doctor';await installer.doctor({authenticate:false});
  }finally{
    const failedStage=stage;stage='cleanup';
    await cleanupOwnedResources({api,journal,persist});await rm(journalPath);stage=failedStage;
  }
  const summary=['## Package-only installation test','',...proof.checks.map(x=>'- Passed: '+x),'','Kali installed: no. Model calls: zero. One bounded HTTP package request used the dedicated test hostname.','Cloudflare account logs, login/session data, provider bodies and private installation state are not uploaded.'].join('\n');
  stage='summary';await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+'\n');
  console.log('Native Artifacts installation checks and temporary-resource cleanup passed.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(()=>{
  // Never serialize errors: assertion diffs and provider messages can contain identities or credentials.
  console.error(JSON.stringify({stage,error:'CI_INSTALL_FAILED'}));process.exitCode=1;
});

