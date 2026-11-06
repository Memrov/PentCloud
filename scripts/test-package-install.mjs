import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PackageInstaller, packageProfile, PACK_CLASSES} from './lib/package-install.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config={schemaVersion:1,accountId:'a'.repeat(32),instance:'packages-test',accessTeamDomain:'https://fixture.cloudflareaccess.com',allowedEmails:['owner@example.com']};
const images=Object.fromEntries(['recon','http','nuclei','sqlmap','service','web-context','pcap','file-analysis','password','reference','metasploit'].map(p=>[p,'registry.cloudflare.com/'+config.accountId+'/packages-'+p+'@sha256:'+'b'.repeat(64)]));
const profile={domain:{zoneId:'c'.repeat(32),hostname:'install.example.com'},images};

test('package profile requires the complete immutable pack set in the selected account',()=>{
  assert.equal(Object.keys(packageProfile(config,profile).images).length,11);
  const missing={...images};delete missing.http;
  assert.throws(()=>packageProfile(config,{...profile,images:missing}),/eleven|complete/i);
  assert.throws(()=>packageProfile(config,{...profile,images:{...images,http:'docker.io/vxcontrol/kali-linux:latest'}}),/immutable|account/i);
  assert.throws(()=>packageProfile(config,{...profile,images:{...images,http:images.http.replace(config.accountId,'d'.repeat(32))}}),/account/i);
  assert.throws(()=>packageProfile(config,{...profile,domain:{...profile.domain,hostname:'https://wrong.example.com'}}),/hostname/i);
});

test('package deployment contains no Kali service, image, credential or public gateway',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pentcloud-pack-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const i=new PackageInstaller({config,profile,stateDirectory:dir,root,api:{},run:async()=>Buffer.alloc(0)});
  i.state={resources:{access:{aud:'fixture-aud'}},appUrl:'https://install.example.com'};
  const rendered=await i.render(true);
  assert.deepEqual(rendered.app.services,[{binding:'TOOL_PACKS',service:'packages-test-tools',entrypoint:'ToolPackGateway'}]);
  assert.equal(rendered.app.workers_dev,false);
  assert.deepEqual(rendered.app.routes,[{pattern:'install.example.com',custom_domain:true,zone_id:profile.domain.zoneId}]);
  assert.equal(rendered.gateway.workers_dev,false);
  assert.equal(rendered.gateway.containers.length,11);
  assert.deepEqual(new Set(rendered.gateway.containers.map(c=>c.class_name)),new Set(Object.values(PACK_CLASSES)));
  assert(!/kali|TOOLBOX|KALI_MCP_TOKEN/.test(JSON.stringify(rendered)));
  assert.equal(rendered.app.triggers.events[0].filter.namespace,'packages-test-work');
});

test('a failed durable checkpoint stops before a remote resource create',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pentcloud-pack-checkpoint-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let creates=0;
  const i=new PackageInstaller({config,profile,stateDirectory:dir,root,api:{},run:async()=>Buffer.alloc(0),checkpoint:async()=>{throw Error('checkpoint unavailable')}});
  i.state={resources:{}};
  await assert.rejects(i.owned('namespace',async()=>null,async()=>{creates++;return {id:'remote'}}),/checkpoint unavailable/);
  assert.equal(creates,0);
  assert.equal(JSON.parse(await readFile(join(dir,'manifest.json'),'utf8')).resources.namespace.status,'pending');
});

test('CI identity checks reject production hosts and other repositories',async()=>{
  const {environment,gitEnvironment}=await import('./ci/artifacts.mjs');
  const env={CLOUDFLARE_ACCOUNT_ID:config.accountId,PENTCLOUD_TEST_ZONE_ID:'c'.repeat(32),PENTCLOUD_TEST_HOSTNAME:'install.heflare.app',PENTCLOUD_TEST_ACCESS_TEAM:config.accessTeamDomain,PENTCLOUD_TEST_ALLOWED_EMAILS:JSON.stringify(config.allowedEmails),GITHUB_SHA:'e'.repeat(40),GITHUB_REF_NAME:'main',GITHUB_REPOSITORY:'Memrov/PentCloud',CLOUDFLARE_API_TOKEN:'fixture'};
  assert.equal(environment(env).hostname,'install.heflare.app');
  assert.throws(()=>environment({...env,PENTCLOUD_TEST_HOSTNAME:'app.pentcloud.dev'}),/testing hostname/);
  assert.throws(()=>environment({...env,GITHUB_REPOSITORY:'another/repository'}),/configured repository/);
  const git=gitEnvironment('https://'+config.accountId+'.artifacts.cloudflare.net/git/state/installation.git','test-repo-secret');
  assert.equal(git.GIT_TERMINAL_PROMPT,'0');
  assert.equal(git.GIT_CONFIG_VALUE_2,'false');
  assert(!('CLOUDFLARE_API_TOKEN' in git));
});

test('image provenance changes when a binary lock or build identity changes',async()=>{
  const {matchingLock,recipeIdentity,releaseDigest}=await import('./ci/image-manifest.mjs');
  const lock={packId:'http',baseImage:'example@sha256:'+ 'a'.repeat(64),tools:[{sha256:'b'.repeat(64)}]};
  matchingLock('http',lock,structuredClone(lock));
  assert.throws(()=>matchingLock('http',lock,{...lock,tools:[{sha256:'c'.repeat(64)}]}),/SDK lock/);
  const identity=recipeIdentity('http',lock,'d'.repeat(40),'v0.9.0');
  assert.equal(identity,recipeIdentity('http',{tools:lock.tools,baseImage:lock.baseImage,packId:'http'},'d'.repeat(40),'v0.9.0'));
  assert.notEqual(identity,recipeIdentity('http',lock,'e'.repeat(40),'v0.9.0'));
  assert.notEqual(identity,recipeIdentity('http',lock,'d'.repeat(40),'v0.10.0'));
  assert.throws(()=>releaseDigest({digest:'mutable:latest',platform:'linux/amd64',compressedBytes:100}),/immutable/);
});
