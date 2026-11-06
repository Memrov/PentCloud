#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,chmod,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateProcess} from '../lib/private-process.mjs';
import {REGCTL_VERSION,REGCTL_HASHES} from '../lib/private-image.mjs';
import {privateJson,readJson} from '../lib/private-install.mjs';
import {matchingLock,recipeIdentity,releaseDigest} from './image-manifest.mjs';
import {environment,client,validateAccount,stateLedger} from './artifacts.mjs';

async function main(){
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),e=environment(),api=client(e);
await validateAccount(api,e);
const ledger=join(process.env.RUNNER_TEMP,'pentcloud-image-ledger'),imageState=join(process.env.RUNNER_TEMP,'pentcloud-image-state');
const checkpoint=await stateLedger(api,e,ledger,imageState);
const records=await readJson(join(ledger,'images.json'),{schemaVersion:1,recipes:{}});
assert(records.schemaVersion===1&&records.recipes,'Unsupported private image ledger');
const saveImages=async()=>{await privateJson(join(ledger,'images.json'),records);await checkpoint();};
await saveImages();
const tools=resolve(process.env.PENTCLOUD_TOOLS_DIRECTORY);
const pins=JSON.parse(await readFile(join(root,'ci/tool-pack-images.json'),'utf8'));
assert.equal(pins.repository,'Memrov/PentCloud-tools');
const head=(await privateProcess('git',['-C',tools,'rev-parse','HEAD'])).toString().trim();
assert.equal(head,pins.commit,'Tool source commit differs from the reviewed image recipe');
const scratch=await mkdtemp(join(process.env.RUNNER_TEMP,'pentcloud-pack-images-'));
await chmod(scratch,0o700);
const key='linux-amd64',bin=join(scratch,'regctl'),digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const response=await fetch('https://github.com/regclient/regclient/releases/download/'+REGCTL_VERSION+'/regctl-'+key,{signal:AbortSignal.timeout(120000)});
assert(response.ok,'Cannot fetch pinned OCI image client');
const bytes=Buffer.from(await response.arrayBuffer());
assert.equal(digest(bytes),'sha256:'+REGCTL_HASHES[key],'OCI client checksum mismatch');
await writeFile(bin,bytes,{mode:0o700});
const selector=join(scratch,'account.json');
await privateJson(selector,{name:'pentcloud-ci-images',account_id:e.accountId,compatibility_date:'2026-11-06'});
const safe=['PATH','HOME','TMPDIR','LANG','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR'];
const imageEnv={...Object.fromEntries(safe.filter(k=>process.env[k]).map(k=>[k,process.env[k]])),REGCTL:bin,REGCTL_CONFIG:join(scratch,'regctl.json'),DOCKER_CONFIG:scratch};
const reg=(args,timeout=180000)=>privateProcess(bin,args,{env:imageEnv,cwd:tools,timeout});
const images={};
try{
  for(const pack of pins.packs){
    assert.match(pack.id,/^[a-z-]+$/);
    const lock=JSON.parse(await readFile(pack.id==='recon'?join(tools,'tools.lock.json'):join(tools,'packages',pack.id,'tools.lock.json'),'utf8'));
    const sdk=JSON.parse(await readFile(join(root,'node_modules/@memrov2/pentcloud-'+pack.id+'/tools.lock.json'),'utf8'));
    matchingLock(pack.id,lock,sdk);
    const identity=recipeIdentity(pack.id,lock,pins.commit,REGCTL_VERSION);
    const record=records.recipes[identity];
    const repo='registry.cloudflare.com/'+e.accountId+'/pentcloud-ci-'+pack.id;
    let imageDigest=record?.status==='ready'?record.digest:null;
    let reference=imageDigest?repo+'@'+imageDigest:null;
    console.log('Checking pinned tool-pack '+pack.id+'.');
    const credential=JSON.parse((await privateProcess(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),'containers','registries','credentials','registry.cloudflare.com','--push','--pull','--expiration-minutes','60','--json','--config',selector])).toString());
    assert.equal(credential.registry_host,'registry.cloudflare.com');
    assert(credential.username&&credential.password,'Registry credential missing');
    await privateJson(join(scratch,'config.json'),{auths:{'registry.cloudflare.com':{auth:Buffer.from(credential.username+':'+credential.password).toString('base64')}}});
    let existing;
    if(reference)existing=await reg(['manifest','get',reference,'--format','raw-body']);
    if(existing)assert.equal(digest(existing),imageDigest,'Existing pack manifest changed');
    else{
      records.recipes[identity]={status:'pending',pack:pack.id,sourceCommit:pins.commit,recipeIdentity:identity};await saveImages();
      console.log(JSON.stringify({stage:'build-tool-pack',pack:pack.id}));
      const build=pack.id==='recon'?[join(tools,'scripts/build-image.mjs')]:[join(tools,'scripts/build-pack.mjs'),pack.id];
      await privateProcess(process.execPath,build,{cwd:tools,env:imageEnv,timeout:3600000});
      const releaseFile=pack.id==='recon'?join(tools,'.cache/image-release.json'):join(tools,'.cache/packs',pack.id,'image-release.json');
      const release=JSON.parse(await readFile(releaseFile,'utf8'));
      imageDigest=releaseDigest(release);reference=repo+'@'+imageDigest;
      if(record?.candidateDigest)assert.equal(imageDigest,record.candidateDigest,'The same pinned image recipe produced different bytes');
      records.recipes[identity]={...records.recipes[identity],candidateDigest:imageDigest};await saveImages();
      const source=pack.id==='recon'?'ocidir://.cache/image:recon':'ocidir://.cache/packs/'+pack.id+'/image:'+pack.id;
      await reg(['image','copy',source,repo+':recipe-'+identity.slice(0,16)],3600000);
      assert.equal(digest(await reg(['manifest','get',reference,'--format','raw-body'])),imageDigest,'Published pack digest mismatch');
      records.recipes[identity]={status:'ready',pack:pack.id,sourceCommit:pins.commit,recipeIdentity:identity,digest:imageDigest,compressedBytes:release.compressedBytes};await saveImages();
    }
    const deadline=Date.now()+45*60000;
    while(true){
      const prep=await api.request('/accounts/'+e.accountId+'/containers/image-preparations',{method:'POST',body:{image:reference}});
      if(prep.status==='ready')break;
      assert(!['failed','error','cancelled'].includes(prep.status),'Container image preparation failed: '+pack.id);
      assert(Date.now()<deadline,'Container image preparation deadline exceeded: '+pack.id);
      await new Promise(r=>setTimeout(r,15000));
    }
    images[pack.id]=reference;
    console.log(JSON.stringify({stage:'tool-pack-image',pack:pack.id,status:'verified-and-prepared',digest:imageDigest}));
    // Only this checked-out build's disposable cache is removed; registry data stays.
    if(pack.id==='recon'){for(const name of ['image','base','image-root','recon-layer.tar'])await rm(join(tools,'.cache',name),{recursive:true,force:true});}
    else await rm(join(tools,'.cache/packs',pack.id),{recursive:true,force:true});
  }
  assert.equal(Object.keys(images).length,11);
  await privateJson(join(process.env.RUNNER_TEMP,'pentcloud-pack-images.json'),images);
}finally{await rm(scratch,{recursive:true,force:true});}


}
main().catch(error=>{const code=error?.code==='ERR_ASSERTION'?'integrity-check':'image-operation';console.error('Tool-pack image stage failed ('+code+'); provider/account logs are not emitted.');process.exitCode=1;});
