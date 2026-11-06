#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,realpath,readFile,readdir} from 'node:fs/promises';
import {resolve,relative,sep,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {accountAuthorization} from './lib/native-auth.mjs';
import {privateProcess} from './lib/private-process.mjs';
import {cloudflareAPI,qaOrigin,qaPermissions,withQAAccess,withQAServiceAuth} from './browser-run-qa.mjs';

export function developmentApp(apps,origin) {
  const hostname=new URL(origin).hostname;
  if(!/^[^.]+\.[^.]+\.workers\.dev$/.test(hostname))return undefined;
  const domain='*.'+hostname.split('.').slice(1).join('.');
  const matches=apps.filter(a=>a.type==='self_hosted'&&a.domain===domain);
  assert(matches.length<=1,'Ambiguous Workers development Access app');return matches[0];
}
const root=fileURLToPath(new URL('../',import.meta.url));
async function fixtureAssets(){
  const directory=resolve(root,'apps/control-plane/dist/client'),result={};
  async function walk(path){for(const item of await readdir(path,{withFileTypes:true})){const file=resolve(path,item.name);if(item.isDirectory())await walk(file);else if(item.isFile()){const key='/'+relative(directory,file).split(sep).join('/'),type=file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream';result[key]={type,body:(await readFile(file)).toString('base64')};}}}
  await walk(directory);assert(result['/index.html'],'Build the UI before target-access QA');return result;
}
const cf=async(accountId,args)=>{const r=JSON.parse((await privateProcess('cf',['browser-run','devtools',...args],{env:{...process.env,CLOUDFLARE_ACCOUNT_ID:accountId},accountAuthorization:true,timeout:60_000})).toString());return r.result??r;};
export async function main(args=process.argv.slice(2)) {
  const {values}=parseArgs({args,options:{account:{type:'string'},origin:{type:'string'},output:{type:'string'},'run-id':{type:'string'},'target-access':{type:'boolean'},'ui-only':{type:'boolean'},'fixture-origin':{type:'string'},probe:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log('Usage: npm run qa:ui:interactive -- --account ACCOUNT_ID --origin https://APP_HOST --output OUTSIDE_REPO [--run-id EXISTING_COMPLETED_RUN] [--probe] [--target-access --ui-only] [--target-access --fixture-origin https://OWNED_TEST_HOST]');return;}
  const accountId=values.account??process.env.CLOUDFLARE_ACCOUNT_ID;assert.match(accountId??'',/^[a-f0-9]{32}$/);
  const origin=qaOrigin(values.origin??'');
  if(values['ui-only'])assert(values['target-access'],'--ui-only requires --target-access');
  const fixtureOrigin=values['fixture-origin']?qaOrigin(values['fixture-origin']):values['ui-only']?'https://target.invalid':undefined;
  if(values['target-access'])assert(fixtureOrigin,'Target access QA requires --fixture-origin for a task-owned synthetic target');assert(values.output,'Select --output outside the repository');
  if(values['run-id'])assert.match(values['run-id'],/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
  const directory=resolve(values.output);await mkdir(directory,{recursive:true,mode:0o700});
  const outside=relative(await realpath(root),await realpath(directory));assert(outside.startsWith('..'+sep)||isAbsolute(outside),'Evidence must stay outside the repository');
  const taskId=randomUUID(),workerName='pentcloud-browser-qa-'+taskId.slice(0,8);
  const proof={startedAt:new Date().toISOString(),origin,result:'blocked',mode:'Cloudflare Playwright / native Browser binding',newRuns:0,taskId,workerName,appAccess:{},devAccess:{}};
  const secrets=[];Object.defineProperty(proof.appAccess,'secretValues',{value:secrets});Object.defineProperty(proof.devAccess,'secretValues',{value:secrets});
  const save=()=>writeFile(resolve(directory,'report.json'),JSON.stringify(proof,null,2),{mode:0o600});
  let auth,ownedId,api,deployAttempted=false;
  const controller=new AbortController(),interrupt=()=>controller.abort();
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const base=`/accounts/${accountId}`,settingsPath=`${base}/workers/scripts/${workerName}/settings`;
  try {
    auth=await accountAuthorization({accountId,run:privateProcess,permissionNames:['Workers Scripts Write',...qaPermissions],purpose:'browser qa'});
    secrets.push(auth.token);if(auth.id)proof.accountLease={id:auth.id,name:auth.name,expiresOn:auth.expiresOn};
    api=cloudflareAPI(auth.token);const subdomain=(await api('GET',`${base}/workers/subdomain`)).subdomain;
    assert.match(subdomain??'',/^[a-z0-9-]+$/);
    const qaOriginURL=`https://${workerName}.${subdomain}.workers.dev`;
    const apps=[];for(let n=1;n<=100;n++){const batch=await api('GET',`${base}/access/apps?per_page=50&page=${n}`);apps.push(...batch);if(batch.length<50)break;assert(n<100,'Access inventory bound exceeded');}
    const devApp=developmentApp(apps,qaOriginURL);
    assert(devApp?.aud,'Interactive QA requires the account Workers development Access application; no public QA Worker is deployed');
    proof.qaOrigin=qaOriginURL;
    try{await api('GET',settingsPath);throw Error('QA Worker name already exists');}catch(e){if(!e.message.includes('HTTP 404'))throw e;}
    await withQAAccess({api,accountId,origin,proof:proof.appAccess},async({headers})=>{
      const existingCredential={id:proof.appAccess.serviceTokenId,client_id:headers['CF-Access-Client-Id'],client_secret:headers['CF-Access-Client-Secret']};
      await withQAServiceAuth({api,accountId,app:devApp,proof:proof.devAccess,existingCredential},async()=>{
        try {
          controller.signal.throwIfAborted();
          const created=await cf(accountId,['browser','create','--keep-alive','180000','--body',JSON.stringify({guardrails:{allowedDomains:values.probe?[]:values['target-access']?['ui.pentcloud.test',new URL(fixtureOrigin).hostname]:[new URL(origin).hostname]}})]);
          ownedId=created.sessionId;assert.match(ownedId??'',/^[a-f0-9-]{36}$/);proof.sessionId=ownedId;
          await save();deployAttempted=true;
          await privateProcess('node',[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',resolve(root,'scripts/browser-qa/wrangler.jsonc'),'--name',workerName,
            '--var',`QA_RUN_ID:${taskId}`,'--var',`QA_BROWSER_ID:${ownedId}`,'--var',`QA_ORIGIN:${origin}`,'--var',`QA_ACCESS_AUD:${devApp.aud}`],{
            cwd:root,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:accountId,CLOUDFLARE_API_TOKEN:auth.token,WRANGLER_SEND_METRICS:'false'},accountAuthorization:true,timeout:180_000});
          proof.workerDeployed=true;await save();
          controller.signal.throwIfAborted();
          let ready=false;
          for(let attempt=0;attempt<60;attempt++){
            controller.signal.throwIfAborted();
            const health=await fetch(qaOriginURL+'/health',{headers,redirect:'manual',signal:AbortSignal.timeout(10_000)});
            if(health.ok){const value=await health.json();if(value.ready&&value.taskId===taskId){ready=true;break;}}
            proof.healthStatus=health.status;
            await new Promise(resolve=>setTimeout(resolve,2000));
          }
          assert(ready,`QA Worker not ready after deployment (HTTP ${proof.healthStatus})`);
          const anonymous=await fetch(qaOriginURL+'/health',{redirect:'manual',signal:AbortSignal.timeout(10_000)});
          assert(!anonymous.ok,'QA Worker accepted an unauthenticated request');proof.anonymousAccessDenied=true;
          const response=await fetch(qaOriginURL+'/run',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({origin,headers,runId:values['run-id'],probe:values.probe,...(values['target-access']?{targetAccess:true,uiOnly:values['ui-only']===true,fixtureOrigin,assets:await fixtureAssets()}:{} )}),redirect:'manual',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(480_000)])});
          assert(response.ok,`Native QA invocation HTTP ${response.status}`);
          const evidence=await response.json();assert.equal(evidence.sessionId,ownedId,'QA session provenance mismatch');
          for(const capture of evidence.captures??[]){assert.match(capture.screenshot,/^[a-z-]+-\d+\.(?:png|jpg)$/);await writeFile(resolve(directory,capture.screenshot),Buffer.from(capture.png,'base64'),{mode:0o600});delete capture.png;}
          for(const trace of evidence.traces??[]){assert.match(trace.name,/^actions-\d+\.zip$/);const clean=await privateProcess('python3',[resolve(root,'scripts/lib/sanitize-qa-trace.py')],{input:JSON.stringify({zip:trace.zip,secrets}),timeout:60_000});await writeFile(resolve(directory,trace.name),clean,{mode:0o600});delete trace.zip;}
          Object.assign(proof,evidence);
        }finally{
          if(deployAttempted){
            try{
              const settings=await api('GET',settingsPath);
              assert(settings.bindings?.some(b=>b.name==='QA_RUN_ID'&&b.text===taskId),'QA Worker ownership unconfirmed');
              await api('DELETE',`${base}/workers/scripts/${workerName}`);
              try{await api('GET',settingsPath);throw Error('QA Worker still exists');}catch(e){if(!e.message.includes('HTTP 404'))throw e;}
              proof.workerCleanup='removed';
            }catch(e){if(e.message.includes('HTTP 404'))proof.workerCleanup='absent';else{proof.workerCleanup='unconfirmed';throw Error('Task-owned QA Worker cleanup unconfirmed');}}
          }
        }
      });
    });
  }catch(error){proof.result='failed';proof.error=String(error.message).split('\n')[0];for(const secret of secrets)proof.error=proof.error.split(secret).join('[redacted]');proof.error=proof.error.slice(0,300);process.exitCode=1;}
  finally{
    if(ownedId){try{const sessions=await cf(accountId,['session','list']);if(sessions.some(s=>s.sessionId===ownedId&&!s.endTime))await cf(accountId,['browser','delete',ownedId,'--force']);proof.browserClosed=!(await cf(accountId,['session','list'])).some(s=>s.sessionId===ownedId&&!s.endTime);}catch{proof.browserClosed=false;}if(!proof.browserClosed){proof.result='failed';process.exitCode=1;}}
    if(auth)try{await auth.close();proof.accountLeaseCleanup='released';}catch{proof.accountLeaseCleanup='unconfirmed';proof.result='failed';process.exitCode=1;}
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    proof.finishedAt=new Date().toISOString();await save();const counts={};for(const c of proof.cases??[])counts[c.result]=(counts[c.result]??0)+1;
    if(['failed','blocked','issues-found'].includes(proof.result))process.exitCode=1;
    console.log(JSON.stringify({result:proof.result,counts,captures:proof.captures?.length??0,browserClosed:proof.browserClosed,workerCleanup:proof.workerCleanup,error:proof.error,report:resolve(directory,'report.json')}));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
