import assert from 'node:assert/strict';
import {mkdir,lstat,realpath,open,rm} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {CloudflareApi,Installer,configuration,plan,privateJson,readJson,withStateLock} from './private-install.mjs';
import {accountAuthorization} from './native-auth.mjs';
import {customerConfiguration,packageBaseConfiguration,customerPlan,installationBackend} from './customer-config.mjs';
import {collectCustomerSetup} from './customer-setup.mjs';
import {parseCustomerArguments} from './customer-cli-options.mjs';
import {createDeploymentRunner} from './deployment-runner.mjs';
import {preparePackageImages,checkPackageBuildPrerequisites} from './package-images.mjs';
import {PackageInstaller} from './package-install.mjs';
import {openArtifactState} from './artifact-state.mjs';
import {verifyPackageInstallation,cleanupInstallationVerification,withInstallationAccess,waitForAccessReady,VERIFICATION_STAGES,PROBE_CHECKPOINTS} from './installation-verify.mjs';

export const customerHelp=`PentCloud customer installer
Usage: npm run pentcloud -- setup
       npm run pentcloud -- COMMAND --config FILE --state DIRECTORY [OPTIONS]
Commands: setup, plan, install, upgrade, doctor, cleanup, export, import-targets, uninstall
New installs use all 11 tool packages in your Cloudflare account.
Prerequisites: Node 26.12.1 (26.x), Go 1.26.5, Python 3.11, Git, Bash, libarchive/bsdtar;
run npm ci in this source checkout. Interactive setup uses official cf and cloudflared.
Options: --apply authorizes changes; --headless uses an explicit private config and state;
--images-cache DIRECTORY; doctor --full; export --output FILE; import-targets --input FILE;
uninstall --data retain|delete --confirm INSTANCE.
Configuration, ownership receipts and caches belong outside Git. Native Artifacts mirrors
installation receipts for recovery; official Cloudflare clients own their login sessions.
Full verification starts the eleven packages, makes one HTTP tool request to your own
verification host, tests native services, then retires its temporary runtimes. No model inference.
Interactive installs also verify your owner login. Headless CI verifies service access only.
Existing legacy installations retain their backend; new installs never import Kali.
Never put credentials in command arguments or configuration.`;

function within(parent,path){const r=relative(parent,path);return !r||!r.startsWith('..')&&!isAbsolute(r);}
export async function customerPrerequisites({root,run,environment=process.env}){
  const [major,minor,patch]=process.versions.node.split('.').map(Number);
  assert(major===26&&(minor>12||minor===12&&patch>=1),'PC_NODE_VERSION');
  try{assert((await lstat(join(root,'node_modules/wrangler/bin/wrangler.js'))).isFile(),'PC_DEPENDENCIES');}catch{throw Error('PC_DEPENDENCIES');}
  return checkPackageBuildPrerequisites(run,environment);
}
async function privatePath(path,root){
  path=resolve(path);let cursor=path;
  for(;;){try{const s=await lstat(cursor);assert(!s.isSymbolicLink(),'PC_PRIVATE_PATH_SYMLINK');}catch(e){if(e.code!=='ENOENT')throw e;}const p=dirname(cursor);if(p===cursor)break;cursor=p;}
  let ancestor=path;for(;;){try{const canonical=await realpath(ancestor);assert(canonical===ancestor,'PC_PRIVATE_PATH_SYMLINK');break;}catch(e){if(e.code!=='ENOENT')throw e;ancestor=dirname(ancestor);}}
  assert(!within(root,path)&&!within(path,root),'PC_PRIVATE_PATH');return path;
}
export async function withImageCacheLock(directory,callback,owner){
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=join(directory,'operation.lock');let lock;
  try{lock=await open(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('PC_IMAGE_CACHE_LOCKED');throw e;}
  try{
    if(owner){
      const path=join(directory,'installation-owner.json'),prior=await readJson(path,null);
      if(prior)assert.deepEqual(prior,owner,'PC_IMAGE_CACHE_OWNER');else await privateJson(path,owner);
    }
    return await callback();
  }finally{await lock.close();await rm(file);}
}
export function publicInstallationResult(result){
  const keys=['status','appUrl','sourceCommit','toolPacks','noKali','modelCalls','ownerVerified','manifestRetained','nextStep'];
  return Object.fromEntries(keys.filter(k=>Object.hasOwn(result??{},k)).map(k=>[k,result[k]]));
}
export function installationCommand(command,prior){
  const live=prior?.steps?.installed||prior?.resources?.domain?.status==='ready';
  return command==='setup'?live?'upgrade':'install':command==='install'&&live?'upgrade':command;
}
export function customerFailure(error,stage){
  const code=typeof error?.code==='string'?error.code:typeof error?.message==='string'?error.message:'';
  const help={PC_NODE_VERSION:'Use Node 26.12.1 or later 26.x.',PC_DEPENDENCIES:'Run npm ci in the source checkout.',PC_GIT_REQUIRED:'Install Git and make it available in PATH.',PC_GO_REQUIRED:'Install Go 1.26.5; set GO_BIN to its executable if needed.',PC_GO_VERSION:'Use Go 1.26.5; set GO_BIN to its executable if needed.',PC_PYTHON_REQUIRED:'Install Python 3.11 or later 3.x as python3.',PC_PYTHON_VERSION:'Use Python 3.11 or later 3.x as python3.',PC_ARCHIVE_READER:'Install libarchive/bsdtar with 7z support and make it available in PATH.',PC_SOURCE_DIRTY:'Use a clean committed source checkout before installation or upgrade.',PC_IMAGE_CACHE_OWNER:'Choose a separate image cache for each installation.'}[code];
  return {error:/^PC_[A-Z_]{2,70}$/.test(code)?code:'PC_INSTALLATION_FAILED',stage,
    ...(Number.isInteger(error?.httpStatus)&&error.httpStatus>=400&&error.httpStatus<=599?{httpStatus:error.httpStatus}:Number.isInteger(error?.probeStatus)&&error.probeStatus>=100&&error.probeStatus<=599?{httpStatus:error.probeStatus}:{}),
    ...(code==='PC_CLOUDFLARE_API'&&Array.isArray(error.providerCodes)?{providerCodes:error.providerCodes.filter(Number.isSafeInteger)}:{}),
    ...(code==='PC_INSTALLATION_VERIFICATION'&&VERIFICATION_STAGES.includes(error.verificationStage)?{check:error.verificationStage}:{}),
    ...(code==='PC_INSTALLATION_VERIFICATION'&&PROBE_CHECKPOINTS.includes(error.probeCheckpoint)?{checkpoint:error.probeCheckpoint}:{}),
    help:help??'Retain private configuration and state. Reconcile interrupted operations before retrying; use doctor or cleanup for an existing installation.'};
}
async function sourceIdentity(run,changing){
  const settings={env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}};
  const args=['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null'];
  const sha=(await run('git',[...args,'rev-parse','HEAD'],settings)).toString().trim();assert.match(sha,/^[a-f0-9]{40}$/,'PC_SOURCE_COMMIT');
  if(changing)assert(!(await run('git',[...args,'status','--porcelain','--untracked-files=normal'],settings)).toString().trim(),'PC_SOURCE_DIRTY');
  return sha;
}
async function applicationAccess(installer,{headless,temporaryDirectory},callback){
  if(!headless)return callback();
  return withInstallationAccess({installer,temporaryDirectory},async({headers})=>{
    const original=installer.probe.bind(installer);
    installer.probe=async(path,authenticated=false,options={})=>{
      if(!authenticated)return original(path,false,options);
      const url=new URL(path,installer.state.appUrl);
      assert(path.startsWith('/v1/')&&url.origin===installer.state.appUrl&&!url.hash,'PC_APP_REQUEST');
      if(!options.method||options.method==='GET')return waitForAccessReady({origin:installer.state.appUrl,headers,path});
      // Prime only a read. Mutation requests are issued once; explicit operation
      // IDs make a later operator retry safe after uncertain replies.
      await waitForAccessReady({origin:installer.state.appUrl,headers,path:'/v1/installation'});
      return fetch(url,{...options,headers:{...headers,...options.headers},redirect:'manual',signal:AbortSignal.timeout(30000)});
    };
    try{return await callback();}finally{installer.probe=original;}
  });
}
async function lifecycle(installer,path,body){
  const response=await installer.probe(path,true,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,200,'PC_UPGRADE_NOT_READY');return response.json();
}
export async function uninstallCustomerInstallation({installer,options,headless,temporaryDirectory}){
  const remove=()=>installer.uninstall(options);
  // A recorded destructive teardown has already acquired its atomic fence.
  // Its resume must work after the application or Access app has been removed.
  if(options.data==='retain'||installer.state.removed||installer.state.packageUninstall)return remove();
  return applicationAccess(installer,{headless,temporaryDirectory},remove);
}
export async function upgradePackageInstallation({installer,sourceCommit,headless,temporaryDirectory}){
  await installer.load({updateEmail:true});
  const previous=installer.state.upgradeOperation;
  const operation={operationId:previous?.operationId??randomUUID(),sourceCommit,
    ...(previous&&previous.sourceCommit!==sourceCommit?{previousSourceCommit:previous.sourceCommit}:previous?.previousSourceCommit?{previousSourceCommit:previous.previousSourceCommit}:{})};
  installer.state.upgradeOperation=operation;await installer.save();
  await applicationAccess(installer,{headless,temporaryDirectory},async()=>{
    const result=await lifecycle(installer,'/v1/lifecycle/prepare-upgrade',operation);
    assert(result.maintenance===true||result.completed===true,'PC_UPGRADE_FENCE');
  });
  await installer.install({upgrade:true,verify:false});
  await applicationAccess(installer,{headless,temporaryDirectory},async()=>{
    const deadline=Date.now()+120000;
    for(;;){
      const response=await installer.probe('/v1/installation',true);assert.equal(response.status,200,'PC_RELEASE_PROVENANCE');
      if((await response.json()).sourceCommit===sourceCommit)break;
      assert(Date.now()<deadline,'PC_RELEASE_PROPAGATION');await new Promise(r=>setTimeout(r,2000));
    }
    const result=await lifecycle(installer,'/v1/lifecycle/finish-upgrade',{operationId:operation.operationId,sourceCommit});
    assert(result.maintenance===false&&result.completed===true,'PC_UPGRADE_FENCE');
  });
  delete installer.state.upgradeOperation;await installer.save();
}
async function releaseReceipt(installer,sourceCommit,verification,ownerVerified){
  const deployments={};
  for(const key of ['app','gateway']){
    const response=await installer.api.request(installer.base+'/workers/scripts/'+installer.names[key]+'/deployments');
    const latest=response.deployments?.toSorted((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];
    assert(latest?.id&&latest.versions?.length===1&&latest.versions[0].percentage===100&&latest.versions[0].version_id,'PC_RELEASE_DEPLOYMENT');
    deployments[key]={deploymentId:latest.id,versionId:latest.versions[0].version_id};
  }
  const bundle=await readJson(join(installer.directory,'app-build.worker-build.json'));
  // This receipt stays private; raw API metadata and account logs are excluded.
  const receipt={schemaVersion:1,installerSchema:2,sourceCommit,images:installer.profile.images,deployments,bundle,verification,ownerVerified};
  await privateJson(join(installer.directory,'installation-release.json'),receipt);
  installer.state.deployedRelease={sourceCommit,installerSchema:2,deployments};await installer.save();
  return receipt;
}
export async function runCustomerCli({root,args=process.argv.slice(2),environment=process.env,output=value=>console.log(JSON.stringify(value,null,2)),text=value=>console.log(value),stage=value=>{}}){
  const parsed=parseCustomerArguments(args);if(!parsed){text(customerHelp);return;}
  let {command,options}=parsed;const run=createDeploymentRunner({root,environment});let prompts;
  const interactive=()=>{assert(!options['--headless']&&!environment.GITHUB_ACTIONS&&!environment.CI&&process.stdin.isTTY,'PC_INTERACTIVE_REQUIRED');return prompts??=createInterface({input:process.stdin,output:process.stdout});};
  try{
    let raw,configPath=options['--config']&&await privatePath(options['--config'],root);
    if(command==='setup'&&!configPath){
      stage('prerequisites');await customerPrerequisites({root,run,environment});
      const ask=async(label,value)=>interactive().question(label+(value?' ['+value+']':'')+': ');
      raw=await collectCustomerSetup({run,ask,choose:async(label,choices)=>{
        text(label);choices.forEach((c,n)=>text(String(n+1)+'. '+c.label));const n=Number(await ask('Choose a number'));assert(Number.isInteger(n)&&choices[n-1],'PC_SELECTION');return choices[n-1].value;
      },login:()=>run('cf',['auth','login'],{timeout:300000}),environment});
      configPath=await privatePath(join(homedir(),'.local/share/pentcloud',raw.instance+'.json'),root);
      assert(!await readJson(configPath,null),'PC_CONFIG_EXISTS');
    }else raw=await readJson(configPath);
    const localPrior=options['--state']?await readJson(join(resolve(options['--state']),'manifest.json'),null):null;
    const backend=installationBackend(raw,localPrior,command);
    const customer=backend==='packages'?customerConfiguration(raw):null,config=customer?packageBaseConfiguration(customer):configuration(raw);
    if(command==='plan'){output(customer?customerPlan(customer):plan(config));return;}
    const directory=await privatePath(options['--state']??join(dirname(configPath),config.instance),root);
    const cache=await privatePath(options['--images-cache']??directory+'-images',root),ledger=await privatePath(directory+'-artifacts',root);
    assert(!within(directory,configPath)&&!within(directory,cache)&&!within(cache,directory),'PC_PRIVATE_PATH');
    if(command==='cleanup'&&!await readJson(join(directory,'verification/owned-verification.json'),null)){
      const result={status:'verification-resources-cleaned'};output(result);return result;
    }
    if(command==='setup'){
      if(!options['--headless'])output(customerPlan(customer));
      if(!options['--apply'])assert((await interactive().question('Apply this installation plan? [y/N]: ')).trim().toLowerCase()==='y','PC_SETUP_CANCELLED');
      if(!await readJson(configPath,null)){await mkdir(dirname(configPath),{recursive:true,mode:0o700});await privateJson(configPath,raw);}
    }
    const changing=['setup','install','upgrade'].includes(command);
    if(changing&&customer){stage('prerequisites');await customerPrerequisites({root,run,environment});}
    stage('source');const sourceCommit=await sourceIdentity(run,changing);
    stage('authorization');
    const additionalPermissions=[...(customer?['Access: Service Tokens Write','Browser Run Write','Workers AI Write']:[]),...(changing&&customer?.accessBootstrap?['Access: Organizations, Identity Providers, and Groups Write']:[]),...(config.email?.agentmail?['Secrets Store Write']:[])];
    const authorization=await accountAuthorization({accountId:config.accountId,run,environment,legacy:backend==='legacy',additionalPermissions,domainZoneId:customer?.domain.zoneId,zoneId:config.email?.cloudflare?.zoneId});
    const deploymentEnvironment={...environment,CLOUDFLARE_API_TOKEN:authorization.token,CLOUDFLARE_ACCOUNT_ID:config.accountId};
    const deploymentRun=(kind,args,settings={})=>run(kind,args,{...settings,env:settings.env??deploymentEnvironment});
    const api=new CloudflareApi(authorization.token,fetch,{zoneIds:[...new Set([customer?.domain.zoneId,config.email?.cloudflare?.zoneId].filter(Boolean))]});
    try{return await withStateLock(directory,async()=>{
      if(!customer){
        assert(command!=='setup','PC_LEGACY_SETUP');
        const installer=new Installer({config,stateDirectory:directory,root,api,run:deploymentRun,environment:deploymentEnvironment,importImage:async()=>{throw Error('PC_NO_NEW_LEGACY_IMAGES');}});
        const result=command==='install'||command==='upgrade'?await installer.install({upgrade:command==='upgrade'}):command==='doctor'?await installer.doctor():command==='uninstall'?await installer.uninstall({data:options['--data'],confirm:options['--confirm']}):command==='export'?await installer.exportInstallation(resolve(options['--output'])):command==='import-targets'?await installer.importTargets(resolve(options['--input'])):(()=>{throw Error('PC_LEGACY_COMMAND');})();
        output(publicInstallationResult(result));return result;
      }
      if(command==='cleanup'){
        stage('cleanup');await cleanupInstallationVerification({api,temporaryDirectory:join(directory,'verification'),accountId:config.accountId,instance:config.instance});
        const result={status:'verification-resources-cleaned'};output(result);return result;
      }
      return withImageCacheLock(cache,async()=>{
      if(!changing)assert(await api.request('/accounts/'+config.accountId+'/artifacts/namespaces/'+config.instance+'-setup',{missing:true}),'PC_STATE_NOT_FOUND');
      stage('private-state');const store=await openArtifactState({api,config,domain:customer.domain,stateDirectory:directory,cacheDirectory:cache,ledgerDirectory:ledger,run:deploymentRun});
      try{
        let prior=await readJson(join(directory,'manifest.json'),null);installationBackend(raw,prior,command);
        const temporaryDirectory=join(directory,'verification');
        stage('cleanup');await cleanupInstallationVerification({api,temporaryDirectory,accountId:config.accountId,instance:config.instance});
        // Repeating the installation command on a live application is an
        // upgrade and must acquire the same durable admission fence.
        command=installationCommand(command,prior);
        stage('images');const images=changing?await preparePackageImages({root,config,directory:cache,api,run:deploymentRun,environment:deploymentEnvironment,checkpoint:()=>store.checkpoint()}):prior?.packageProfile?.images;
        const installer=new PackageInstaller({config,profile:{domain:customer.domain,images},sourceCommit,accessBootstrap:customer.accessBootstrap,stateDirectory:directory,root,api,run:deploymentRun,environment:deploymentEnvironment,checkpoint:()=>store.checkpoint()});
        stage(command);let result;
        if(command==='install'||command==='upgrade'){
          if(command==='upgrade')await upgradePackageInstallation({installer,sourceCommit,headless:options['--headless'],temporaryDirectory});
          else await installer.install({verify:false});
          stage('verification');const verification=await verifyPackageInstallation({installer,root,run:deploymentRun,temporaryDirectory,sourceCommit});
          let ownerVerified=false;if(!options['--headless']){await installer.doctor({authenticate:true});ownerVerified=true;}
          stage('release-receipt');await releaseReceipt(installer,sourceCommit,verification,ownerVerified);
          result={...verification,appUrl:installer.state.appUrl,sourceCommit,ownerVerified};
        }else{
          await installer.load();
          if(command==='doctor'){
            result=options['--full']?await verifyPackageInstallation({installer,root,run:deploymentRun,temporaryDirectory,sourceCommit:installer.state.deployedRelease?.sourceCommit??sourceCommit}):await installer.doctor({authenticate:!options['--headless']});
            if(options['--full']&&!options['--headless'])await installer.doctor({authenticate:true});
            result={...result,sourceCommit:installer.state.deployedRelease?.sourceCommit??null,ownerVerified:!options['--headless']};
          }
          else if(command==='uninstall')result=await uninstallCustomerInstallation({installer,options:{data:options['--data'],confirm:options['--confirm']},headless:options['--headless'],temporaryDirectory});
          else result=await applicationAccess(installer,{headless:options['--headless'],temporaryDirectory},()=>command==='export'?installer.exportInstallation(resolve(options['--output'])):installer.importTargets(resolve(options['--input'])));
        }
        output(publicInstallationResult(result));return result;
      }finally{await store.close();}
      },{accountId:config.accountId,instance:config.instance});
    });}finally{await authorization.close();}
  }finally{prompts?.close();}
}
