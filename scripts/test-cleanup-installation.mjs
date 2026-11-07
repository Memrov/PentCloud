import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const settings={accountId:'a'.repeat(32),zoneId:'b'.repeat(32),hostname:'install.heflare.app',team:'https://fixture.cloudflareaccess.com',emails:['private-owner@example.invalid']};
const environment=directory=>({RUNNER_TEMP:directory,GITHUB_SHA:'c'.repeat(40),GITHUB_REF_NAME:'fixture',GITHUB_REPOSITORY:'Memrov/PentCloud',
  PENTCLOUD_INSTALL_CONFIG:JSON.stringify(settings),CLOUDFLARE_API_TOKEN:'private-fixture-token',PENTCLOUD_CLEANUP_RUN_ID:'42322110165',PENTCLOUD_CLEANUP_ATTEMPT_ID:'1'});
async function implementation(){
  let value;await assert.doesNotReject(async()=>{value=await import('./ci/cleanup-installation.mjs');},'The explicit owned-fixture cleanup wrapper exists');return value;
}
const account=overrides=>({request:async(path,options)=>{
  assert.equal(path,'/zones/'+settings.zoneId);assert(!options?.method||options.method==='GET','Wrapper must not mutate Cloudflare resources directly');
  return {id:settings.zoneId,name:'heflare.app',status:'active',account:{id:settings.accountId},...overrides};
}});

test('cleanup derives only the exact selected fresh fixture and keeps secrets outside arguments',async()=>{
  const {fixtureCleanupCase}=await implementation();
  const value=fixtureCleanupCase(settings,environment('/tmp/fixture-cleanup-test'));
  assert.equal(value.config.instance,'pc-fresh-42322110165-1');
  assert.deepEqual(value.config.domain,{zoneId:settings.zoneId,hostname:'pc-fresh-42322110165-1.heflare.app'});
  assert.equal(value.config.schemaVersion,2);assert.equal(value.config.accessTeamDomain,settings.team);
  assert(!JSON.stringify(value).includes('private-fixture-token'));
  for(const [key,invalid]of [
    ['PENTCLOUD_CLEANUP_RUN_ID','../42322110165'],['PENTCLOUD_CLEANUP_RUN_ID','42322110165; echo secret'],
    ['PENTCLOUD_CLEANUP_RUN_ID','0'],['PENTCLOUD_CLEANUP_RUN_ID','9'.repeat(21)],
    ['PENTCLOUD_CLEANUP_ATTEMPT_ID','01'],['PENTCLOUD_CLEANUP_ATTEMPT_ID','1.heflare.app'],['PENTCLOUD_CLEANUP_ATTEMPT_ID','9'.repeat(7)],
  ])assert.throws(()=>fixtureCleanupCase(settings,{...environment('/tmp/fixture-cleanup-test'),[key]:invalid}),/CI_FIXTURE_INPUT_INVALID/);
});

test('cleanup writes a private schema-2 configuration and invokes only public uninstall then cleanup',async()=>{
  const {cleanupFixtureInstallation}=await implementation(),directory=await realpath(await mkdtemp(join(tmpdir(),'pentcloud-fixture-cleanup-'))),calls=[],output=[];
  try{
    const result=await cleanupFixtureInstallation({env:environment(directory),api:account(),output:value=>output.push(value),invoke:async(installation,command,extra=[])=>{
      calls.push({installation,command,extra});
      assert.equal((await stat(installation.configFile)).mode&0o777,0o600);
      assert.equal((await stat(installation.stateDirectory)).mode&0o777,0o700);
      assert.equal((await stat(installation.cacheDirectory)).mode&0o777,0o700);
      assert.deepEqual(JSON.parse(await readFile(installation.configFile,'utf8')),installation.config);
      return command==='uninstall'?{status:'removed',manifestRetained:true}:{status:'verification-resources-cleaned'};
    }});
    assert.deepEqual(calls.map(({command,extra})=>[command,...extra]),[['uninstall','--data','delete','--confirm','pc-fresh-42322110165-1'],['cleanup']]);
    assert.equal(result.status,'removed-owned-fresh-fixture');assert.equal(output.length,1);
    assert(!JSON.stringify(output).includes('private-owner'));assert(!JSON.stringify(output).includes('private-fixture-token'));
    assert(calls.every(({installation})=>installation.stateDirectory.startsWith(directory+'/')&&installation.cacheDirectory.startsWith(directory+'/')));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('public cleanup runs after a failed or blocked uninstall without attempting image preparation',async()=>{
  const {cleanupFixtureInstallation}=await implementation(),directory=await realpath(await mkdtemp(join(tmpdir(),'pentcloud-fixture-failure-'))),calls=[],stages=[];
  try{
    await assert.rejects(cleanupFixtureInstallation({env:environment(directory),api:account(),stage:value=>stages.push(value),output:()=>assert.fail('No success output'),invoke:async(_installation,command)=>{
      calls.push(command);if(command==='uninstall')throw Error('PRIVATE_PROVIDER_BODY');return {status:'verification-resources-cleaned'};
    }}));
    assert.deepEqual(calls,['uninstall','cleanup']);assert(stages.includes('cleanup'));assert.equal(stages.at(-1),'uninstall');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('cleanup refuses foreign repository, hostname, account and inactive-zone settings before invoking the CLI',async()=>{
  const {cleanupFixtureInstallation}=await implementation(),directory=await realpath(await mkdtemp(join(tmpdir(),'pentcloud-fixture-scope-')));
  try{
    for(const [env,api]of [
      [{...environment(directory),GITHUB_REPOSITORY:'foreign/repository'},account()],
      [{...environment(directory),PENTCLOUD_INSTALL_CONFIG:JSON.stringify({...settings,hostname:'app.pentcloud.dev'})},account()],
      [environment(directory),account({account:{id:'d'.repeat(32)}})],
      [environment(directory),account({status:'pending'})],
      [environment(directory),account({name:'production.example'})],
    ])await assert.rejects(cleanupFixtureInstallation({env,api,invoke:()=>assert.fail('No CLI action outside the exact testing scope'),output:()=>assert.fail('No success output')}));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('wrapper failure output contains fixed stages and codes without assertion or provider text',async()=>{
  await implementation();
  const env={...environment('/tmp/fixture-not-used'),PENTCLOUD_CLEANUP_RUN_ID:'PRIVATE_PERSON@example.invalid'};
  const child=spawnSync(process.execPath,[join(root,'scripts/ci/cleanup-installation.mjs')],{env:{PATH:process.env.PATH,...env},encoding:'utf8'});
  assert.equal(child.status,1);assert.equal(child.stdout,'');
  const result=JSON.parse(child.stderr);assert.equal(result.error,'CI_FIXTURE_CLEANUP_FAILED');assert.equal(result.stage,'inputs');
  assert(!child.stderr.includes('PRIVATE_PERSON'));assert(!child.stderr.includes('private-owner'));assert(!child.stderr.includes('private-fixture-token'));assert(!child.stderr.includes('AssertionError'));
});
