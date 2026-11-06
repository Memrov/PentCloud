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

