// Shared customer/CI image recipe. Every child process captures its output through
// the caller's private runner; only bounded stage metadata reaches log().
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {access,chmod,lstat,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {delimiter,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {REGCTL_HASHES,REGCTL_VERSION,regctlPlatform} from './private-image.mjs';
import {hash,privateJson,readJson} from './private-install.mjs';
import {matchingLock,pendingRecipe,recipeIdentity,releaseDigest} from '../ci/image-manifest.mjs';

const PACKS=['http','recon','nuclei','service','sqlmap','web-context','file-analysis','password','pcap','reference','metasploit'];
const digestPattern=/^sha256:[a-f0-9]{64}$/;
const passthrough=['PATH','HOME','TMPDIR','LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE'];
const cleanEnvironment=environment=>Object.fromEntries(passthrough.filter(key=>environment[key]).map(key=>[key,environment[key]]));
const within=(parent,child)=>{const path=relative(parent,child);return path===''||(!path.startsWith('..'+sep)&&path!=='..'&&!isAbsolute(path));};
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function notSymlink(path){if(await exists(path))assert(!(await lstat(path)).isSymbolicLink(),'Image cache/source paths must not be symlinks');}
async function executable(name,environment){
  const candidates=isAbsolute(name)?[name]:(environment.PATH??'').split(delimiter).filter(Boolean).map(path=>resolve(path,name));
  for(const path of candidates){try{await access(path,constants.X_OK);if((await lstat(path)).isDirectory())continue;return await realpath(path);}catch(error){if(!['ENOENT','EACCES','ENOTDIR'].includes(error.code))throw error;}}
  return null;
}
async function prerequisites(run,environment){
  const need=(condition,code,message)=>{if(!condition)throw Object.assign(Error(message),{code});};
  const env={...cleanEnvironment(environment),GOTOOLCHAIN:'local',GOENV:'off'};
  const git=await executable('git',env),go=await executable(environment.GO_BIN||'go',env),python=await executable('python3',env);
  need(git,'PC_GIT_REQUIRED','Package image preparation requires Git');need(go,'PC_GO_REQUIRED','Package image preparation requires Go 1.26.5');need(python,'PC_PYTHON_REQUIRED','Package image preparation requires Python 3.11+');
  await run(git,['--version'],{env});
  need((await run(go,['env','GOVERSION'],{env})).toString().trim()==='go1.26.5','PC_GO_VERSION','Package image preparation requires existing Go 1.26.5 (set GO_BIN)');
  const version=(await run(python,['--version'],{env})).toString().match(/^Python (\d+)\.(\d+)(?:\.\d+)?/);
  need(version&&Number(version[1])===3&&Number(version[2])>=11,'PC_PYTHON_VERSION','Package image preparation requires Python 3.11+');
  let tar;
  for(const name of ['bsdtar','tar']){const path=await executable(name,env);if(!path)continue;try{if(/\bbsdtar\b/i.test((await run(path,['--version'],{env})).toString())){tar=path;break;}}catch{}}
  need(tar,'PC_ARCHIVE_READER','Package images require bsdtar with 7z support; install libarchive/bsdtar and retry');
  return {git,go,python,tar,env};
}
export const checkPackageBuildPrerequisites=prerequisites;
function validateLedger(records,accountId){
  assert(records?.schemaVersion===2&&records.recipes&&typeof records.recipes==='object'&&!Array.isArray(records.recipes),'Unsupported private image ledger');
  assert.equal(records.accountId,accountId,'Private image cache belongs to another account');
  for(const [identity,record] of Object.entries(records.recipes)){
    assert.match(identity,/^[a-f0-9]{64}$/,'Invalid image recipe identity');
    assert(record&&PACKS.includes(record.pack)&&['pending','ready'].includes(record.status),'Invalid private image recipe record');
    assert.equal(record.recipeIdentity,identity,'Private image recipe identity changed');assert.match(record.sourceCommit??'',/^[a-f0-9]{40}$/,'Invalid private image source commit');
    if(record.status==='pending'){if(record.candidateDigest!==undefined)assert.match(record.candidateDigest,digestPattern,'Pending image digest is invalid');}
    else{
      assert.match(record.digest??'',digestPattern,'Ready image digest is invalid');
      assert(typeof record.image==='string'&&record.image.startsWith(`registry.cloudflare.com/${accountId}/`),'Ready image must retain its full selected-account reference');
      const repository=record.image.slice(`registry.cloudflare.com/${accountId}/`.length).split('@');
      assert(repository.length===2&&/^[a-z0-9][a-z0-9._-]*$/.test(repository[0])&&repository[1]===record.digest,'Ready image reference differs from its immutable digest');
      assert(Number.isSafeInteger(record.compressedBytes)&&record.compressedBytes>0,'Ready image lacks bounded image size');
    }
  }
}
async function cleanBuildCache(tools,pack){
  await notSymlink(join(tools,'.cache'));await notSymlink(join(tools,'.cache/packs'));
  const paths=pack==='recon'?['image','base','image-root','recon-layer.tar','image-release.json','downloads']:['packs/'+pack];
  // Downloaded source archives are disposable too; the source checkout and
  // content-addressed ownership ledger are the only cache needed for resumption.
  paths.push('pack-downloads');
  for(const path of paths)await rm(join(tools,'.cache',path),{recursive:true,force:true});
}
async function prepareNative(api,accountId,pack,image){
  const deadline=Date.now()+45*60_000;
  for(;;){
    const result=await api.request(`/accounts/${accountId}/containers/image-preparations`,{method:'POST',body:{image}});
    if(result?.status==='ready')return;
    assert(!['failed','error','cancelled'].includes(result?.status),'Container image preparation failed: '+pack);
    assert(typeof result?.status==='string','Container image preparation returned no status');
    assert(Date.now()<deadline,'Container image preparation deadline exceeded: '+pack);
    await new Promise(resolve=>setTimeout(resolve,15_000));
  }
}

export async function preparePackageImages({root,config,directory,api,run,checkpoint=async()=>{},log=()=>{},toolsDirectory,environment=process.env,fetcher=fetch}){
  assert.match(config?.accountId??'',/^[a-f0-9]{32}$/,'Select an explicit Cloudflare account');
  assert.match(config?.instance??'',/^[a-z][a-z0-9-]{2,37}$/,'Select an explicit installation instance');
  root=await realpath(resolve(root));directory=resolve(directory);
  assert(!within(root,directory)&&!within(directory,root),'Private image cache must be outside the source checkout and its ancestors');
  await notSymlink(directory);await mkdir(directory,{recursive:true,mode:0o700});directory=await realpath(directory);await chmod(directory,0o700);
  assert(!within(root,directory)&&!within(directory,root),'Private image cache must be outside the source checkout and its ancestors');
  const ledgerFile=join(directory,'image-ledger.json');await notSymlink(ledgerFile);
  const records=await readJson(ledgerFile,{schemaVersion:2,accountId:config.accountId,recipes:{}});validateLedger(records,config.accountId);
  const save=async()=>{await privateJson(ledgerFile,records);await checkpoint();};
  // Check every local prerequisite before registry credentials, image writes or
  // native preparation. No sudo, package installation, or automatic Go download.
  const preflight=await prerequisites(run,environment),{git,go,python,tar}=preflight;
  const pins=await readJson(join(root,'ci/tool-pack-images.json'));
  assert(pins.schemaVersion===1&&pins.repository==='Memrov/PentCloud-tools','Unsupported pinned image source');assert.match(pins.commit??'',/^[a-f0-9]{40}$/,'Invalid pinned source commit');
  assert(Array.isArray(pins.packs)&&pins.packs.length===11&&new Set(pins.packs.map(pack=>pack.id)).size===11&&pins.packs.every(pack=>PACKS.includes(pack.id)),'Pinned image source must contain the complete eleven-pack set');
  const tools=resolve(toolsDirectory??join(directory,'tools-source-'+pins.commit));
  const gitEnv={...preflight.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
  const gitRun=args=>run(git,['-c','credential.helper=','-c','core.hooksPath=/dev/null',...args],{env:gitEnv});
  await notSymlink(tools);
  if(!(await exists(tools))){
    assert(!toolsDirectory,'Provided tools checkout is missing');
    await gitRun(['clone','--no-checkout','--filter=blob:none','https://github.com/Memrov/PentCloud-tools.git',tools]);
    await gitRun(['-C',tools,'checkout','--detach',pins.commit]);
  }
  assert.equal((await gitRun(['-C',tools,'rev-parse','HEAD'])).toString().trim(),pins.commit,'Tools checkout commit differs from the reviewed image recipe');
  assert.equal((await gitRun(['-C',tools,'status','--porcelain','--untracked-files=no'])).toString().trim(),'','Tools checkout has modified source files');
  await notSymlink(join(tools,'.cache'));await notSymlink(join(tools,'.cache/packs'));
  const recipes=[];
  for(const pack of pins.packs){
    const lock=await readJson(pack.id==='recon'?join(tools,'tools.lock.json'):join(tools,'packages',pack.id,'tools.lock.json'));
    matchingLock(pack.id,lock,await readJson(join(root,'node_modules/@memrov2/pentcloud-'+pack.id+'/tools.lock.json')));
    const identity=recipeIdentity(pack.id,lock,pins.commit,REGCTL_VERSION),record=records.recipes[identity];
    if(record)assert(record.pack===pack.id&&record.sourceCommit===pins.commit&&record.recipeIdentity===identity,'Cached image does not match the expected recipe');
    recipes.push({pack:pack.id,identity,record});
  }
  const scratch=await mkdtemp(join(directory,'package-images-'));await chmod(scratch,0o700);
  try{
    const key=regctlPlatform(),response=await fetcher(`https://github.com/regclient/regclient/releases/download/${REGCTL_VERSION}/regctl-${key}`,{signal:AbortSignal.timeout(120_000)});
    assert(response.ok,'Cannot fetch pinned OCI image client');const bytes=Buffer.from(await response.arrayBuffer());assert.equal(hash(bytes),REGCTL_HASHES[key],'OCI client checksum mismatch');
    const regctl=join(scratch,'regctl');await writeFile(regctl,bytes,{mode:0o700,flag:'wx'});
    const shims=join(scratch,'bin');await mkdir(shims,{mode:0o700});await symlink(tar,join(shims,'tar'));await symlink(go,join(shims,'go'));await symlink(python,join(shims,'python3'));
    const temporary=join(scratch,'tmp');await mkdir(temporary,{mode:0o700});
    const env={...preflight.env,PATH:shims+delimiter+(preflight.env.PATH??''),REGCTL:regctl,REGCTL_CONFIG:join(scratch,'regctl.json'),DOCKER_CONFIG:scratch,
      GOCACHE:join(scratch,'go-build'),GOMODCACHE:join(scratch,'go-modules'),TMPDIR:temporary};
    const reg=(args,timeout=180_000)=>run(regctl,args,{env,cwd:tools,timeout});
    const selector=join(scratch,'account.wrangler.json');await privateJson(selector,{name:config.instance+'-images',account_id:config.accountId,compatibility_date:'2026-11-06'});
    const images={};
    for(const {pack,identity,record} of recipes){
      try{
        log({stage:'tool-pack-image',pack,status:'checking'});
        // Credentials are renewed for each potentially hour-long image build.
        const output=await run('wrangler',['containers','registries','credentials','registry.cloudflare.com','--push','--pull','--expiration-minutes','60','--json','--config',selector]);
        let credential;try{credential=JSON.parse(output.toString());}catch{throw Error('Registry credentials returned invalid private JSON');}
        assert(credential?.registry_host==='registry.cloudflare.com','Unexpected registry credential host');assert(credential.username&&credential.password,'Registry credential missing');
        await privateJson(join(scratch,'config.json'),{auths:{'registry.cloudflare.com':{auth:Buffer.from(credential.username+':'+credential.password).toString('base64')}}});
        await reg(['registry','set','registry.cloudflare.com','--blob-chunk','134217728','--blob-max','134217728','--req-concurrent','1']);
        let imageDigest=record?.status==='ready'?record.digest:null,reference=record?.status==='ready'?record.image:null,compressedBytes=record?.compressedBytes;
        if(reference){
          // A missing or altered ready image is an integrity failure, never a
          // reason to adopt a tag, another repository, or freshly built bytes.
          assert.equal('sha256:'+hash(await reg(['manifest','get',reference,'--format','raw-body'])),imageDigest,'Existing pack manifest changed');
        }else{
          records.recipes[identity]=pendingRecipe(pack,pins.commit,identity,record);await save();
          log({stage:'build-tool-pack',pack});
          await run('node',pack==='recon'?[join(tools,'scripts/build-image.mjs')]:[join(tools,'scripts/build-pack.mjs'),pack],{cwd:tools,env,timeout:3_600_000});
          const release=await readJson(pack==='recon'?join(tools,'.cache/image-release.json'):join(tools,'.cache/packs',pack,'image-release.json'));
          imageDigest=releaseDigest(release);compressedBytes=release.compressedBytes;
          if(record?.candidateDigest)assert.equal(imageDigest,record.candidateDigest,'The same pinned image recipe produced different bytes');
          records.recipes[identity]={...records.recipes[identity],candidateDigest:imageDigest};await save();
          const repository=`registry.cloudflare.com/${config.accountId}/${config.instance}-${pack}`;reference=repository+'@'+imageDigest;
          const source=pack==='recon'?'ocidir://.cache/image:recon':`ocidir://.cache/packs/${pack}/image:${pack}`;
          await reg(['image','copy',source,repository+':recipe-'+identity.slice(0,16)],3_600_000);
          assert.equal('sha256:'+hash(await reg(['manifest','get',reference,'--format','raw-body'])),imageDigest,'Published pack digest mismatch');
        }
        await prepareNative(api,config.accountId,pack,reference);
        if(record?.status!=='ready'){
          records.recipes[identity]={status:'ready',pack,sourceCommit:pins.commit,recipeIdentity:identity,digest:imageDigest,image:reference,compressedBytes};await save();
        }
        images[pack]=reference;log({stage:'tool-pack-image',pack,status:'verified-and-prepared',digest:imageDigest});
      }finally{
        await cleanBuildCache(tools,pack);
        for(const path of [env.GOCACHE,env.GOMODCACHE])await rm(path,{recursive:true,force:true});
      }
    }
    assert.equal(Object.keys(images).length,11,'Image preparation did not produce the complete pack set');return images;
  }finally{await rm(scratch,{recursive:true,force:true});}
}
