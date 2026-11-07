// Private installation checkpoints. Credentials never enter Git URLs, argv or files.
import {constants} from 'node:fs';
import {mkdir,open,lstat,readdir,chmod,rename,rm} from 'node:fs/promises';
import {resolve,join,dirname,basename,relative,isAbsolute,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {privateProcess} from './private-process.mjs';

const files=['manifest.json','app.wrangler.json','gateway.wrangler.json','installation-release.json','image-ledger.json'];
const tracked=['owner.json',...files];
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
function failure(code,message){return Object.assign(new Error(message),{code});}
function requireState(condition,code,message){if(!condition)throw failure(code,message);}
function equal(actual,expected,code='PC_STATE_OWNER_MISMATCH'){requireState(isDeepStrictEqual(actual,expected),code,'Private installation ownership differs; retain local and remote evidence for reconciliation');}
function childOf(parent,path){const r=relative(parent,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));}
function identity({accountId,namespace,repo}){
  requireState(/^[a-f0-9]{32}$/.test(accountId??''),'PC_STATE_CONFIG','Select an explicit Cloudflare account');
  for(const name of [namespace,repo])requireState(typeof name==='string'&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(name),'PC_STATE_CONFIG','Invalid private Artifacts name');
  return {base:`/accounts/${accountId}/artifacts/namespaces/${namespace}`,remote:`https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`};
}
function gitEnvironment(remote,token){
  const url=new URL(remote);
  const safe=['PATH','HOME','TMPDIR','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR'];
  const env=Object.fromEntries(safe.filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  const settings={['http.'+url.origin+'/.extraHeader']:'Authorization: Bearer '+token,'credential.helper':'','http.followRedirects':'false','core.hooksPath':'/dev/null','protocol.allow':'never','protocol.https.allow':'always','http.sslVerify':'true'};
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:String(Object.keys(settings).length),GIT_ATTR_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1'});
  Object.entries(settings).forEach(([key,value],i)=>{env['GIT_CONFIG_KEY_'+i]=key;env['GIT_CONFIG_VALUE_'+i]=value;});
  return env;
}

export async function withArtifactGit({api,accountId,namespace,repo,scope='write',run=privateProcess},callback){
  const {base,remote}=identity({accountId,namespace,repo});
  requireState(['read','write'].includes(scope),'PC_STATE_CONFIG','Invalid Artifacts token scope');
  const token=await api.request(base+'/tokens',{method:'POST',body:{repo,scope,ttl:900}});
  try{
    requireState(token?.id&&typeof token.plaintext==='string'&&token.plaintext&&!/[\r\n]/.test(token.plaintext),'PC_ARTIFACT_TOKEN','Artifacts token response incomplete');
    const git=async(args,options={})=>{
      try{return await run('git',args,{timeout:options.timeout??300_000,...(options.cwd?{cwd:options.cwd}:{}),...(options.input!==undefined?{input:options.input}:{}),env:gitEnvironment(remote,token.plaintext)});}
      catch{throw failure('PC_ARTIFACT_GIT_FAILED','Private Artifacts Git operation failed; local evidence is retained for reconciliation');}
    };
    return await callback(git,remote);
  }finally{
    if(token?.id)await api.request(base+'/tokens/'+encodeURIComponent(token.id),{method:'DELETE',missing:true});
  }
}

async function entry(path){try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function safePath(path){
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  for(const piece of relative(root,absolute).split('/').filter(Boolean)){
    current=join(current,piece);const info=await entry(current);
    requireState(!info?.isSymbolicLink(),'PC_STATE_UNSAFE_PATH','Private state paths must not contain symlinks');
  }
  return absolute;
}
async function privateDirectory(path){
  await safePath(path);await mkdir(path,{recursive:true,mode:0o700});
  const info=await entry(path);requireState(info?.isDirectory()&&!info.isSymbolicLink(),'PC_STATE_UNSAFE_PATH','Private state requires a regular directory');await chmod(path,0o700);
}
async function readPrivate(path){
  const info=await entry(path);if(!info)return null;
  requireState(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1,'PC_STATE_UNSAFE_PATH','Private state files must be regular files without links');
  let handle;
  try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const actual=await handle.stat();requireState(actual.isFile()&&actual.nlink===1,'PC_STATE_UNSAFE_PATH','Unsafe private state file');await handle.chmod(0o600);return await handle.readFile();}
  catch(error){if(error.code==='ELOOP')throw failure('PC_STATE_UNSAFE_PATH','Private state file is a symlink');throw error;}
  finally{await handle?.close();}
}
async function writePrivate(path,bytes){
  await safePath(path);await readPrivate(path);const temporary=join(dirname(path),'.'+basename(path)+'.'+randomUUID()+'.tmp');let handle;
  try{handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await rename(temporary,path);}
  finally{await handle?.close();await rm(temporary,{force:true});}
}
function decode(bytes){try{return JSON.parse(bytes.toString());}catch{throw failure('PC_STATE_INVALID','Private installation state contains invalid JSON');}}
async function jsonFile(path){const bytes=await readPrivate(path);return bytes===null?null:decode(bytes);}
async function privateTree(path){
  for(const name of await readdir(path)){
    const file=join(path,name),info=await entry(file);
    requireState(!info.isSymbolicLink(),'PC_STATE_UNSAFE_PATH','Private Git ledger must not contain symlinks');
    if(info.isDirectory()){await chmod(file,0o700);await privateTree(file);}
    else{requireState(info.isFile()&&info.nlink===1,'PC_STATE_UNSAFE_PATH','Private Git ledger contains an unsafe file');await chmod(file,0o600);}
  }
}
function checkAccount(value,accountId){
  for(const field of ['accountId','account_id'])if(value?.[field]!==undefined)equal(value[field],accountId);
  if(value?.account?.id!==undefined)equal(value.account.id,accountId);
}
function checkNamespace(value,owner,namespace){
  requireState(value&&typeof value==='object','PC_STATE_OWNER_MISMATCH','Artifacts namespace metadata is missing');
  equal(value.namespace??value.name,namespace);checkAccount(value,owner.accountId);
}
function checkRepo(value,owner,repo,remote){
  requireState(value?.id&&typeof value.id==='string','PC_STATE_OWNER_MISMATCH','Artifacts repository identity is missing');
  equal(value.name,repo);checkAccount(value,owner.accountId);equal(value.remote,remote);equal(value.default_branch,'main');
  requireState(value.read_only!==true,'PC_STATE_OWNER_MISMATCH','Private checkpoint repository is read only');
}
/** Poll only reads; never retry a repo creation or adopt a replacement identity. */
export async function waitArtifactRepo({api,accountId,namespace,repo,expectedId,now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),timeoutMs=600_000}){
  const {base,remote}=identity({accountId,namespace,repo}),deadline=now()+timeoutMs;
  for(;;){
    let value;
    try{value=await api.request(base+'/repos/'+repo);}
    catch(error){if(error.httpStatus!==409&&!/HTTP 409/.test(error.message??''))throw error;}
    if(value){
      checkRepo(value,{accountId},repo,remote);
      if(expectedId)equal(value.id,expectedId);else expectedId=value.id;
      if(!value.status||value.status==='ready')return value;
      requireState(['importing','forking','pending','creating'].includes(value.status),'PC_STATE_REPO_NOT_READY','Installation repository entered an unsupported or terminal state');
    }
    requireState(now()<deadline,'PC_STATE_REPO_NOT_READY','Installation repository did not become ready; ownership evidence is retained');
    await sleep(Math.min(5000,deadline-now()));
  }
}

function checkDocument(name,bytes,owner){
  if(bytes===null)return;const value=decode(bytes);checkAccount(value,owner.accountId);
  if(name==='manifest.json'&&value.config){for(const key of ['accountId','instance','accessTeamDomain'])equal(value.config[key],owner[key]);if(value.domain!==undefined)equal(value.domain,owner.domain);}
}
async function gitHeadMatches(git,directory,remote){
  requireState(!(await git(['-C',directory,'status','--porcelain','-z','--untracked-files=all'])).toString(),'PC_STATE_DIVERGED','Private ledger has uncommitted state; retain it for reconciliation');
  await git(['-C',directory,'fetch','--no-tags',remote,'refs/heads/main']);
  const local=(await git(['-C',directory,'rev-parse','HEAD'])).toString().trim(),upstream=(await git(['-C',directory,'rev-parse','FETCH_HEAD'])).toString().trim();
  requireState(local&&local===upstream,'PC_STATE_DIVERGED','Local and remote checkpoint histories differ; retain both for reconciliation');
}
async function commit(git,directory,remote,names,message){
  if(!names.length)return;
  await git(['-C',directory,'add','--',...names]);
  const changed=(await git(['-C',directory,'diff','--cached','--name-only','-z'])).toString().split('\0').filter(Boolean);
  requireState(changed.every(name=>tracked.includes(name)),'PC_STATE_UNSAFE_PATH','Private ledger has staged files outside the checkpoint allowlist');
  if(!changed.length)return;
  await git(['-C',directory,'-c','user.name=PentCloud Installer','-c','user.email=installer@pentcloud.invalid','-c','commit.gpgsign=false','commit','-m',message]);
  await git(['-C',directory,'push',remote,'HEAD:refs/heads/main']);
}

/** Caller serializes access and awaits every checkpoint before the next mutation. */
export async function openArtifactState({api,config,domain,stateDirectory,cacheDirectory,ledgerDirectory,run=privateProcess}){
  const namespace=config?.instance+'-setup',repo='installation';
  const {base,remote}=identity({accountId:config?.accountId,namespace,repo});
  requireState(config?.schemaVersion===1&&typeof config.accessTeamDomain==='string'&&Array.isArray(config.allowedEmails),'PC_STATE_CONFIG','Unsupported installation configuration');
  requireState(domain&&/^[a-f0-9]{32}$/.test(domain.zoneId??'')&&typeof domain.hostname==='string'&&domain.hostname,'PC_STATE_CONFIG','Select an explicit installation domain');
  const owner={schemaVersion:1,accountId:config.accountId,instance:config.instance,accessTeamDomain:config.accessTeamDomain,domain:{zoneId:domain.zoneId,hostname:domain.hostname}};
  requireState([stateDirectory,cacheDirectory,ledgerDirectory].every(path=>typeof path==='string'&&path),'PC_STATE_CONFIG','Private state, cache and ledger directories are required');
  [stateDirectory,cacheDirectory,ledgerDirectory]=[stateDirectory,cacheDirectory,ledgerDirectory].map(path=>resolve(path));
  for(const directory of [stateDirectory,cacheDirectory,ledgerDirectory])requireState(!childOf(sourceRoot,directory),'PC_STATE_UNSAFE_PATH','Private installation state must be outside the source checkout');
  for(const directory of [stateDirectory,cacheDirectory])requireState(!childOf(directory,ledgerDirectory)&&!childOf(ledgerDirectory,directory),'PC_STATE_UNSAFE_PATH','Git ledger must be separate from installation state and cache');
  // Preflight every selected path and marker before any control-plane mutation.
  for(const directory of [stateDirectory,cacheDirectory,ledgerDirectory])await privateDirectory(directory);
  const localPath=name=>join(name==='image-ledger.json'?cacheDirectory:stateDirectory,name);
  for(const name of files)checkDocument(name,await readPrivate(localPath(name)),owner);
  await privateTree(ledgerDirectory);
  const localOwner=await jsonFile(join(ledgerDirectory,'owner.json'));if(localOwner)equal(localOwner,owner);
  const journalPath=ledgerDirectory+'.bootstrap.json';let journal=await jsonFile(journalPath);
  if(journal){equal(journal.schemaVersion,1);equal(journal.owner,owner);equal(journal.namespace?.name,namespace);if(journal.repo)equal(journal.repo.name,repo);}
  const saveJournal=async()=>writePrivate(journalPath,JSON.stringify(journal,null,2)+'\n');
  let ns=await api.request(base,{missing:true}),madeNamespace=false;
  if(ns){
    checkNamespace(ns,owner,namespace);
    requireState(journal?.namespace?.status!=='pending','PC_STATE_UNCERTAIN','Namespace creation was not acknowledged; reconcile by provider identity before continuing');
    if(journal?.namespace?.id)equal(ns.id,journal.namespace.id);
  }else{
    requireState(journal?.namespace?.status!=='ready','PC_STATE_UNCERTAIN','Acknowledged installation namespace disappeared; investigate before recreating it');
    journal??={schemaVersion:1,owner};journal.namespace={name:namespace,status:'pending'};await saveJournal();
    ns=await api.request(base.slice(0,base.lastIndexOf('/')),{method:'POST',body:{namespace}});checkNamespace(ns,owner,namespace);
    journal.namespace={name:namespace,status:'ready',...(ns.id?{id:ns.id}:{})};await saveJournal();madeNamespace=true;
  }
  let repository,madeRepo=false;
  try{repository=await api.request(base+'/repos/'+repo,{missing:true});}
  catch(error){if(error.httpStatus!==409&&!/HTTP 409/.test(error.message??''))throw error;repository=await waitArtifactRepo({api,accountId:owner.accountId,namespace,repo,expectedId:journal?.repo?.id});}
  if(repository){
    checkRepo(repository,owner,repo,remote);
    requireState(journal?.repo?.status!=='pending','PC_STATE_UNCERTAIN','Repository creation was not acknowledged; reconcile by provider identity before continuing');
    if(journal?.repo?.id)equal(repository.id,journal.repo.id);
  }else{
    requireState(journal?.namespace?.status==='ready'&&(madeNamespace||journal.namespace.name===namespace),'PC_STATE_UNOWNED','Existing namespace has no verified installation repository; choose a fresh instance');
    requireState(journal?.repo?.status!=='ready','PC_STATE_UNCERTAIN','Acknowledged installation repository disappeared; investigate before recreating it');
    journal.repo={name:repo,status:'pending'};await saveJournal();
    repository=await api.request(base+'/repos',{method:'POST',body:{name:repo,description:'Private installation ownership checkpoints',default_branch:'main'}});checkRepo(repository,owner,repo,remote);
    journal.repo={name:repo,status:'ready',id:repository.id};await saveJournal();madeRepo=true;
  }
  if(madeRepo||repository.status&&repository.status!=='ready')repository=await waitArtifactRepo({api,accountId:owner.accountId,namespace,repo,expectedId:repository.id});
  requireState(!journal?.ownerAttempted||journal.ownerCommitted,'PC_STATE_UNCERTAIN','Initial owner push was not acknowledged; retain local and remote Git evidence for reconciliation');
  let bootstrappedOwner=false;
  const gitSettings={api,accountId:owner.accountId,namespace,repo,scope:'write',run};
  await withArtifactGit(gitSettings,async git=>{
    const entries=await readdir(ledgerDirectory),hasGit=entries.includes('.git');
    requireState(hasGit||entries.length===0,'PC_STATE_UNSAFE_PATH','Private ledger directory contains unrelated files');
    if(hasGit){
      equal((await git(['-C',ledgerDirectory,'remote','get-url','origin'])).toString().trim(),remote);
      const resumable=journal?.repo?.status==='ready'&&!journal.ownerCommitted&&!localOwner;
      if(resumable){
        const head=await readPrivate(join(ledgerDirectory,'.git/HEAD'));
        const names=(await git(['-C',ledgerDirectory,'ls-files','-z'])).toString();
        const refs=(await git(['-C',ledgerDirectory,'for-each-ref','--format=%(refname)'])).toString();
        requireState(entries.length===1&&head&&/^ref: refs\/heads\/[a-zA-Z0-9._/-]+\n$/.test(head.toString())&&!names&&!refs,'PC_STATE_DIVERGED','Interrupted bootstrap has local history or files; retain it for reconciliation');
        requireState(!(await git(['ls-remote',remote])).toString().trim(),'PC_STATE_DIVERGED','Interrupted empty bootstrap acquired remote history; retain both for reconciliation');
      }else await gitHeadMatches(git,ledgerDirectory,remote);
    }else await git(['clone','--no-hardlinks','--',remote,ledgerDirectory]);
    await privateTree(ledgerDirectory);
    const names=(await git(['-C',ledgerDirectory,'ls-files','-z'])).toString().split('\0').filter(Boolean);
    requireState(names.every(name=>tracked.includes(name)),'PC_STATE_UNSAFE_PATH','Installation repository contains files outside its ownership allowlist');
    const remoteOwner=await jsonFile(join(ledgerDirectory,'owner.json'));
    if(remoteOwner)equal(remoteOwner,owner);
    else{
      requireState((madeRepo||journal?.repo?.status==='ready'&&!journal.ownerCommitted)&&names.length===0,'PC_STATE_UNOWNED','Existing installation repository has no valid owner document');
      requireState(!(await git(['ls-remote',remote])).toString().trim(),'PC_STATE_UNOWNED','Existing installation history cannot be adopted');
      journal.ownerAttempted=true;await saveJournal();
      await writePrivate(join(ledgerDirectory,'owner.json'),JSON.stringify(owner,null,2)+'\n');
      await commit(git,ledgerDirectory,remote,['owner.json'],'Initialize private installation ownership');
      journal.ownerCommitted=true;await saveJournal();bootstrappedOwner=true;
    }
  });
  // Compare the complete set first: a conflict never triggers a partial restore.
  const restore=[];
  for(const name of files){
    const local=await readPrivate(localPath(name)),saved=await readPrivate(join(ledgerDirectory,name));checkDocument(name,saved,owner);
    if(local!==null&&saved!==null)equal(local,saved,'PC_STATE_DIVERGED');
    if(local!==null&&saved===null&&!madeRepo&&!bootstrappedOwner)throw failure('PC_STATE_DIVERGED','Local installation state has no matching remote checkpoint; retain both for reconciliation');
    if(local===null&&saved!==null)restore.push([localPath(name),saved]);
  }
  for(const [path,bytes] of restore)await writePrivate(path,bytes);
  const repositoryId=repository.id,namespaceId=ns.id;
  return {namespace,repo,checkpoint:async()=>{
    for(const directory of [stateDirectory,cacheDirectory,ledgerDirectory])await safePath(directory);
    await privateTree(ledgerDirectory);equal(await jsonFile(join(ledgerDirectory,'owner.json')),owner);
    const sources=[];for(const name of files){const bytes=await readPrivate(localPath(name));checkDocument(name,bytes,owner);if(bytes!==null)sources.push([name,bytes]);}
    const currentNamespace=await api.request(base);checkNamespace(currentNamespace,owner,namespace);if(namespaceId)equal(currentNamespace.id,namespaceId);
    const current=await api.request(base+'/repos/'+repo);checkRepo(current,owner,repo,remote);equal(current.id,repositoryId);
    await withArtifactGit(gitSettings,async git=>{
      await gitHeadMatches(git,ledgerDirectory,remote);
      for(const [name,bytes] of sources)await writePrivate(join(ledgerDirectory,name),bytes);
      await commit(git,ledgerDirectory,remote,sources.map(([name])=>name),'Checkpoint private installation ownership');
    });
    await privateTree(ledgerDirectory);
  },close:async()=>{}};
}
