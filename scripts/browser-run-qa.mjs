#!/usr/bin/env node
// Cloudflare Browser QA: ephemeral native Access service auth + managed captures.
// No saved app credentials, local Chromium, model calls or scanner starts.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve,relative,sep,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {accountAuthorization} from './lib/native-auth.mjs';
import {privateProcess} from './lib/private-process.mjs';

export const qaPermissions=['Access: Apps and Policies Write','Access: Service Tokens Write'];
export async function nativeSnapshot({accountId,body,run=privateProcess}) {
  assert.match(accountId,/^[a-f0-9]{32}$/);
  // cf's documented @file body input reads the process pipe, not a credential
  // file. Credentials never enter argv, shell text, logs or recovery state.
  const raw=await run('cf',['browser-run','quick-action','snapshot','--cache-ttl','0','--body','@/dev/stdin'],{
    env:{...process.env,CLOUDFLARE_ACCOUNT_ID:accountId},accountAuthorization:true,
    input:JSON.stringify(body),timeout:90_000,
  });
  const value=JSON.parse(raw.toString());return value.result??value;
}
export function qaOrigin(value) {
  const u=new URL(value);
  assert(u.protocol==='https:' && u.pathname==='/' && !u.username && !u.password && !u.search && !u.hash,'Use the exact HTTPS installation origin');
  return u.origin;
}
export function cloudflareAPI(token, fetcher=fetch) {
  return async(method,path,body)=>{
    assert(path.startsWith('/accounts/')&&!path.includes('..'),'Use an account API path');
    let response;
    try {response=await fetcher('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(45_000)});}
    catch {throw Error(`Cloudflare ${method} request unavailable; reconcile temporary QA resource names before retrying`);}
    if(!response.ok)throw Error(`Cloudflare ${method} request HTTP ${response.status}`);
    const value=await response.json();
    assert(value.success!==false,'Cloudflare rejected the QA operation');
    return value.result??value;
  };
}
// Resources are task-owned and never replace an existing Access app or policy.
export async function withQAAccess({api,accountId,origin,proof},check) {
  assert.match(accountId,/^[a-f0-9]{32}$/);
  origin=qaOrigin(origin);
  const base=`/accounts/${accountId}`;
  const apps=[];
  for(let page=1;;page++) {
    const batch=await api('GET',`${base}/access/apps?per_page=50&page=${page}`);
    assert(Array.isArray(batch),'Unexpected Access app listing');apps.push(...batch);
    if(batch.length<50)break;
    assert(page<100,'Access app inventory exceeded the QA bound');
  }
  const host=new URL(origin).host;
  const matches=apps.filter(a=>a.type==='self_hosted'&&(a.domain===host||(a.self_hosted_domains??[]).includes(host)));
  assert.equal(matches.length,1,'QA requires one exact-host Access app; wildcard/path apps are not modified');
  return withQAServiceAuth({api,accountId,app:matches[0],proof},headers=>check({headers,base,origin}));
}
// Callers must first select and validate the intended Access application.
// Shared by the exact-host application capture and the native dev-binding runner.
export async function withQAServiceAuth({api,accountId,app,proof,existingCredential},check) {
  assert.match(accountId,/^[a-f0-9]{32}$/);
  assert(app?.id && app.type==='self_hosted','Select a self-hosted Access app');
  const base=`/accounts/${accountId}`,name=`PentCloud Browser QA ${randomUUID()}`;
  proof.temporaryResourceName=name;
  const policiesPath=`${base}/access/apps/${app.id}/policies`;
  const existing=await api('GET',policiesPath);
  assert(Array.isArray(existing),'Unexpected Access policy listing');
  proof.accessAppId=app.id;
  let credential,policy,tokenAttempted=false,policyAttempted=false;
  proof.cleanup={};
  try {
    tokenAttempted=!existingCredential;
    credential=existingCredential??await api('POST',`${base}/access/service_tokens`,{name,duration:'60m'});
    assert(credential?.id && credential.client_id && credential.client_secret,'Access credential response incomplete');
    proof.secretValues?.push(credential.client_id,credential.client_secret);
    proof.serviceTokenId=credential.id;proof.serviceTokenExpiresAt=credential.expires_at;
    policyAttempted=true;
    policy=await api('POST',policiesPath,{name,decision:'non_identity',precedence:Math.max(0,...existing.map(p=>p.precedence??0))+1,include:[{service_token:{token_id:credential.id}}],require:[],exclude:[]});
    assert(policy?.id,'Access policy response incomplete');proof.accessPolicyId=policy.id;
    const headers={'CF-Access-Client-Id':credential.client_id,'CF-Access-Client-Secret':credential.client_secret};
    return await check(headers);
  } finally {
    // Reconcile an interrupted create by its unique task name, never retry POST.
    for(const [kind,path,attempted,known] of [['policy',policiesPath,policyAttempted,policy],['serviceToken',`${base}/access/service_tokens`,tokenAttempted,credential]]) {
      if(!attempted)continue;
      try {
        let resource=known;
        if(!resource?.id){const found=(await api('GET',path)).filter(x=>x.name===name);assert(found.length<=1,'Ambiguous task-owned QA resource');resource=found[0];}
        if(resource?.id) {
          await api('DELETE',`${path}/${resource.id}`);
          const remaining=await api('GET',path);
          assert(!remaining.some(x=>x.id===resource.id),'QA resource remains after deletion');
        }
        proof.cleanup[kind]='removed';
      } catch {proof.cleanup[kind]='unconfirmed';}
    }
    if(Object.values(proof.cleanup).includes('unconfirmed'))throw Error('QA credential cleanup unconfirmed; reconcile the recorded resource name/IDs in Cloudflare Access');
  }
}

async function capturePages({accountId,origin,headers,proof,directory,runId,signal}) {
  const host=new URL(origin).host.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
    for(const [name,path,heading] of [['targets','/','Your targets'],['dashboard','/dashboard','Dashboard'],['settings','/settings','Prompts and models'],['findings','/dashboard?view=findings','Dashboard'],...(runId?[['chat',`/?run=${encodeURIComponent(runId)}`,'']]:[])]) {
      signal.throwIfAborted();proof.stage=`${name} at ${viewport.width}px`;
      const selector={targets:'.onboarding[aria-busy="false"]',dashboard:'.dashboard-scroll[aria-busy="false"]',settings:'.settings-page h1',findings:'.findings-workspace[aria-busy="false"]',chat:'.chat-shell[aria-busy="false"] .message-column'}[name];
      const result=await nativeSnapshot({accountId,body:{url:origin+path,formats:['content','accessibilityTree','screenshot'],viewport,screenshotOptions:{type:'png',fullPage:false},setExtraHTTPHeaders:headers,allowRequestPattern:[`^https://${host}(?:/|$)`,`^wss://${host}(?:/|$)`],gotoOptions:{waitUntil:'domcontentloaded',timeout:30_000},waitForSelector:{selector,visible:true,timeout:30_000}}});
      const content=result.content??'';
      assert(/<title[^>]*>[^<]*PentCloud/.test(content),'QA reached a login/error page instead of the application');
      assert(content.includes('id="root"'),'Expected application root is absent');
      const nodes=[];const visit=node=>{if(!node)return;nodes.push(node);for(const child of node.children??[])visit(child);};visit(result.accessibilityTree);
      if(heading)assert(nodes.some(n=>n.role==='heading'&&n.name===heading),`${name}: expected application heading is absent`);
      assert(!nodes.some(n=>/^Loading (?:control room|targets|runs|agent settings|target assessments)…$/.test(n.name??'')),`${name}: page is still loading`);
      const png=Buffer.from(result.screenshot??'','base64');
      assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a','Snapshot image was incomplete');
      assert.equal(png.readUInt32BE(16),viewport.width,'Unexpected screenshot width');
      assert.equal(png.readUInt32BE(20),viewport.height,'Unexpected screenshot height');
      const file=`${name}-${viewport.width}.png`;await writeFile(resolve(directory,file),png,{mode:0o600});
      proof.pages.push({name,path,viewport,screenshot:file,applicationIdentityVerified:true,navigationStatus:null,upstreamMetadata:'Not exposed by cf Quick Actions output; verified app content and exact-origin allowlist'});
    }
  }
}

export async function main(args=process.argv.slice(2)) {
  const {values}=parseArgs({args,options:{account:{type:'string'},origin:{type:'string'},output:{type:'string'},'run-id':{type:'string'},help:{type:'boolean'}}});
  if(values.help){console.log('Usage: npm run qa:ui -- --account ACCOUNT_ID --origin https://APP_HOST --output OUTSIDE_REPO [--run-id EXISTING_RUN]');return;}
  const accountId=values.account??process.env.CLOUDFLARE_ACCOUNT_ID;
  assert.match(accountId??'',/^[a-f0-9]{32}$/,'Select --account');
  const origin=qaOrigin(values.origin??'');
  assert(values.output,'Select an evidence --output directory outside the repository');
  if(values['run-id'])assert.match(values['run-id'],/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
  const directory=resolve(values.output),fromRepository=relative(fileURLToPath(new URL('../',import.meta.url)),directory);
  assert(fromRepository.startsWith('..'+sep)||isAbsolute(fromRepository),'QA evidence must stay outside the repository');
  await mkdir(directory,{recursive:true,mode:0o700});
  const proof={startedAt:new Date().toISOString(),result:'blocked',origin,mode:'Cloudflare Browser Run Quick Actions',authentication:'one-hour Access service token; task-owned policy; process memory only',modifiedConditions:['exact-origin request allowlist'],pages:[],blockedCoverage:['Interactive clicks/keyboard/scrolling','Console/network timeline','Streaming smoothness/performance traces'],newRuns:0};
  Object.defineProperty(proof,'secretValues',{value:[]});
  let auth;
  const controller=new AbortController();
  const onSignal=()=>controller.abort(Error('QA interrupted; cleaning up task-owned resources'));
  // SIGINT/SIGTERM stop between bounded captures, then normal cleanup runs.
  // A hard kill still leaves credentials bounded by Cloudflare expiry.
  process.once('SIGINT',onSignal);
  process.once('SIGTERM',onSignal);
  try {
    auth=await accountAuthorization({accountId,run:privateProcess,permissionNames:qaPermissions,purpose:'browser qa'});
    if(auth.id)proof.accountLeaseMetadata={id:auth.id,name:auth.name,expiresOn:auth.expiresOn};
    controller.signal.throwIfAborted();
    // Non-enumerable: this value can never enter the JSON evidence accidentally.
    proof.secretValues.push(auth.token);
    const api=cloudflareAPI(auth.token);
    await withQAAccess({api,accountId,origin,proof},async connection=>{
      await writeFile(resolve(directory,'report.json'),JSON.stringify(proof,null,2),{mode:0o600});
      await capturePages({...connection,accountId,proof,directory,runId:values['run-id'],signal:controller.signal});
    });
    proof.result='captured';
  } catch(error) {
    proof.result='failed';
    // Provider errors can embed credentials; only our controlled messages survive.
    proof.error=proof.secretValues.reduce((text,secret)=>text.split(secret).join('[redacted]'),String(error?.message??'QA failed')).replace(/cfast_[A-Za-z0-9]+/g,'[redacted]').replace(/([?&]jwt=)[^\s"'<>]+/g,'$1[redacted]').slice(0,500);
    process.exitCode=1;
  } finally {
    if(auth)try{await auth.close();proof.accountLease='released';}catch{proof.accountLease='revocation-unconfirmed';proof.result='failed';process.exitCode=1;}
    process.removeListener('SIGINT',onSignal);
    process.removeListener('SIGTERM',onSignal);
    proof.finishedAt=new Date().toISOString();
    await writeFile(resolve(directory,'report.json'),JSON.stringify(proof,null,2),{mode:0o600});
    console.log(JSON.stringify({result:proof.result,report:resolve(directory,'report.json'),pages:proof.pages.length,cleanup:proof.cleanup,error:proof.error}));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
