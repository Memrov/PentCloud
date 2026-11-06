#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {PackageInstaller,PACK_CLASSES} from '../lib/package-install.mjs';
import {privateJson,withStateLock,readJson} from '../lib/private-install.mjs';
import {privateProcess} from '../lib/private-process.mjs';
import {withQAAccess} from '../browser-run-qa.mjs';
import {environment,client,validateAccount,stateLedger,checkpointLedger,withGit} from './artifacts.mjs';

async function main(){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),e=environment(),api=client(e);
  await validateAccount(api,e);
  const directory=join(process.env.RUNNER_TEMP,'pentcloud-install-state'),ledger=join(process.env.RUNNER_TEMP,'pentcloud-install-ledger');
  const checkpoint=await stateLedger(api,e,ledger,directory);
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
  const installer=new PackageInstaller({config,profile:{domain:{zoneId:e.zoneId,hostname:e.hostname},images},stateDirectory:directory,root,api,run,checkpoint,log:r=>console.log(JSON.stringify({stage:r.stage,status:r.status}))});
  await withStateLock(directory,async()=>{
    const previous=await readJson(join(directory,'manifest.json'),null);
    await installer.install({upgrade:!!previous,verify:false});
  });
  console.log('Package-only installation provisioned; verifying native services.');
  const base='/accounts/'+e.accountId,id='ci-'+process.env.GITHUB_RUN_ID+'-'+process.env.GITHUB_RUN_ATTEMPT;
  assert.match(id,/^ci-[0-9]+-[0-9]+$/);
  const probeName='pentcloud-'+id+'-probe',probeConfig=join(process.env.RUNNER_TEMP,'pentcloud-probe.json'),secret=randomBytes(32).toString('base64url');
  const workerDomain=await api.request(base+'/workers/subdomain');
  const probeOrigin='https://'+probeName+'.'+workerDomain.subdomain+'.workers.dev';
  await privateJson(probeConfig,{
    name:probeName,account_id:e.accountId,main:join(root,'scripts/ci/probe-worker.mjs'),
    compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat'],workers_dev:true,preview_urls:false,observability:{enabled:false},
    browser:{binding:'BROWSER'},ai:{binding:'AI'},worker_loaders:[{binding:'LOADER'}],
    artifacts:[{binding:'ARTIFACTS',namespace:installer.names.namespace}],
    services:[{binding:'TOOL_PACKS',service:installer.names.gateway,entrypoint:'ToolPackGateway'}],
    vars:{APP_ORIGIN:installer.state.appUrl},
  });
  const proof={checks:[],secretValues:[]};
  const request=(method,path,body)=>api.request(path,{method,body});
  let deployed=false;
  const probe=async body=>{
    const response=await fetch(probeOrigin,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(300000)});
    assert.equal(response.status,200,'Native service probe failed: '+body.action+(body.pack?' '+body.pack:''));
    const result=await response.json();assert(!result.error,'Native probe reported failure');return result;
  };
  try{
    const scripts=await api.list(base+'/workers/scripts');
    assert(!scripts.some(s=>s.id===probeName),'Probe name is already in use');
    await run('wrangler',['deploy','--config',probeConfig]);deployed=true;
    await installer.workerSecret(probeName,'CI_PROBE_TOKEN',secret);
    await withQAAccess({api:request,accountId:e.accountId,origin:installer.state.appUrl,proof},async({headers})=>{
      for(const path of ['/v1/runs?view=all','/v1/onboarding','/v1/lifecycle']){
        const r=await fetch(installer.state.appUrl+path,{headers,redirect:'manual',signal:AbortSignal.timeout(60000)});
        assert.equal(r.status,200,'Authenticated application check failed');
      }
      proof.checks.push('Access-authenticated API and Durable Objects');
      const missing=await fetch(installer.state.appUrl+'/v1/toolbox/status',{headers,redirect:'manual'});
      assert.equal(missing.status,404,'Package installation still exposes a Kali runtime');
      for(const action of ['loader','markdown']){await probe({action});proof.checks.push(action);}
      await probe({action:'browser',headers});proof.checks.push('Browser Run protected application');
    });
    assert(Object.values(proof.cleanup).every(x=>x==='removed'),'Temporary Access resources remain');
    const workflowPath=base+'/workflows/'+installer.names.workflow+'/instances';
    const before=new Set((await api.request(workflowPath+'?per_page=100&direction=desc')).map(x=>x.id));
    const evidenceBase=base+'/artifacts/namespaces/'+installer.names.namespace,repo=id,gitDir=join(process.env.RUNNER_TEMP,'pentcloud-evidence'),marker='PentCloud installation proof '+e.sha;
    await api.request(evidenceBase+'/repos',{method:'POST',body:{name:repo,description:'Synthetic installation CI evidence'}});
    await mkdir(gitDir,{recursive:true,mode:0o700});
    const commit=await withGit(api,evidenceBase,repo,'write',async(git,remote)=>{
      await git(['init','--initial-branch=ci-proof',gitDir]);
      await writeFile(join(gitDir,'evidence.txt'),marker,{mode:0o600});
      await git(['-C',gitDir,'add','evidence.txt']);
      await git(['-C',gitDir,'-c','user.name=PentCloud CI','-c','user.email=actions@users.noreply.github.com','commit','-m','Synthetic installation evidence']);
      await git(['-C',gitDir,'push',remote,'HEAD:refs/heads/ci-proof']);
      return (await git(['-C',gitDir,'rev-parse','HEAD'])).toString().trim();
    });
    await probe({action:'artifacts',repo,commit,expected:marker});proof.checks.push('Artifacts Git write and native binding read');
    const deadline=Date.now()+300000;
    while(true){
      const rows=await api.request(workflowPath+'?per_page=100&direction=desc');
      const triggered=rows.filter(x=>!before.has(x.id)&&x.trigger_source==='event');
      assert(!triggered.some(x=>x.status==='errored'),'Artifacts result Workflow failed');
      if(triggered.some(x=>x.status==='complete'))break;
      assert(Date.now()<deadline,'Artifacts push did not complete an event-triggered Workflow');
      await new Promise(r=>setTimeout(r,5000));
    }
    proof.checks.push('Artifacts push to result Workflow');
    for(const pack of Object.keys(PACK_CLASSES)){
      await probe({action:'pack',pack,id});
      proof.checks.push('tool-pack '+pack);
      console.log('Verified and retired tool-pack '+pack+'.');
    }
    await installer.doctor({authenticate:false});
    const summary=['## Package-only installation test','',...proof.checks.map(x=>'- Passed: '+x),'','Kali installed: no. Model calls: zero. One bounded HTTP package request used the dedicated test hostname.','Cloudflare account logs, login/session data, provider bodies and private installation state are not uploaded.'].join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+'\n');
    console.log('Native Artifacts installation checks passed.');
  }finally{
    if(deployed){
      await api.request(base+'/workers/scripts/'+probeName,{method:'DELETE',missing:true});
      assert(!(await api.list(base+'/workers/scripts')).some(s=>s.id===probeName),'Disposable probe remains deployed');
    }
  }
}
main().catch(error=>{
  // Provider bodies and account identities are deliberately not emitted.
  const message=String(error.message??'').replace(/[a-f0-9]{32}/g,'[redacted-id]').replace(/https?:\/\/[^\s]+/g,'[redacted-url]');
  console.error('Installation test failed: '+message);process.exitCode=1;
});

