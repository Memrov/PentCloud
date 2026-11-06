import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile,rm,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {CloudflareApi,readJson} from '../lib/private-install.mjs';
import {privateProcess} from '../lib/private-process.mjs';

export function environment(env=process.env){
  const settings=env.PENTCLOUD_INSTALL_CONFIG?JSON.parse(env.PENTCLOUD_INSTALL_CONFIG):{accountId:env.CLOUDFLARE_ACCOUNT_ID,zoneId:env.PENTCLOUD_TEST_ZONE_ID,hostname:env.PENTCLOUD_TEST_HOSTNAME,team:env.PENTCLOUD_TEST_ACCESS_TEAM,emails:JSON.parse(env.PENTCLOUD_TEST_ALLOWED_EMAILS??'[]')};
  const value={...settings,sha:env.GITHUB_SHA,ref:env.GITHUB_REF_NAME};
  if(env.GITHUB_ACTIONS==='true')for(const item of [value.accountId,value.zoneId,value.team,...value.emails])console.log('::add-mask::'+item);
  assert.match(value.accountId??'',/^[a-f0-9]{32}$/);
  assert.match(value.zoneId??'',/^[a-f0-9]{32}$/);
  assert.equal(value.hostname,'install.heflare.app','Only the explicit testing hostname is supported');
  assert.match(value.sha??'',/^[a-f0-9]{40}$/);
  assert.match(value.ref??'',/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
  assert(!value.ref.includes('..'),'Invalid source ref');
  assert.equal(env.GITHUB_REPOSITORY,'Memrov/PentCloud','This privileged integration job is only for the configured repository');
  assert(env.CLOUDFLARE_API_TOKEN,'Missing installation-test deployment secret');
  return value;
}
export function client(e){return new CloudflareApi(process.env.CLOUDFLARE_API_TOKEN,fetch,{zoneIds:[e.zoneId]});}
export async function validateAccount(api,e){
  const zone=await api.request('/zones/'+e.zoneId);
  assert.equal(zone.name,'heflare.app','Only the separate testing zone is supported');
  assert.equal(zone.account.id,e.accountId,'Test account/zone mismatch');
  assert.equal(zone.status,'active','Testing zone must be active');
}
export async function namespace(api,e,name){
  assert(['pentcloud-ci-source','pentcloud-ci-state'].includes(name),'Unexpected CI namespace');
  const base='/accounts/'+e.accountId+'/artifacts/namespaces';
  const found=await api.request(base+'/'+name,{missing:true});
  if(!found)await api.request(base,{method:'POST',body:{namespace:name}});
  return base+'/'+name;
}
export function gitEnvironment(remote,token){
  const u=new URL(remote);assert.equal(u.protocol,'https:');assert(u.hostname.endsWith('.artifacts.cloudflare.net')&&!u.username&&!u.password&&!u.search);
  const safe=['PATH','HOME','TMPDIR','LANG','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR'];
  return {...Object.fromEntries(safe.filter(k=>process.env[k]).map(k=>[k,process.env[k]])),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'3',GIT_CONFIG_KEY_0:'http.'+u.origin+'/.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+token,GIT_CONFIG_KEY_1:'credential.helper',GIT_CONFIG_VALUE_1:'',GIT_CONFIG_KEY_2:'http.followRedirects',GIT_CONFIG_VALUE_2:'false'};
}
export async function withGit(api,base,repo,scope,fn){
  const token=await api.request(base+'/tokens',{method:'POST',body:{repo,scope,ttl:900}});
  assert(token.id&&token.plaintext,'Artifacts token response incomplete');
  const account=base.match(/^\/accounts\/([a-f0-9]{32})/)[1],ns=base.split('/').at(-1);
  const remote='https://'+account+'.artifacts.cloudflare.net/git/'+ns+'/'+repo+'.git';
  try{return await fn((args,settings={})=>privateProcess('git',args,{env:gitEnvironment(remote,token.plaintext),timeout:300000,...settings}),remote);}
  finally{await api.request(base+'/tokens/'+token.id,{method:'DELETE',missing:true});}
}
export async function waitRepo(api,path){
  const deadline=Date.now()+600000;
  while(Date.now()<deadline){
    try{const repo=await api.request(path);if(!repo.status||repo.status==='ready')return repo;assert(['importing','forking'].includes(repo.status),'Artifacts import failed');}
    catch(error){if(!/HTTP 409/.test(error.message))throw error;}
    await new Promise(r=>setTimeout(r,5000));
  }
  throw Error('Artifacts repository did not become ready');
}
export async function importSource(api,e,directory){
  const base=await namespace(api,e,'pentcloud-ci-source'),name='src-'+e.sha.slice(0,16),path=base+'/repos/'+name;
  const exists=await api.request(path,{missing:true});
  if(!exists)await api.request(path+'/import',{method:'POST',body:{url:'https://github.com/Memrov/PentCloud',branch:e.ref,depth:100}});
  await waitRepo(api,path);
  await withGit(api,base,name,'read',async(git,remote)=>{
    await git(['clone','--no-checkout',remote,directory]);
    await git(['-C',directory,'checkout','--detach',e.sha]);
    assert.equal((await git(['-C',directory,'rev-parse','HEAD'])).toString().trim(),e.sha,'Artifacts commit differs from tested GitHub commit');
  });
  return {namespace:'pentcloud-ci-source',repo:name,commit:e.sha};
}
const stateFiles=['manifest.json','app.wrangler.json','gateway.wrangler.json'];
export async function stateLedger(api,e,directory,stateDirectory){
  const base=await namespace(api,e,'pentcloud-ci-state'),repo='installation',path=base+'/repos/'+repo;
  let created=false;
  if(!await api.request(path,{missing:true})){await api.request(base+'/repos',{method:'POST',body:{name:repo,description:'Private PentCloud installation-test ownership state'}});created=true;}
  await waitRepo(api,path);
  const owner={schemaVersion:1,repository:'Memrov/PentCloud',accountId:e.accountId,zoneId:e.zoneId,hostname:e.hostname};
  await mkdir(stateDirectory,{recursive:true,mode:0o700});
  await withGit(api,base,repo,'write',async(git,remote)=>{
    await git(['clone',remote,directory]);
    if(created){await writeFile(join(directory,'owner.json'),JSON.stringify(owner)+'\n',{mode:0o600});}
    else assert.deepEqual(JSON.parse(await readFile(join(directory,'owner.json'),'utf8')),owner,'Private installation ledger ownership changed');
    for(const name of stateFiles){try{await copyFile(join(directory,name),join(stateDirectory,name));}catch(error){if(error.code!=='ENOENT')throw error;}}
  });
  return ()=>checkpointLedger(api,e,directory,stateDirectory);
}
export async function checkpointLedger(api,e,directory,stateDirectory){
  const base='/accounts/'+e.accountId+'/artifacts/namespaces/pentcloud-ci-state';
  for(const name of stateFiles){try{await copyFile(join(stateDirectory,name),join(directory,name));}catch(error){if(error.code!=='ENOENT')throw error;}}
  await withGit(api,base,'installation','write',async(git)=>{
    await git(['-C',directory,'add','--all']);
    const diff=await git(['-C',directory,'diff','--cached','--name-only']);
    if(!diff.toString().trim())return;
    await git(['-C',directory,'-c','user.name=PentCloud CI','-c','user.email=actions@users.noreply.github.com','commit','-m','Checkpoint installation-test ownership']);
    await git(['-C',directory,'push','origin','HEAD:main']);
  });
}

