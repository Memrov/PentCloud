// Shared, bounded verification for a provisioned customer installation.
// API contracts reviewed 2026-11-06:
// https://developers.cloudflare.com/artifacts/api/rest-api/
// https://developers.cloudflare.com/artifacts/api/workers-binding/
// https://developers.cloudflare.com/artifacts/guides/event-subscriptions/
// https://developers.cloudflare.com/api/resources/workflows/subresources/instances/
// https://developers.cloudflare.com/api/typescript/resources/workers/subresources/domains/
// https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
// https://developers.cloudflare.com/dynamic-workers/getting-started/
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/
// https://developers.cloudflare.com/browser-run/playwright/
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PACK_CLASSES} from './package-install.mjs';
import {privateJson} from './private-install.mjs';
import {verificationOwner,verificationJournalPath,createVerificationJournal,saveCleanupJournal,cleanupInstallationVerification,deployProbe,probeHostname,withCIProbeAccess,createEvidenceRepository} from './owned-probe.mjs';
export {cleanupInstallationVerification,withInstallationAccess} from './owned-probe.mjs';
export const VERIFICATION_STAGES=Object.freeze(['verification-prepare','probe-deploy','probe-secret','probe-readiness','access','access-setup','api-runs','api-onboarding','api-lifecycle','no-kali','native-loader','native-markdown','native-browser','access-cleanup','artifacts','workflow','tool-packs','doctor']);
export const PROBE_CHECKPOINTS=Object.freeze(['loader-create','loader-fetch','markdown-convert','markdown-result','browser-launch','browser-context','browser-access','browser-request','browser-redirect','browser-fulfill','browser-navigate','browser-content','pack-ready','pack-command','pack-stop']);
const safeHttpStatus=value=>Number.isInteger(value)&&value>=100&&value<=599;

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
        assert(Array.isArray(result.steps)&&result.steps.some(step=>step.type==='step'&&['validate committed result','validate committed result-1'].includes(step.name)&&step.success===true),'CI_WORKFLOW_STEP_MISSING');
        return {kind:'wiring',instanceId:own};
      }
    }
    assert(now()<deadline,'CI_WORKFLOW_PROOF_TIMEOUT');await sleep(5000);
  }
}
export async function verifyPackageInstallation({installer,root,run,temporaryDirectory,sourceCommit,log=()=>{}}){
  let stage='verification-prepare',journal,probeConfig,gitDirectory,probeStatus,probeCheckpoint;
  const {api,config}=installer,accountId=config.accountId,instance=config.instance;
  const report=(check,status,extra={})=>log({check,status,...extra});
  const enter=value=>{stage=value;probeStatus=undefined;probeCheckpoint=undefined;};
  const observed=(check,status)=>{if(safeHttpStatus(status))probeStatus=status;report(check,status);};
  try{
    assert.match(sourceCommit??'',/^[a-f0-9]{40}$/,'INSTALLATION_SOURCE_COMMIT_INVALID');
    assert.equal(typeof run,'function','INSTALLATION_RUN_REQUIRED');
    await mkdir(temporaryDirectory,{recursive:true,mode:0o700});
    const publicRoot=await realpath(root),privateRoot=await realpath(temporaryDirectory),within=relative(publicRoot,privateRoot);
    assert(within&&((within==='..'||within.startsWith('..'+sep))||isAbsolute(within)),'INSTALLATION_VERIFICATION_DIRECTORY_PRIVATE_REQUIRED');
    await cleanupInstallationVerification({api,temporaryDirectory,accountId,instance});
    const owner=verificationOwner(accountId,instance),id=owner.operationId;
    journal=await createVerificationJournal({temporaryDirectory,owner,namespace:installer.names.namespace});
    const journalPath=verificationJournalPath(temporaryDirectory),persist=()=>saveCleanupJournal(journalPath,journal),secret=randomBytes(32).toString('base64url');
    probeConfig=join(privateRoot,'probe-'+id+'.json');gitDirectory=join(privateRoot,'evidence-'+id);
    const proof={status:'verified-package-installation',checks:[],toolPacks:11,noKali:true,modelCalls:0};
    // The selected zone is fetched and verified by deployProbe before configuration
    // rendering; the unique hostname is never derived from the customer's app host.
    enter('probe-deploy');
    await deployProbe({api,journal,persist,zoneId:installer.profile.domain.zoneId,deploy:async()=>{
      await privateJson(probeConfig,{
        name:journal.probe.name,account_id:accountId,main:join(resolve(root),'scripts/lib/installation-probe-worker.mjs'),
        compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,observability:{enabled:false},
        routes:[{pattern:probeHostname(journal),zone_id:installer.profile.domain.zoneId,custom_domain:true}],
        browser:{binding:'BROWSER'},ai:{binding:'AI'},worker_loaders:[{binding:'LOADER'}],
        artifacts:[{binding:'ARTIFACTS',namespace:installer.names.namespace}],
        services:[{binding:'TOOL_PACKS',service:installer.names.gateway,entrypoint:'ToolPackGateway'}],
        vars:{APP_ORIGIN:installer.state.appUrl,CI_PROBE_EXPIRES_AT:String(Date.now()+60*60*1000)},
      });
      await run('wrangler',['deploy','--config',probeConfig]);
    }});
    enter('probe-secret');await installer.workerSecret(journal.probe.name,'CI_PROBE_TOKEN',secret);
    const probeOrigin='https://'+probeHostname(journal);
    const requestProbe=(body,timeout=300000)=>fetch(probeOrigin,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(timeout)});
    const probe=async body=>{
      probeStatus=undefined;probeCheckpoint=undefined;
      const response=await requestProbe(body),result=await response.json().catch(()=>null);
      probeStatus=safeHttpStatus(result?.httpStatus)?result.httpStatus:response.status;
      if(PROBE_CHECKPOINTS.includes(result?.checkpoint))probeCheckpoint=result.checkpoint;
      report('native-'+body.action,response.status,{...(body.pack?{pack:body.pack}:{}),...(probeCheckpoint?{checkpoint:probeCheckpoint}:{}),...(safeHttpStatus(result?.httpStatus)?{httpStatus:result.httpStatus}:{})});
      assert.equal(response.status,200,'INSTALLATION_NATIVE_PROBE_FAILED');
      assert(result&&!result.error,'INSTALLATION_NATIVE_PROBE_FAILED');
      if(body.action==='pack')assert(result.pack===body.pack&&result.status==='passed','INSTALLATION_NATIVE_PROBE_INVALID');
      else assert.equal(result[body.action],'passed','INSTALLATION_NATIVE_PROBE_INVALID');
      return result;
    };
    enter('probe-readiness');
    const ready=await waitForProbeReady({request:()=>requestProbe({action:'ready'},10000),onStatus:status=>observed('probe-readiness',status)});
    assert.deepEqual(await ready.json(),{ready:'passed'},'INSTALLATION_PROBE_READINESS_INVALID');
    enter('access-setup');
    await withCIProbeAccess({api,journal,persist,appId:installer.state.resources.access.id,origin:installer.state.appUrl},async({headers})=>{
      for(const [check,path]of [['api-runs','/v1/runs?view=all'],['api-onboarding','/v1/onboarding'],['api-lifecycle','/v1/lifecycle']]){
        enter(check);const result=await waitForAccessReady({origin:installer.state.appUrl,headers,path,onStatus:status=>observed(check,status)});await result.body?.cancel();
      }
      proof.checks.push('access-api-durable-objects');
      enter('no-kali');const missing=await waitForAccessReady({origin:installer.state.appUrl,headers,path:'/v1/toolbox/status',expectedStatus:404,onStatus:status=>observed('no-kali',status)});await missing.body?.cancel();proof.checks.push('no-kali');
      for(const action of ['loader','markdown']){enter('native-'+action);await probe({action});proof.checks.push(action);}
      enter('native-browser');await probe({action:'browser',headers});proof.checks.push('browser-protected-app');enter('access-cleanup');
    });
    assert(journal.access.policyRemoved&&journal.access.tokenRemoved,'INSTALLATION_ACCESS_CLEANUP_PENDING');
    enter('artifacts');
    const workflowPath='/accounts/'+accountId+'/workflows/'+encodeURIComponent(installer.names.workflow)+'/instances';
    const prior=await api.request(workflowPath+'?per_page=100&direction=desc');assert(Array.isArray(prior),'INSTALLATION_WORKFLOW_LIST_INVALID');
    const before=new Set(prior.map(row=>row.id));
    await createEvidenceRepository({api,journal,persist});
    const marker='PentCloud installation proof '+sourceCommit,repo=journal.evidence.name,ref='refs/heads/attempts/'+id;
    await mkdir(gitDirectory,{recursive:true,mode:0o700});await writeFile(join(gitDirectory,'evidence.txt'),marker,{mode:0o600});
    const {withArtifactGit}=await import('./artifact-state.mjs');
    const commit=await withArtifactGit({api,accountId,namespace:installer.names.namespace,repo,scope:'write',run},async(git,remote)=>{
      await git(['init','--initial-branch=attempts/'+id,gitDirectory]);
      await git(['-C',gitDirectory,'add','evidence.txt']);
      await git(['-C',gitDirectory,'-c','user.name=PentCloud verification','-c','user.email=verification@pentcloud.invalid','commit','-m','Synthetic installation evidence']);
      await git(['-C',gitDirectory,'push',remote,'HEAD:'+ref]);
      return (await git(['-C',gitDirectory,'rev-parse','HEAD'])).toString().trim();
    });
    assert.match(commit,/^[a-f0-9]{40}$/,'INSTALLATION_EVIDENCE_COMMIT_INVALID');
    await probe({action:'artifacts',repo,commit,expected:marker});proof.checks.push('artifacts-git-native-blob');
    enter('workflow');
    await waitForWorkflowProof({api,path:workflowPath,before,identity:{namespace:installer.names.namespace,repo,ref,commit}});proof.checks.push('artifacts-workflow-exact-commit');
    enter('tool-packs');
    for(const pack of Object.keys(PACK_CLASSES)){
      const expectedImage=installer.profile.images[pack];assert.equal(typeof expectedImage,'string','INSTALLATION_IMAGE_MISSING');
      await probe({action:'pack',pack,id,expectedImage});proof.checks.push('tool-pack-'+pack);
    }
    enter('doctor');await installer.doctor({authenticate:false});proof.checks.push('doctor');
    report('verification','passed');return proof;
  }catch{report(stage,'failed');throw Object.assign(Error('INSTALLATION_VERIFICATION_FAILED'),{code:'PC_INSTALLATION_VERIFICATION',verificationStage:stage,...(PROBE_CHECKPOINTS.includes(probeCheckpoint)?{probeCheckpoint}:{}),...(safeHttpStatus(probeStatus)?{probeStatus}:{})});}
  finally{
    if(journal)await cleanupInstallationVerification({api,temporaryDirectory,accountId,instance});
    if(probeConfig)await rm(probeConfig,{force:true});
    if(gitDirectory)await rm(gitDirectory,{recursive:true,force:true});
  }
}
