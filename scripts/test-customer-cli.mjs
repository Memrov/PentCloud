import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {parseCustomerArguments} from './lib/customer-cli-options.mjs';
import {missingOrganizationFooter} from './lib/deployment-runner.mjs';
import {upgradePackageInstallation,publicInstallationResult,customerFailure,withImageCacheLock,installationCommand,uninstallCustomerInstallation} from './lib/customer-cli.mjs';
import {mkdtemp,rm,readdir,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test('guided setup is the default, while headless changes require explicit configuration and consent',()=>{
 assert.deepEqual(parseCustomerArguments([]),{command:'setup',options:{}});
 assert.equal(parseCustomerArguments(['--help']),null);
 for(const args of [['setup','--headless'],['install','--config','x','--state','y'],['upgrade','--config','x','--state','y','--headless'],['doctor','--config','x','--state','y','--full'],['uninstall','--config','x','--state','y','--apply']])assert.throws(()=>parseCustomerArguments(args));
 const args=parseCustomerArguments(['setup','--config','private.json','--state','private-state','--apply','--headless']);assert.equal(args.command,'setup');assert(args.options['--headless']);
 assert.equal(parseCustomerArguments(['doctor','--config','x','--state','y']).command,'doctor');
});
const source='a'.repeat(40),oldSource='b'.repeat(40);
test('repeating install on an exposed application always takes the fenced upgrade path',()=>{
 for(const prior of [{steps:{installed:true}},{resources:{domain:{status:'ready'}}}])for(const command of ['install','setup','upgrade'])assert.equal(installationCommand(command,prior),'upgrade');
 assert.equal(installationCommand('install',{resources:{app:{status:'ready'}}}),'install');
 assert.equal(installationCommand('setup',null),'install');assert.equal(installationCommand('doctor',{steps:{installed:true}}),'doctor');
});
function upgradeFixture({failDeploy=false,wrongRelease=false,finishFail=false,pending}={}){
 const calls=[],state={savedTargets:[{id:'preserve'}],...(pending?{upgradeOperation:pending}:{})};
 const installer={state,load:async()=>calls.push('load'),save:async()=>calls.push('save'),install:async options=>{calls.push(['deploy',options]);if(failDeploy)throw Error('provider SECRET_MARKER');},probe:async(path,auth,options)=>{
  calls.push(path);assert(auth);const body=options&&JSON.parse(options.body);
  if(path.endsWith('prepare-upgrade'))return Response.json({maintenance:true,maintenanceOperation:body});
  if(path.endsWith('finish-upgrade'))return Response.json({maintenance:false,completed:true},{status:finishFail?409:200});
  return Response.json({sourceCommit:wrongRelease?null:source},{status:wrongRelease?503:200});
 }};return {installer,calls,state};
}
test('upgrade fences before deployment and verifies exact release before reopening work',async()=>{
 const {installer,calls,state}=upgradeFixture();await upgradePackageInstallation({installer,sourceCommit:source,headless:false});
 assert(calls.indexOf('/v1/lifecycle/prepare-upgrade')<calls.findIndex(c=>Array.isArray(c)&&c[0]==='deploy'));
 assert(calls.indexOf('/v1/installation')<calls.indexOf('/v1/lifecycle/finish-upgrade'));
 assert.deepEqual(state.savedTargets,[{id:'preserve'}]);assert(!state.upgradeOperation);
});
test('uncertain deployment, mismatched runtime and failed finish preserve the upgrade recovery receipt',async()=>{
 for(const settings of [{failDeploy:true},{wrongRelease:true},{finishFail:true}]){
  const {installer,state}=upgradeFixture(settings);await assert.rejects(upgradePackageInstallation({installer,sourceCommit:source,headless:false}));
  assert.equal(state.upgradeOperation.sourceCommit,source);assert(state.upgradeOperation.operationId);assert.deepEqual(state.savedTargets,[{id:'preserve'}]);
 }
});
test('an explicit candidate retry retargets the same maintenance operation with its previous source',async()=>{
 const {installer,calls}=upgradeFixture({pending:{operationId:'existing-op',sourceCommit:oldSource}});let prepared;
 const probe=installer.probe;installer.probe=async(path,auth,options)=>{if(path.endsWith('prepare-upgrade'))prepared=JSON.parse(options.body);return probe(path,auth,options);};
 await upgradePackageInstallation({installer,sourceCommit:source,headless:false});
 assert.deepEqual(prepared,{operationId:'existing-op',sourceCommit:source,previousSourceCommit:oldSource});assert(calls.includes('/v1/lifecycle/finish-upgrade'));
});
test('public output and failures exclude private metadata and assertion/provider text',()=>{
 assert.deepEqual(publicInstallationResult({status:'ok',sourceCommit:source,resources:{secret:'SECRET_MARKER'},config:{},checks:['private']}),{status:'ok',sourceCommit:source});
 assert.equal(customerFailure(Error('SECRET_MARKER'),'verification').error,'PC_INSTALLATION_FAILED');
 assert.equal(customerFailure(Error('PC_SOURCE_DIRTY'),'source').error,'PC_SOURCE_DIRTY');
 const diagnostic=customerFailure(Object.assign(Error('private provider body'),{code:'PC_INSTALLATION_VERIFICATION',verificationStage:'native-browser',probeCheckpoint:'browser-navigate',probeStatus:302}),'verification');
 assert.equal(diagnostic.check,'native-browser');assert.equal(diagnostic.checkpoint,'browser-navigate');assert.equal(diagnostic.httpStatus,302);assert(!JSON.stringify(diagnostic).includes('private provider body'));
 const invalid=customerFailure(Object.assign(Error('private'),{code:'PC_INSTALLATION_VERIFICATION',verificationStage:'SECRET_MARKER',probeCheckpoint:'SECRET_MARKER',probeStatus:999}),'verification');assert(!JSON.stringify(invalid).includes('SECRET_MARKER'));assert(!invalid.httpStatus);
 const browser=customerFailure(Object.assign(Error('private'),{code:'PC_INSTALLATION_VERIFICATION',verificationStage:'native-browser',browserDiagnostics:{hasRoot:true,runtimeErrors:{TypeError:1,SECRET_MARKER:1},url:'SECRET_MARKER',html:'SECRET_MARKER',rootChildCount:99}}),'verification');
 assert.deepEqual(browser.browserDiagnostics,{hasRoot:true,runtimeErrors:{TypeError:1}});assert(!JSON.stringify(browser).includes('SECRET_MARKER'));
});
test('teardown resume and repeated removal do not need the already removed app or Access application',async()=>{
 for(const state of [{removed:true},{packageUninstall:{authorized:true}}]){
  let calls=0;const installer={state,uninstall:async options=>{calls++;assert.deepEqual(options,{data:'delete',confirm:'owned-install'});return {status:'removed'};}};
  const result=await uninstallCustomerInstallation({installer,options:{data:'delete',confirm:'owned-install'},headless:true});assert.equal(result.status,'removed');assert.equal(calls,1);
 }
});
test('shared image caches have one writer and release their lock on failure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pc-image-lock-'));
 try{await assert.rejects(withImageCacheLock(directory,async()=>{await assert.rejects(withImageCacheLock(directory,async()=>{}),/PC_IMAGE_CACHE_LOCKED/);throw Error('failed');}),/failed/);assert.deepEqual(await readdir(directory),[]);}finally{await rm(directory,{recursive:true,force:true});}
});
test('always cleanup without a journal needs no authentication or remote setup',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'pc-cleanup-empty-')));
 try{
  const config=join(base,'config.json');await writeFile(config,JSON.stringify({schemaVersion:2,accountId:'a'.repeat(32),instance:'empty-cleanup',accessTeamDomain:'https://fixture.cloudflareaccess.com',allowedEmails:['owner@example.invalid'],domain:{zoneId:'b'.repeat(32),hostname:'install.example.invalid'}}));
  const child=spawnSync(process.execPath,[join(import.meta.dirname,'pentcloud.mjs'),'cleanup','--config',config,'--state',join(base,'state'),'--headless','--apply'],{env:{PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{status:'verification-resources-cleaned'});assert.deepEqual(await readdir(base),['config.json']);
 }finally{await rm(base,{recursive:true,force:true});}
});
test('CLI rejects duplicated, secret-bearing and unknown options',()=>{
 for(const args of [['install','--token','private'],['plan','--config','x','--config','y'],['setup','--unknown'],['plan','--config']])assert.throws(()=>parseCustomerArguments(args));
});
test('only the exact final cf organization HTTP404 footer can classify missing setup',()=>{
 const account='a'.repeat(32),footer=`│ 404 Not Found · HTTP /accounts/${account}/access/organizations\n└\n`;
 assert(missingOrganizationFooter('\n┌ APIError\n│ body\n'+footer,account));
 assert(!missingOrganizationFooter(footer+'│ 403 Forbidden · HTTP /accounts/'+account+'/access/organizations\n└\n',account));
 assert(!missingOrganizationFooter(footer,'b'.repeat(32)));assert(!missingOrganizationFooter('provider says404',account));
});
test('public CLI help documents the package flow and invalid private config never reaches stderr',()=>{
 const root=join(import.meta.dirname,'..');
 const help=spawnSync(process.execPath,[join(root,'scripts/pentcloud.mjs'),'--help'],{encoding:'utf8'});
 assert.equal(help.status,0);assert.match(help.stdout,/setup/);assert.match(help.stdout,/eleven|11/);
 const invalid=spawnSync(process.execPath,[join(root,'scripts/pentcloud.mjs'),'--private-SECRET_MARKER'],{encoding:'utf8'});
 assert.equal(invalid.status,1);assert(!(invalid.stdout+invalid.stderr).includes('SECRET_MARKER'));
});
