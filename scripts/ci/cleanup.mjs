#!/usr/bin/env node
// This journal contains ownership metadata only. Credentials stay in process memory.
import {readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {privateJson,CloudflareApi} from '../lib/private-install.mjs';

const fail=code=>{throw Error(code);};
const ensure=(value,code)=>{if(!value)fail(code);};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
export function cleanupPath(env=process.env){ensure(typeof env.RUNNER_TEMP==='string'&&env.RUNNER_TEMP.length>0,'CI_CLEANUP_DIRECTORY_MISSING');return join(env.RUNNER_TEMP,'pentcloud-ci-cleanup.json');}
export function cleanupOwner(accountId,env=process.env){
  const owner={repository:env.GITHUB_REPOSITORY,accountId,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT};
  ensure(owner.repository==='Memrov/PentCloud'&&/^[a-f0-9]{32}$/.test(owner.accountId??'')&&/^\d{1,20}$/.test(owner.runId??'')&&/^\d{1,6}$/.test(owner.attempt??''),'CI_CLEANUP_OWNER_INVALID');
  return owner;
}
function validate(journal,expected=journal?.owner){
  ensure(journal?.schemaVersion===1&&Object.keys(journal).every(key=>['schemaVersion','owner','nonce','probe','domain','access'].includes(key)),'CI_CLEANUP_JOURNAL_INVALID');
  const owner=cleanupOwner(journal.owner?.accountId,{GITHUB_REPOSITORY:journal.owner?.repository,GITHUB_RUN_ID:journal.owner?.runId,GITHUB_RUN_ATTEMPT:journal.owner?.attempt});
  ensure(Object.keys(journal.owner).length===4&&Object.keys(owner).every(key=>owner[key]===expected?.[key]),'CI_CLEANUP_OWNER_MISMATCH');
  ensure(typeof journal.nonce==='string'&&/^[a-f0-9]{12}$/.test(journal.nonce),'CI_CLEANUP_JOURNAL_INVALID');
  const prefix=`pentcloud-ci-${owner.runId}-${owner.attempt}-${journal.nonce}`;
  ensure(journal.probe?.name===prefix+'-probe'&&journal.access?.name===prefix+'-access','CI_CLEANUP_NAME_MISMATCH');
  for(const [record,keys] of [[journal.probe,['name','attempted','removed']],[journal.access,['name','appId','tokenId','policyId','tokenAttempted','policyAttempted','tokenRemoved','policyRemoved']]]){
    ensure(Object.keys(record).every(key=>keys.includes(key)),'CI_CLEANUP_JOURNAL_INVALID');
    for(const [key,value] of Object.entries(record))if(key.endsWith('Id'))ensure(value===null||identifier(value),'CI_CLEANUP_JOURNAL_INVALID');else if(key!=='name')ensure(typeof value==='boolean','CI_CLEANUP_JOURNAL_INVALID');
  }
  const domain=journal.domain;
  ensure(domain&&Object.keys(domain).length===4&&Object.keys(domain).every(key=>['zoneId','id','attempted','removed'].includes(key)),'CI_CLEANUP_JOURNAL_INVALID');
  ensure((domain.zoneId===null||/^[a-f0-9]{32}$/.test(domain.zoneId??''))&&(domain.id===null||identifier(domain.id))&&typeof domain.attempted==='boolean'&&typeof domain.removed==='boolean','CI_CLEANUP_JOURNAL_INVALID');
  ensure((!domain.attempted||journal.probe.attempted&&domain.zoneId!==null)&&(!domain.id||domain.attempted)&&(!domain.removed||domain.attempted)&&(!journal.probe.removed||!domain.attempted||domain.removed),'CI_CLEANUP_JOURNAL_INVALID');
  ensure(journal.probe.name.length<=63,'CI_CLEANUP_NAME_INVALID');
  return journal;
}
export async function readCleanupJournal(path,owner){
  let raw;try{raw=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
  let journal;try{journal=JSON.parse(raw);}catch{fail('CI_CLEANUP_JOURNAL_INVALID');}
  return validate(journal,owner);
}
export async function saveCleanupJournal(path,journal){await privateJson(path,validate(journal));}
export async function createCleanupJournal(path,owner,nonce=randomBytes(6).toString('hex')){
  ensure(!await readCleanupJournal(path,owner),'CI_CLEANUP_PENDING');
  const prefix=`pentcloud-ci-${owner.runId}-${owner.attempt}-${nonce}`;
  const journal={schemaVersion:1,owner,nonce,probe:{name:prefix+'-probe',attempted:false,removed:false},domain:{zoneId:null,id:null,attempted:false,removed:false},access:{name:prefix+'-access',appId:null,tokenId:null,policyId:null,tokenAttempted:false,policyAttempted:false,tokenRemoved:false,policyRemoved:false}};
  await saveCleanupJournal(path,journal);return journal;
}
const base=journal=>'/accounts/'+journal.owner.accountId;
const inventory=(api,path)=>api.list?api.list(path):api.request(path);
export function probeHostname(journal){validate(journal);return journal.probe.name+'.heflare.app';}
async function probeDomains(api,journal){
  const rows=await inventory(api,`${base(journal)}/workers/domains`);
  ensure(Array.isArray(rows),'CI_PROBE_DOMAIN_LIST_INVALID');return rows;
}
function ownedProbeDomain(journal,rows){
  const hostname=probeHostname(journal),known=journal.domain.id,matches=rows.filter(value=>value.hostname===hostname),byId=known?rows.find(value=>value.id===known):undefined;
  ensure(matches.length<=1&&(!byId||byId.hostname===hostname)&&(!known||!matches.length||matches[0].id===known),'CI_PROBE_DOMAIN_OWNERSHIP_CHANGED');
  const domain=known?byId:matches[0];
  if(domain)ensure(identifier(domain.id)&&domain.service===journal.probe.name&&domain.zone_id===journal.domain.zoneId&&(domain.environment??'production')==='production','CI_PROBE_DOMAIN_OWNERSHIP_CHANGED');
  return domain;
}
export async function deployProbe({api,journal,persist,deploy,zoneId}){
  validate(journal);
  ensure(/^[a-f0-9]{32}$/.test(zoneId??''),'CI_PROBE_ZONE_INVALID');
  ensure(!journal.probe.attempted&&!journal.domain.attempted,'CI_PROBE_DEPLOY_PENDING');
  const zone=await api.request('/zones/'+zoneId);
  ensure(zone?.id===zoneId&&zone.name==='heflare.app'&&zone.status==='active'&&zone.account?.id===journal.owner.accountId,'CI_PROBE_ZONE_MISMATCH');
  const found=await api.request(`${base(journal)}/workers/scripts/${journal.probe.name}/settings`,{missing:true});
  ensure(found===null,'CI_PROBE_NAME_COLLISION');
  const hostname=probeHostname(journal);
  ensure(!(await probeDomains(api,journal)).some(value=>value.hostname===hostname),'CI_PROBE_DOMAIN_COLLISION');
  const dns=await api.request('/zones/'+zoneId+'/dns_records?name='+encodeURIComponent(hostname)+'&per_page=100',{envelope:true});
  ensure(Array.isArray(dns?.result)&&dns.result.length===0,'CI_PROBE_DNS_COLLISION');
  // The intent is durable before Wrangler can create anything, including on a lost response.
  journal.probe.attempted=true;journal.domain.zoneId=zoneId;journal.domain.attempted=true;
  await persist();await deploy();
  const domain=ownedProbeDomain(journal,await probeDomains(api,journal));
  ensure(domain,'CI_PROBE_DOMAIN_MISSING');journal.domain.id=domain.id;await persist();
}
async function removeProbeDomain({api,journal,persist}){
  if(!journal.domain.attempted||journal.domain.removed)return;
  const path=`${base(journal)}/workers/domains`;
  const domain=ownedProbeDomain(journal,await probeDomains(api,journal));
  if(domain){
    journal.domain.id=domain.id;await persist();
    const current=await api.request(path+'/'+domain.id,{missing:true});
    if(current){ensure(ownedProbeDomain(journal,[current]),'CI_PROBE_DOMAIN_OWNERSHIP_CHANGED');await api.request(path+'/'+domain.id,{method:'DELETE',missing:true});}
  }
  ensure(!ownedProbeDomain(journal,await probeDomains(api,journal)),'CI_PROBE_DOMAIN_CLEANUP_PENDING');
  journal.domain.removed=true;await persist();
}
async function removeAccess({api,journal,persist},kind){
  const token=kind==='token',access=journal.access;
  if(!access[kind+'Attempted']||access[kind+'Removed'])return;
  ensure(identifier(access.appId),'CI_ACCESS_APP_MISSING');
  const path=token?`${base(journal)}/access/service_tokens`:`${base(journal)}/access/apps/${access.appId}/policies`;
  const rows=await inventory(api,path);ensure(Array.isArray(rows),'CI_ACCESS_LIST_INVALID');
  const known=access[kind+'Id'],matches=rows.filter(value=>value.name===access.name),byId=known?rows.find(value=>value.id===known):undefined;
  ensure(matches.length<=1&&(!byId||byId.name===access.name)&&(!known||!matches.length||matches[0].id===known),'CI_ACCESS_OWNERSHIP_CHANGED');
  const resource=known?byId:matches[0];
  if(resource){
    ensure(identifier(resource.id),'CI_ACCESS_ID_INVALID');
    await api.request(path+'/'+resource.id,{method:'DELETE',missing:true});
    const remaining=await inventory(api,path);ensure(Array.isArray(remaining)&&!remaining.some(value=>value.id===resource.id||value.name===access.name),'CI_ACCESS_CLEANUP_PENDING');
  }
  access[kind+'Removed']=true;await persist();
}
export async function cleanupOwnedResources({api,journal,persist,includeProbe=true}){
  validate(journal);let pending=false;
  // Keep attempting independent cleanup even if a provider request loses its response.
  for(const kind of ['policy','token'])try{await removeAccess({api,journal,persist},kind);}catch{pending=true;}
  if(includeProbe&&journal.probe.attempted&&!journal.probe.removed)try{
    // A changed domain association blocks Worker deletion as well as domain deletion.
    await removeProbeDomain({api,journal,persist});
    const path=`${base(journal)}/workers/scripts/${journal.probe.name}`;
    await api.request(path,{method:'DELETE',missing:true});
    ensure(await api.request(path+'/settings',{missing:true})===null,'CI_PROBE_CLEANUP_PENDING');
    journal.probe.removed=true;await persist();
  }catch{pending=true;}
  ensure(!pending,'CI_CLEANUP_UNCONFIRMED');
}
export async function withCIProbeAccess({api,journal,persist,appId,origin},check){
  validate(journal);ensure(identifier(appId),'CI_ACCESS_APP_INVALID');
  const app=await api.request(`${base(journal)}/access/apps/${appId}`),url=new URL(origin);
  ensure(url.protocol==='https:'&&url.origin===origin&&app?.type==='self_hosted'&&app.domain===url.host,'CI_ACCESS_APP_MISMATCH');
  journal.access.appId=appId;await persist();
  const tokenPath=`${base(journal)}/access/service_tokens`,policyPath=`${base(journal)}/access/apps/${appId}/policies`;
  const tokens=await inventory(api,tokenPath),policies=await inventory(api,policyPath);
  ensure(Array.isArray(tokens)&&Array.isArray(policies)&&!tokens.some(value=>value.name===journal.access.name)&&!policies.some(value=>value.name===journal.access.name),'CI_ACCESS_NAME_COLLISION');
  try{
    journal.access.tokenAttempted=true;await persist();
    const credential=await api.request(tokenPath,{method:'POST',body:{name:journal.access.name,duration:'60m'}});
    ensure(identifier(credential?.id)&&typeof credential.client_id==='string'&&typeof credential.client_secret==='string','CI_ACCESS_TOKEN_INVALID');
    journal.access.tokenId=credential.id;await persist();
    journal.access.policyAttempted=true;await persist();
    const policy=await api.request(policyPath,{method:'POST',body:{name:journal.access.name,decision:'non_identity',precedence:Math.max(0,...policies.map(value=>Number.isSafeInteger(value.precedence)?value.precedence:0))+1,include:[{service_token:{token_id:credential.id}}],require:[],exclude:[]}});
    ensure(identifier(policy?.id),'CI_ACCESS_POLICY_INVALID');journal.access.policyId=policy.id;await persist();
    return await check({headers:{'CF-Access-Client-Id':credential.client_id,'CF-Access-Client-Secret':credential.client_secret}});
  }finally{await cleanupOwnedResources({api,journal,persist,includeProbe:false});}
}
export async function main(env=process.env){
  const path=cleanupPath(env);
  // An always() step can run before installation or npm ci has started.
  let raw;try{raw=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
  let accountId;try{accountId=env.PENTCLOUD_INSTALL_CONFIG?JSON.parse(env.PENTCLOUD_INSTALL_CONFIG).accountId:env.CLOUDFLARE_ACCOUNT_ID;}catch{fail('CI_CLEANUP_CONFIG_INVALID');}
  const owner=cleanupOwner(accountId,env),journal=validate(JSON.parse(raw),owner);
  ensure(env.CLOUDFLARE_API_TOKEN,'CI_CLEANUP_TOKEN_MISSING');
  const api=new CloudflareApi(env.CLOUDFLARE_API_TOKEN);
  await cleanupOwnedResources({api,journal,persist:()=>saveCleanupJournal(path,journal)});await rm(path);
  console.log(JSON.stringify({stage:'cleanup',status:'removed'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(()=>{console.error(JSON.stringify({stage:'cleanup',error:'CI_CLEANUP_FAILED'}));process.exitCode=1;});
