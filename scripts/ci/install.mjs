#!/usr/bin/env node
// Infrastructure, full verification and cleanup go through the public CLI.
// This adapter additionally owns synthetic data retained across CI upgrades.
import {mkdir,writeFile,appendFile,rm,lstat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {spawn} from 'node:child_process';
import {hash,privateJson,readJson} from '../lib/private-install.mjs';
import {privateProcess} from '../lib/private-process.mjs';
import {withArtifactGit} from '../lib/artifact-state.mjs';
import {REGCTL_VERSION} from '../lib/private-image.mjs';
import {recipeIdentity} from './image-manifest.mjs';
import {environment,client,validateAccount,waitRepo} from './artifacts.mjs';
import {withInstallationAccess,waitForAccessReady,VERIFICATION_STAGES,PROBE_CHECKPOINTS,sanitizeBrowserDiagnostics} from '../lib/installation-verify.mjs';
export {waitForProbeReady,waitForAccessReady,waitForWorkflowProof} from '../lib/installation-verify.mjs';

const PACKS=['http','recon','nuclei','service','sqlmap','web-context','file-analysis','password','pcap','reference','metasploit'];
const fixtureTarget={id:'customer-upgrade-target',kind:'website',name:'Customer upgrade preservation fixture',url:'https://customer.heflare.app/',objective:'Synthetic retained upgrade data. No scanning or model invocation.',exclusions:'No network checks or executions.'};
const fixtureRepo='customer-upgrade-proof',fixtureDescription='PentCloud retained customer upgrade fixture v1',fixtureContent='PentCloud retained customer evidence v1\n';
let stage='environment';
const ensure=(condition,code)=>{if(!condition)throw Error(code);};
const same=(a,b,code)=>ensure(isDeepStrictEqual(a,b),code);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const cliStages=['arguments','prerequisites','source','authorization','private-state','cleanup','images','setup','plan','install','upgrade','verification','release-receipt','doctor','uninstall','export','import-targets'];
function safeCustomerFailure(text){
  let value;try{value=JSON.parse(text);}catch{return;}
  if(!value||!/^PC_[A-Z_]{2,70}$/.test(value.error??'')||!cliStages.includes(value.stage))return;
  const browserDiagnostics=value.error==='PC_INSTALLATION_VERIFICATION'&&value.check==='native-browser'?sanitizeBrowserDiagnostics(value.browserDiagnostics):undefined;
  return {error:value.error,stage:value.stage,
    ...(VERIFICATION_STAGES.includes(value.check)?{check:value.check}:{}),
    ...(PROBE_CHECKPOINTS.includes(value.checkpoint)?{checkpoint:value.checkpoint}:{}),
    ...(browserDiagnostics?{browserDiagnostics}:{}),
    ...(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?{httpStatus:value.httpStatus}:{}),
    ...(Array.isArray(value.providerCodes)&&value.providerCodes.length<=16&&value.providerCodes.every(code=>Number.isSafeInteger(code)&&code>=0&&code<=1_000_000_000)?{providerCodes:[...value.providerCodes]}:{})};
}
export function captureCustomerProcess(command,args,options={}){
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,env:{...(options.env??process.env),CI:'true',CF_SEND_TELEMETRY:'false',NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
    const stdout=[],stderr=[];let outBytes=0,errBytes=0,overflow=false;
    const timer=setTimeout(()=>child.kill('SIGTERM'),options.timeout??105*60*1000);
    child.stdout.on('data',chunk=>{outBytes+=chunk.length;if(outBytes<=64*1024*1024)stdout.push(chunk);else{overflow=true;child.kill('SIGTERM');}});
    child.stderr.on('data',chunk=>{errBytes+=chunk.length;if(errBytes<=64*1024)stderr.push(chunk);else{overflow=true;child.kill('SIGTERM');}});
    child.on('error',()=>{clearTimeout(timer);reject(Error('CI_CUSTOMER_COMMAND_FAILED'));});
    child.on('close',code=>{
      clearTimeout(timer);if(code===0&&!overflow)return resolvePromise(Buffer.concat(stdout));
      const error=Error('CI_CUSTOMER_COMMAND_FAILED'),failure=!overflow&&safeCustomerFailure(Buffer.concat(stderr).toString());
      if(failure)error.customerFailure=failure;reject(error);
    });
  });
}

export function customerCases(e,env=process.env){
  ensure(/^\d{1,20}$/.test(env.GITHUB_RUN_ID??'')&&/^\d{1,6}$/.test(env.GITHUB_RUN_ATTEMPT??''),'CI_CUSTOMER_RUN_ID_INVALID');
  ensure(typeof env.RUNNER_TEMP==='string'&&env.RUNNER_TEMP,'CI_CUSTOMER_DIRECTORY_MISSING');
  const directory=resolve(env.RUNNER_TEMP,'pentcloud-customer-ci');
  const make=(label,instance,hostname)=>({config:{schemaVersion:2,accountId:e.accountId,instance,accessTeamDomain:e.team,allowedEmails:[...e.emails],domain:{zoneId:e.zoneId,hostname}},
    configFile:join(directory,label+'.json'),stateDirectory:join(directory,label+'-state'),cacheDirectory:join(directory,label+'-images')});
  const instance='pc-fresh-'+env.GITHUB_RUN_ID+'-'+env.GITHUB_RUN_ATTEMPT;ensure(instance.length<=38,'CI_CUSTOMER_INSTANCE_INVALID');
  return {directory,fresh:make('fresh',instance,instance+'.heflare.app'),retained:make('retained','pentcloud-customer','customer.heflare.app')};
}

export function customerRebuildMode(env=process.env){
  const value=env.PENTCLOUD_CI_REBUILD_IMAGES??'0';
  ensure(value==='0'||value==='1','CI_CUSTOMER_REBUILD_MODE_INVALID');
  return value==='1';
}
export async function seedCustomerImageCaches({cases,migrated,retainedExists,rebuildFresh}){
  ensure(typeof rebuildFresh==='boolean','CI_CUSTOMER_REBUILD_MODE_INVALID');
  if(!migrated)return;
  const installations=[...(!rebuildFresh?[cases.fresh]:[]),...(!retainedExists?[cases.retained]:[])];
  for(const installation of installations){
    await mkdir(installation.cacheDirectory,{recursive:true,mode:0o700});
    await privateJson(join(installation.cacheDirectory,'image-ledger.json'),migrated);
  }
}

export async function invokeCustomerCli({root,installation,command,extra=[],run=captureCustomerProcess}){
  ensure(['install','upgrade','doctor','cleanup','uninstall'].includes(command),'CI_CUSTOMER_COMMAND_INVALID');
  const args=[join(root,'scripts/pentcloud.mjs'),command,'--config',installation.configFile,'--state',installation.stateDirectory,'--images-cache',installation.cacheDirectory,'--apply','--headless',...extra];
  let output;try{output=await run(process.execPath,args,{cwd:root,timeout:105*60*1000});}catch(cause){
    const error=Error('CI_CUSTOMER_COMMAND_FAILED'),failure=safeCustomerFailure(JSON.stringify(cause?.customerFailure??null));
    if(failure)error.customerFailure=failure;throw error;
  }
  try{const value=JSON.parse(output.toString());ensure(value&&typeof value==='object'&&!Array.isArray(value),'invalid');return value;}
  catch{throw Error('CI_CUSTOMER_RESULT_INVALID');}
}

export function migrateCIImageLedger({owner,expectedOwner,records,pins,locks}){
  same(owner,expectedOwner,'CI_IMAGE_OWNER_MISMATCH');
  ensure(owner?.schemaVersion===1&&owner.repository==='Memrov/PentCloud'&&owner.hostname==='install.heflare.app'&&/^[a-f0-9]{32}$/.test(owner.accountId??''),'CI_IMAGE_OWNER_INVALID');
  ensure(records?.schemaVersion===1&&records.recipes&&pins?.schemaVersion===1&&pins.repository==='Memrov/PentCloud-tools'&&sha(pins.commit),'CI_IMAGE_LEDGER_INVALID');
  same(pins.packs.map(pack=>pack.id).toSorted(),PACKS.toSorted(),'CI_IMAGE_PACK_SET_INVALID');
  const recipes={};
  for(const pack of PACKS){
    ensure(locks[pack]&&typeof locks[pack]==='object','CI_IMAGE_LOCK_MISSING');
    const identity=recipeIdentity(pack,locks[pack],pins.commit,REGCTL_VERSION),record=records.recipes[identity];
    ensure(record?.status==='ready'&&record.pack===pack&&record.sourceCommit===pins.commit&&record.recipeIdentity===identity,'CI_IMAGE_READY_SET_REQUIRED');
    ensure(/^sha256:[a-f0-9]{64}$/.test(record.digest??'')&&Number.isSafeInteger(record.compressedBytes)&&record.compressedBytes>0,'CI_IMAGE_RECORD_INVALID');
    recipes[identity]={status:'ready',pack,sourceCommit:pins.commit,recipeIdentity:identity,digest:record.digest,compressedBytes:record.compressedBytes,image:`registry.cloudflare.com/${owner.accountId}/pentcloud-ci-${pack}@${record.digest}`};
  }
  return {schemaVersion:2,accountId:owner.accountId,recipes};
}

function verified(result,sourceCommit){ensure(result?.status==='verified-package-installation'&&result.sourceCommit===sourceCommit&&result.ownerVerified===false&&result.toolPacks===11&&result.noKali===true&&result.modelCalls===0,'CI_CUSTOMER_VERIFICATION_INVALID');}
export function assertCustomerPreserved(before,after,sourceCommit){
  same(after.identity,before.identity,'CI_CUSTOMER_IDENTITY_CHANGED');same(after.target,before.target,'CI_CUSTOMER_TARGET_CHANGED');same(after.evidence,before.evidence,'CI_CUSTOMER_EVIDENCE_CHANGED');
  ensure(sha(before.release?.sourceCommit)&&before.runtime?.sourceCommit===before.release.sourceCommit&&before.runtime.versionId===before.release.deployments?.app?.versionId,'CI_CUSTOMER_BASELINE_PROVENANCE_INVALID');
  ensure(after.release?.sourceCommit===sourceCommit&&after.runtime?.sourceCommit===sourceCommit&&after.runtime.versionId===after.release.deployments?.app?.versionId,'CI_CUSTOMER_CANDIDATE_PROVENANCE_INVALID');
}
export async function proveCustomerLifecycle({cases,sourceCommit,retainedExists,invoke,snapshot,seed}){
  try{
    stage='fresh-install';verified(await invoke(cases.fresh,'install'),sourceCommit);
    stage='fresh-doctor';await invoke(cases.fresh,'doctor');
    stage='fresh-empty-uninstall';ensure((await invoke(cases.fresh,'uninstall',['--data','delete','--confirm',cases.fresh.config.instance])).status==='removed','CI_CUSTOMER_EMPTY_TEARDOWN_FAILED');
    stage='retained-baseline';if(retainedExists)await invoke(cases.retained,'doctor');
    else{verified(await invoke(cases.retained,'install'),sourceCommit);stage='retained-seed';await seed(cases.retained);}
    stage='retained-snapshot';const before=await snapshot(cases.retained);
    stage='retained-upgrade';verified(await invoke(cases.retained,'upgrade'),sourceCommit);
    stage='retained-preservation';const after=await snapshot(cases.retained);assertCustomerPreserved(before,after,sourceCommit);
    return {status:'passed',sourceCommit,baselineSourceCommit:before.release.sourceCommit,upgradeProof:before.release.sourceCommit===sourceCommit?'same-source-baseline':'baseline-to-candidate',
      fresh:'installed-verified-removed',retained:'data-and-identities-preserved',ownerVerified:false,modelCalls:0,...(after.release.bundle?{bundleSha256:hash(JSON.stringify(after.release.bundle))}:{})};
  }finally{
    const failedStage=stage;let failed=false;
    for(const installation of [cases.fresh,cases.retained]){stage='cleanup';try{await invoke(installation,'cleanup');}catch{failed=true;}}
    stage=failedStage;ensure(!failed,'CI_CUSTOMER_CLEANUP_FAILED');
  }
}

async function oldImageCache({api,e,root,directory,run}){
  const namespace='pentcloud-ci-state',repo='installation',base='/accounts/'+e.accountId+'/artifacts/namespaces/'+namespace;
  if(!await api.request(base+'/repos/'+repo,{missing:true}))return null;
  const scratch=join(directory,'legacy-image-read');
  try{return await withArtifactGit({api,accountId:e.accountId,namespace,repo,scope:'read',run},async(git,remote)=>{
    await git(['clone','--no-checkout','--single-branch','--branch','main','--no-hardlinks','--',remote,scratch]);
    const names=(await git(['-C',scratch,'ls-tree','--name-only','-z','HEAD'])).toString().split('\0').filter(Boolean);ensure(names.includes('owner.json'),'CI_IMAGE_OWNER_MISSING');
    const owner=JSON.parse((await git(['-C',scratch,'show','HEAD:owner.json'])).toString()),expectedOwner={schemaVersion:1,repository:'Memrov/PentCloud',accountId:e.accountId,zoneId:e.zoneId,hostname:e.hostname};
    same(owner,expectedOwner,'CI_IMAGE_OWNER_MISMATCH');if(!names.includes('images.json'))return null;
    const records=JSON.parse((await git(['-C',scratch,'show','HEAD:images.json'])).toString()),pins=await readJson(join(root,'ci/tool-pack-images.json')),locks={};
    for(const pack of PACKS)locks[pack]=await readJson(join(root,'node_modules/@memrov2/pentcloud-'+pack+'/tools.lock.json'));
    // Unseen pinned recipes are built by the public CLI, without adopting tags.
    if(!PACKS.every(pack=>records.recipes?.[recipeIdentity(pack,locks[pack],pins.commit,REGCTL_VERSION)]?.status==='ready'))return null;
    return migrateCIImageLedger({owner,expectedOwner,records,pins,locks});
  });}finally{await rm(scratch,{recursive:true,force:true});}
}

async function installedView(installation,api){
  const state=await readJson(join(installation.stateDirectory,'manifest.json'));
  ensure(state?.packageProfile&&typeof state.installationId==='string'&&state.installationId,'CI_CUSTOMER_MANIFEST_INVALID');
  for(const key of ['accountId','instance','accessTeamDomain'])same(state.config?.[key],installation.config[key],'CI_CUSTOMER_MANIFEST_OWNER_CHANGED');
  same(state.packageProfile.domain,installation.config.domain,'CI_CUSTOMER_DOMAIN_CHANGED');
  const names={app:installation.config.instance+'-app',gateway:installation.config.instance+'-tools',namespace:installation.config.instance+'-work',workflow:installation.config.instance+'-results',access:installation.config.instance+'-operators'};
  same(state.names,names,'CI_CUSTOMER_RESOURCE_NAMES_CHANGED');ensure(state.appUrl==='https://'+installation.config.domain.hostname,'CI_CUSTOMER_ORIGIN_CHANGED');
  for(const key of ['app','gateway','namespace','domain','access',...PACKS.map(pack=>'pack-'+pack)])ensure(state.resources?.[key]?.status==='ready'&&typeof state.resources[key].id==='string'&&state.resources[key].id,'CI_CUSTOMER_RESOURCE_RECEIPT_MISSING');
  return {api,config:state.config,state,names,profile:state.packageProfile};
}
const proofOwner=installation=>({schemaVersion:1,accountId:installation.config.accountId,instance:installation.config.instance,hostname:installation.config.domain.hostname,targetId:fixtureTarget.id});
async function artifactFixture({installation,api,run,create=false}){
  const accountId=installation.config.accountId,namespace=installation.config.instance+'-work',base='/accounts/'+accountId+'/artifacts/namespaces/'+namespace,path=base+'/repos/'+fixtureRepo;
  let repo=await api.request(path,{missing:true});
  if(create){ensure(!repo,'CI_CUSTOMER_EVIDENCE_COLLISION');repo=await api.request(base+'/repos',{method:'POST',body:{name:fixtureRepo,description:fixtureDescription,default_branch:'main'}});ensure(repo?.id&&repo.name===fixtureRepo,'CI_CUSTOMER_EVIDENCE_CREATE_INVALID');await waitRepo(api,path);}
  ensure(repo?.id&&repo.name===fixtureRepo&&repo.description===fixtureDescription,'CI_CUSTOMER_EVIDENCE_MISSING');
  const scratch=join(installation.stateDirectory,'retained-evidence-git');
  try{return await withArtifactGit({api,accountId,namespace,repo:fixtureRepo,scope:create?'write':'read',run},async(git,remote)=>{
    if(create){
      await mkdir(scratch,{recursive:true,mode:0o700});await git(['init','--initial-branch=main',scratch]);await privateJson(join(scratch,'owner.json'),proofOwner(installation));await writeFile(join(scratch,'evidence.txt'),fixtureContent,{mode:0o600});
      await git(['-C',scratch,'add','owner.json','evidence.txt']);await git(['-C',scratch,'-c','user.name=PentCloud customer CI','-c','user.email=customer-ci@pentcloud.invalid','-c','commit.gpgsign=false','commit','-m','Retained customer upgrade fixture']);await git(['-C',scratch,'push',remote,'HEAD:refs/heads/main']);
    }else await git(['clone','--no-checkout','--single-branch','--branch','main','--no-hardlinks','--',remote,scratch]);
    const commit=(await git(['-C',scratch,'rev-parse','HEAD'])).toString().trim();ensure(sha(commit),'CI_CUSTOMER_EVIDENCE_COMMIT_INVALID');
    same(JSON.parse((await git(['-C',scratch,'show','HEAD:owner.json'])).toString()),proofOwner(installation),'CI_CUSTOMER_EVIDENCE_OWNER_CHANGED');
    const content=(await git(['-C',scratch,'show','HEAD:evidence.txt'])).toString();same(content,fixtureContent,'CI_CUSTOMER_EVIDENCE_BYTES_CHANGED');return {id:repo.id,commit,content};
  });}finally{await rm(scratch,{recursive:true,force:true});}
}
async function withCustomerData(installation,api,callback){
  const installer=await installedView(installation,api);
  return withInstallationAccess({installer,temporaryDirectory:join(installation.stateDirectory,'verification')},async({headers})=>{
    const get=async path=>{const response=await waitForAccessReady({origin:installer.state.appUrl,headers,path});return response.json();};return callback({installer,get,headers});
  });
}
async function seedCustomer(installation,api,run){
  await withCustomerData(installation,api,async({installer,get,headers})=>{
    const snapshot=await get('/v1/onboarding');ensure(Array.isArray(snapshot.targets)&&snapshot.targets.length===0,'CI_CUSTOMER_SEED_REQUIRES_EMPTY_LIBRARY');
    const response=await fetch(installer.state.appUrl+'/v1/onboarding/target.save',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(fixtureTarget),redirect:'manual',signal:AbortSignal.timeout(30000)});
    ensure(response.status===200,'CI_CUSTOMER_TARGET_SEED_FAILED');const target=await response.json();for(const [key,value]of Object.entries(fixtureTarget))same(target[key],value,'CI_CUSTOMER_TARGET_SEED_INVALID');
  });await artifactFixture({installation,api,run,create:true});
}
async function snapshotCustomer(installation,api,run){
  const {installer,target,runtime}=await withCustomerData(installation,api,async({installer,get})=>{
    const value=await get('/v1/onboarding');ensure(Array.isArray(value.targets),'CI_CUSTOMER_TARGETS_INVALID');const target=value.targets.find(target=>target.id===fixtureTarget.id);ensure(target,'CI_CUSTOMER_TARGET_MISSING');
    for(const [key,expected]of Object.entries(fixtureTarget))same(target[key],expected,'CI_CUSTOMER_TARGET_CHANGED');return {installer,target,runtime:await get('/v1/installation')};
  });
  const release=await readJson(join(installation.stateDirectory,'installation-release.json'));
  ensure(release?.schemaVersion===1&&release.installerSchema===2&&sha(release.sourceCommit)&&release.ownerVerified===false,'CI_CUSTOMER_RELEASE_INVALID');verified({...release.verification,sourceCommit:release.sourceCommit,ownerVerified:release.ownerVerified},release.sourceCommit);
  ensure(release.bundle?.schemaVersion===1&&/^[a-f0-9]{64}$/.test(release.bundle.configSha256??'')&&Array.isArray(release.bundle.modules)&&release.bundle.modules.length>0,'CI_CUSTOMER_BUNDLE_PROOF_MISSING');
  same(installer.state.deployedRelease,{sourceCommit:release.sourceCommit,installerSchema:2,deployments:release.deployments},'CI_CUSTOMER_RELEASE_RECEIPT_CHANGED');same(release.images,installer.profile.images,'CI_CUSTOMER_RELEASE_IMAGES_CHANGED');
  const settings=await api.request('/accounts/'+installation.config.accountId+'/workers/scripts/'+installer.names.app+'/settings');ensure(Array.isArray(settings.bindings),'CI_CUSTOMER_BINDINGS_INVALID');
  const bindings=settings.bindings.filter(binding=>binding.type==='durable_object_namespace');ensure(bindings.some(binding=>binding.name==='COORDINATOR')&&bindings.every(binding=>typeof binding.namespace_id==='string'&&binding.namespace_id),'CI_CUSTOMER_DO_IDENTITY_MISSING');
  const identity={installationId:installer.state.installationId,names:installer.names,resources:Object.fromEntries(Object.entries(installer.state.resources).map(([key,value])=>[key,{id:value.id,...(value.namespaceId?{namespaceId:value.namespaceId}:{}),...(value.aud?{aud:value.aud}:{})}])),durableObjects:Object.fromEntries(bindings.map(binding=>[binding.name,binding.namespace_id]))};
  return {identity,target,runtime,release,evidence:await artifactFixture({installation,api,run})};
}

export async function main({env=process.env,run=privateProcess,runCli=captureCustomerProcess}={}){
  const rebuildFresh=customerRebuildMode(env);
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),journalPath=env.RUNNER_TEMP&&join(resolve(env.RUNNER_TEMP,'pentcloud-customer-ci'),'cleanup.json');
  if(process.argv.includes('--cleanup-only')&&(!journalPath||!await readJson(journalPath,null)))return;
  // Preserve existing scope guards without emitting account/email mask commands.
  const e=environment({...env,GITHUB_ACTIONS:'false'}),api=client(e),cases=customerCases(e,env),owner={repository:'Memrov/PentCloud',accountId:e.accountId,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT};
  const journal={schemaVersion:1,owner,entries:[cases.fresh,cases.retained].map(({configFile,stateDirectory,cacheDirectory})=>({configFile,stateDirectory,cacheDirectory}))};
  const invoke=(installation,command,extra)=>invokeCustomerCli({root,installation,command,extra,run:runCli});
  if(process.argv.includes('--cleanup-only')){
    same(await readJson(journalPath),journal,'CI_CUSTOMER_CLEANUP_OWNER_MISMATCH');let failed=false;
    for(const installation of [cases.fresh,cases.retained]){same(await readJson(installation.configFile),installation.config,'CI_CUSTOMER_CLEANUP_CONFIG_CHANGED');try{await invoke(installation,'cleanup');}catch{failed=true;}}
    ensure(!failed,'CI_CUSTOMER_CLEANUP_FAILED');return;
  }
  stage='account';await validateAccount(api,e);await mkdir(cases.directory,{recursive:true,mode:0o700});ensure(!(await lstat(cases.directory)).isSymbolicLink(),'CI_CUSTOMER_DIRECTORY_UNSAFE');
  for(const installation of [cases.fresh,cases.retained])await privateJson(installation.configFile,installation.config);await privateJson(journalPath,journal);
  stage='retained-discovery';const retainedExists=Boolean(await api.request('/accounts/'+e.accountId+'/artifacts/namespaces/'+cases.retained.config.instance+'-setup/repos/installation',{missing:true}));
  stage='image-cache-migration';const migrated=!rebuildFresh||!retainedExists?await oldImageCache({api,e,root,directory:cases.directory,run}):null;
  await seedCustomerImageCaches({cases,migrated,retainedExists,rebuildFresh});
  const result=await proveCustomerLifecycle({cases,sourceCommit:e.sha,retainedExists,invoke,seed:installation=>seedCustomer(installation,api,run),snapshot:installation=>snapshotCustomer(installation,api,run)});
  stage='summary';if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,'## Customer install and upgrade\n\nFresh public CLI install, native services and empty teardown passed. Retained target, Artifacts evidence and resource identities survived the candidate upgrade.\n\nSource: `'+result.sourceCommit+'`. Baseline: `'+result.baselineSourceCommit+'` ('+result.upgradeProof+'). Bundle proof: `'+result.bundleSha256+'`.\n\nHeadless service authentication verified; human owner login was not tested. Kali installs and model calls: zero. Private state and provider/account logs are not uploaded.\n');
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(error=>{
  const failure=safeCustomerFailure(JSON.stringify(error?.customerFailure??null));
  console.error(JSON.stringify({stage,error:'CI_INSTALL_FAILED',...(failure?{customerFailure:failure}:{})}));process.exitCode=1;
});
