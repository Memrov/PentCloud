#!/usr/bin/env node
// Explicit cleanup of one run-owned, empty fresh fixture. The public customer
// CLI restores its native ownership ledger and decides whether deletion is safe.
import {mkdir,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {environment,client,validateAccount} from './artifacts.mjs';
import {captureCustomerProcess,invokeCustomerCli} from './install.mjs';
import {privateJson} from '../lib/private-install.mjs';
import {VERIFICATION_STAGES,PROBE_CHECKPOINTS} from '../lib/installation-verify.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const ensure=(condition,code)=>{if(!condition)throw Error(code);};
const stages=['environment','inputs','account','private-state','uninstall','cleanup','summary'];
const cliStages=['arguments','prerequisites','source','authorization','private-state','cleanup','images','setup','plan','install','upgrade','verification','release-receipt','doctor','uninstall','export','import-targets'];
let currentStage='environment';

export function fixtureCleanupCase(settings,env=process.env){
  const runId=env.PENTCLOUD_CLEANUP_RUN_ID,attemptId=env.PENTCLOUD_CLEANUP_ATTEMPT_ID;
  ensure(typeof runId==='string'&&/^[1-9][0-9]{0,19}$/.test(runId)&&typeof attemptId==='string'&&/^[1-9][0-9]{0,5}$/.test(attemptId),'CI_FIXTURE_INPUT_INVALID');
  ensure(typeof env.RUNNER_TEMP==='string'&&isAbsolute(env.RUNNER_TEMP),'CI_FIXTURE_PRIVATE_PATH');
  const instance='pc-fresh-'+runId+'-'+attemptId;ensure(instance.length<=38,'CI_FIXTURE_INPUT_INVALID');
  const directory=resolve(env.RUNNER_TEMP,'pentcloud-fixture-cleanup',instance);
  for(const [parent,child]of [[root,directory],[directory,root]]){
    const path=relative(parent,child);ensure(path==='..'||path.startsWith('..'+sep)||isAbsolute(path),'CI_FIXTURE_PRIVATE_PATH');
  }
  return {directory,configFile:join(directory,'config.json'),stateDirectory:join(directory,'state'),cacheDirectory:join(directory,'images'),
    config:{schemaVersion:2,accountId:settings.accountId,instance,accessTeamDomain:settings.team,allowedEmails:[...settings.emails],domain:{zoneId:settings.zoneId,hostname:instance+'.heflare.app'}}};
}
async function privateDirectory(path){
  let cursor=path;
  for(;;){
    try{ensure(!(await lstat(cursor)).isSymbolicLink(),'CI_FIXTURE_PRIVATE_PATH');}catch(error){if(error.code!=='ENOENT')throw error;}
    const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
  await mkdir(path,{recursive:true,mode:0o700});ensure((await lstat(path)).isDirectory(),'CI_FIXTURE_PRIVATE_PATH');
}
export function fixtureCleanupFailure(error,stage){
  const result={error:'CI_FIXTURE_CLEANUP_FAILED',stage:stages.includes(stage)?stage:'environment'},child=error?.customerFailure;
  if(child&&/^PC_[A-Z_]{2,70}$/.test(child.error??'')&&cliStages.includes(child.stage))result.customerFailure={error:child.error,stage:child.stage,
    ...(VERIFICATION_STAGES.includes(child.check)?{check:child.check}:{}),...(PROBE_CHECKPOINTS.includes(child.checkpoint)?{checkpoint:child.checkpoint}:{}),
    ...(Number.isInteger(child.httpStatus)&&child.httpStatus>=100&&child.httpStatus<=599?{httpStatus:child.httpStatus}:{}),
    ...(Array.isArray(child.providerCodes)&&child.providerCodes.length<=16&&child.providerCodes.every(code=>Number.isSafeInteger(code)&&code>=0&&code<=1_000_000_000)?{providerCodes:[...child.providerCodes]}:{})};
  return result;
}
export async function cleanupFixtureInstallation({env=process.env,api,invoke,stage=()=>{},output=value=>console.log(JSON.stringify(value))}={}){
  stage('environment');const settings=environment({...env,GITHUB_ACTIONS:'false'});
  stage('inputs');const installation=fixtureCleanupCase(settings,env);
  stage('account');await validateAccount(api??client(settings),settings);
  stage('private-state');
  for(const directory of [installation.directory,installation.stateDirectory,installation.cacheDirectory])await privateDirectory(directory);
  try{ensure(!(await lstat(installation.configFile)).isSymbolicLink(),'CI_FIXTURE_PRIVATE_PATH');}catch(error){if(error.code!=='ENOENT')throw error;}
  await privateJson(installation.configFile,installation.config);
  const command=invoke??((installation,command,extra=[])=>invokeCustomerCli({root,installation,command,extra,run:captureCustomerProcess}));
  let failure;
  try{
    stage('uninstall');const result=await command(installation,'uninstall',['--data','delete','--confirm',installation.config.instance]);
    ensure(result?.status==='removed'&&result.manifestRetained===true,'CI_FIXTURE_UNINSTALL_INCOMPLETE');
  }catch(error){failure=error;}
  finally{stage('cleanup');await command(installation,'cleanup');}
  if(failure){stage('uninstall');throw failure;}
  stage('summary');const result={status:'removed-owned-fresh-fixture',instance:installation.config.instance};output(result);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await cleanupFixtureInstallation({stage:value=>{currentStage=value;}}).catch(error=>{
  console.error(JSON.stringify(fixtureCleanupFailure(error,currentStage)));process.exitCode=1;
});
