import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const accountId='a'.repeat(32),otherAccount='b'.repeat(32);
const config={schemaVersion:1,accountId,instance:'customer-one',accessTeamDomain:'https://customer.cloudflareaccess.com',allowedEmails:['operator@example.com']};
const domain={zoneId:'c'.repeat(32),hostname:'app.example.com'};
const owner={schemaVersion:1,accountId,instance:config.instance,accessTeamDomain:config.accessTeamDomain,domain};
const namespace=config.instance+'-setup',repo='installation';
const base=`/accounts/${accountId}/artifacts/namespaces`,nsPath=base+'/'+namespace,repoPath=nsPath+'/repos/'+repo;
const remote=`https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`;
const json=value=>JSON.stringify(value)+'\n';
const load=()=>import('./lib/artifact-state.mjs');
async function fixture(t,{existing=false,files={},ownerValue=owner}={}){
  const directory=await mkdtemp(join(await realpath(tmpdir()),'pentcloud-state-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const f={directory,stateDirectory:join(directory,'state'),cacheDirectory:join(directory,'cache'),ledgerDirectory:join(directory,'ledger'),calls:[],requests:[],remoteFiles:new Map(),localFiles:new Map(),head:existing?'commit-1':'',remoteHead:existing?'commit-1':'',pushes:[],tokens:0};
  if(existing){f.namespace={namespace,account_id:accountId,id:'ns-1'};f.repo={id:'repo-1',name:repo,default_branch:'main',remote};if(ownerValue)f.remoteFiles.set('owner.json',json(ownerValue));for(const [name,value] of Object.entries(files))f.remoteFiles.set(name,typeof value==='string'?value:json(value));}
  f.api={request:async(path,options={})=>{
    f.requests.push({path,options});
    if(path===nsPath&&!options.method)return f.namespace??null;
    if(path===repoPath&&!options.method)return f.repo??null;
    if(path===base&&options.method==='POST'){
      const journal=JSON.parse(await readFile(f.ledgerDirectory+'.bootstrap.json','utf8'));assert.equal(journal.namespace.status,'pending');
      f.namespace={namespace,id:'ns-1',account_id:accountId};if(f.loseNamespaceReply)throw Error('lost namespace response');return f.namespace;
    }
    if(path===nsPath+'/repos'&&options.method==='POST'){
      const journal=JSON.parse(await readFile(f.ledgerDirectory+'.bootstrap.json','utf8'));assert.equal(journal.repo.status,'pending');
      f.repo={id:'repo-1',name:repo,default_branch:'main',remote};if(f.loseRepoReply)throw Error('lost repo response');return f.repo;
    }
    if(path===nsPath+'/tokens'&&options.method==='POST')return {id:'token-'+(++f.tokens),plaintext:'fixture-private-token-'+f.tokens};
    if(path.startsWith(nsPath+'/tokens/token-')&&options.method==='DELETE')return null;
    throw Error('Unexpected API '+path+' '+JSON.stringify(options));
  }};
  f.run=async(command,args,settings={})=>{
    f.calls.push({command,args,settings});assert.equal(command,'git');
    const output=value=>Buffer.from(value??'');
    if(args.includes('clone')){
      await mkdir(join(f.ledgerDirectory,'.git'),{recursive:true});await writeFile(join(f.ledgerDirectory,'.git/HEAD'),'ref: refs/heads/main\n');if(f.cloneFailure)throw Error('clone interrupted after initializing Git');
      for(const [name,bytes] of f.remoteFiles){await mkdir(dirname(join(f.ledgerDirectory,name)),{recursive:true});await writeFile(join(f.ledgerDirectory,name),bytes);}
      f.localFiles=new Map(f.remoteFiles);f.head=f.remoteHead;return output();
    }
    if(args.includes('fetch')){if(f.fetchFailure)throw Error('fixture-private-token-1 fetch failed');f.fetchedHead=f.remoteHead;return output();}
    if(args.includes('rev-parse'))return output((args.at(-1)==='FETCH_HEAD'?f.fetchedHead:f.head)+'\n');
    if(args.includes('status')){const dirty=[];for(const [name,bytes] of f.localFiles){if(await readFile(join(f.ledgerDirectory,name),'utf8')!==bytes)dirty.push(' M '+name);}return output(dirty.join('\0'));}
    if(args.includes('ls-files'))return output([...f.localFiles.keys()].join('\0')+(f.localFiles.size?'\0':''));
    if(args.includes('ls-remote'))return output(f.remoteHead?f.remoteHead+'\trefs/heads/main\n':'');
    if(args.includes('for-each-ref'))return output(f.head?'refs/heads/main\n':'');
    if(args.includes('get-url'))return output(remote+'\n');
    if(args.includes('add')){f.staged=args.slice(args.indexOf('--')+1);return output();}
    if(args.includes('diff')){
      const changed=[];for(const name of f.staged??[]){let bytes;try{bytes=await readFile(join(f.ledgerDirectory,name),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;continue;}if(f.localFiles.get(name)!==bytes)changed.push(name);}
      return output(changed.join('\0')+(changed.length?'\0':''));
    }
    if(args.includes('commit')){for(const name of f.staged){try{f.localFiles.set(name,await readFile(join(f.ledgerDirectory,name),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}f.head='commit-'+(++f.commitCount|| (f.commitCount=2));return output();}
    if(args.includes('push')){if(f.pushFailure)throw Error('fixture-private-token-1 push failed');f.remoteFiles=new Map(f.localFiles);f.remoteHead=f.head;f.pushes.push(new Map(f.remoteFiles));return output();}
    throw Error('Unexpected git '+JSON.stringify(args));
  };
  f.open=async overrides=>(await load()).openArtifactState({api:f.api,config,domain,stateDirectory:f.stateDirectory,cacheDirectory:f.cacheDirectory,ledgerDirectory:f.ledgerDirectory,run:f.run,...overrides});
  f.write=async(name,value,cache=false)=>{const path=join(cache?f.cacheDirectory:f.stateDirectory,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,typeof value==='string'?value:json(value));};
  return f;
}

test('new private ledger journals acknowledged ownership and bootstraps owner before state',async t=>{
  const f=await fixture(t);await f.write('manifest.json',{schemaVersion:1,config});
  const state=await f.open();assert.equal(state.namespace,namespace);assert.equal(state.repo,repo);
  assert.deepEqual(JSON.parse(f.pushes[0].get('owner.json')),owner);assert.deepEqual([...f.pushes[0].keys()],['owner.json']);
  const journal=JSON.parse(await readFile(f.ledgerDirectory+'.bootstrap.json','utf8'));assert.equal(journal.namespace.status,'ready');assert.equal(journal.repo.id,'repo-1');assert.equal(journal.ownerCommitted,true);
  await state.checkpoint();assert(f.remoteFiles.has('manifest.json'));
  for(const path of [f.stateDirectory,f.cacheDirectory,f.ledgerDirectory])assert.equal((await stat(path)).mode&0o777,0o700);
  for(const path of [f.ledgerDirectory+'.bootstrap.json',join(f.ledgerDirectory,'owner.json'),join(f.ledgerDirectory,'manifest.json')])assert.equal((await stat(path)).mode&0o777,0o600);
});

test('existing verified ledger restores only missing allowlisted files and image provenance',async t=>{
  const files={'manifest.json':{schemaVersion:1,config},'app.wrangler.json':{account_id:accountId},'gateway.wrangler.json':{account_id:accountId},'installation-release.json':{sourceCommit:'d'.repeat(40)},'image-ledger.json':{schemaVersion:2,accountId,recipes:{}}};
  const f=await fixture(t,{existing:true,files});await f.write('manifest.json',files['manifest.json']);
  await f.open();for(const [name,value] of Object.entries(files))assert.deepEqual(JSON.parse(await readFile(join(name==='image-ledger.json'?f.cacheDirectory:f.stateDirectory,name),'utf8')),value);
  assert.equal(f.requests.filter(c=>c.options.method==='POST'&&!c.path.endsWith('/tokens')).length,0);
});

test('checkpoint excludes credentials sessions build scratch and unknown files',async t=>{
  const f=await fixture(t);const state=await f.open();
  for(const name of ['manifest.json','app.wrangler.json','gateway.wrangler.json','installation-release.json'])await f.write(name,name==='manifest.json'?{schemaVersion:1,config}:{accountId});
  await f.write('image-ledger.json',{schemaVersion:2,accountId,recipes:{}},true);
  for(const name of ['session.json','secrets.json','app-build/private-token'])await f.write(name,'never mirror');await f.write('registry-password','never mirror',true);
  await state.checkpoint();assert.deepEqual([...f.remoteFiles.keys()].sort(),['owner.json','manifest.json','app.wrangler.json','gateway.wrangler.json','installation-release.json','image-ledger.json'].sort());
  for(const c of f.calls.filter(c=>c.args.includes('add'))){assert(c.args.includes('--'));assert(!c.args.includes('--all'));}
});

for(const name of ['manifest.json','installation-release.json','image-ledger.json'])test('different local '+name+' is retained with remote evidence and fails closed',async t=>{
  const remoteValue=name==='manifest.json'?{schemaVersion:1,config,resources:{owned:'one'}}:name==='image-ledger.json'?{schemaVersion:2,accountId,recipes:{one:{status:'ready'}}}:{commit:'one'};
  const f=await fixture(t,{existing:true,files:{[name]:remoteValue}});const localValue={...remoteValue,local:'retain me'};await f.write(name,localValue,name==='image-ledger.json');
  await assert.rejects(f.open(),{code:'PC_STATE_DIVERGED'});assert.deepEqual(JSON.parse(await readFile(join(name==='image-ledger.json'?f.cacheDirectory:f.stateDirectory,name),'utf8')),localValue);assert.deepEqual(JSON.parse(await readFile(join(f.ledgerDirectory,name),'utf8')),remoteValue);
});

test('remote owner collision is rejected without restoring state',async t=>{
  const f=await fixture(t,{existing:true,ownerValue:{...owner,accountId:otherAccount},files:{'manifest.json':{config}}});await assert.rejects(f.open(),{code:'PC_STATE_OWNER_MISMATCH'});assert.deepEqual(await readdir(f.stateDirectory),[]);
});

test('existing namespace lacking installation repository is never adopted',async t=>{
  const f=await fixture(t);f.namespace={namespace,id:'other-namespace'};await assert.rejects(f.open(),{code:'PC_STATE_UNOWNED'});assert.equal(f.requests.filter(c=>c.options.method==='POST').length,0);
});

test('existing repository without owner cannot be bootstrapped by name',async t=>{
  const f=await fixture(t,{existing:true,ownerValue:null});await assert.rejects(f.open(),{code:'PC_STATE_UNOWNED'});assert.equal(f.pushes.length,0);
});

for(const type of ['Namespace','Repo'])test('lost '+type.toLowerCase()+' creation reply leaves pending intent and refuses name adoption',async t=>{
  const f=await fixture(t);f['lose'+type+'Reply']=true;await assert.rejects(f.open());
  f['lose'+type+'Reply']=false;const before=f.requests.filter(c=>c.options.method==='POST').length;await assert.rejects(f.open(),{code:'PC_STATE_UNCERTAIN'});assert.equal(f.requests.filter(c=>c.options.method==='POST').length,before);
});

test('checkpoint push failure stops the next caller mutation and revokes credentials',async t=>{
  const f=await fixture(t);const state=await f.open();await f.write('manifest.json',{schemaVersion:1,config});f.pushFailure=true;let mutated=false;
  await assert.rejects((async()=>{await state.checkpoint();mutated=true;})(),{code:'PC_ARTIFACT_GIT_FAILED'});assert.equal(mutated,false);assert.equal(f.remoteFiles.has('manifest.json'),false);assert.equal(f.requests.filter(c=>c.options.method==='DELETE').length,f.tokens);
});

test('Git tokens are short lived repository scoped revoked and confined to private HTTP headers',async t=>{
  const f=await fixture(t);const state=await f.open();await f.write('manifest.json',{schemaVersion:1,config});await state.checkpoint();
  assert(f.tokens>=2);for(const r of f.requests.filter(r=>r.path===nsPath+'/tokens'))assert.deepEqual(r.options.body,{repo,scope:'write',ttl:900});
  assert.equal(f.requests.filter(r=>r.options.method==='DELETE').length,f.tokens);
  for(const c of f.calls){assert.equal(c.command,'git');assert(!JSON.stringify(c.args).includes('fixture-private-token'));const env=c.settings.env;assert.equal(env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(env.GIT_CONFIG_GLOBAL,'/dev/null');assert.equal(env.GIT_TERMINAL_PROMPT,'0');const entries=Array.from({length:Number(env.GIT_CONFIG_COUNT)},(_,i)=>[env['GIT_CONFIG_KEY_'+i],env['GIT_CONFIG_VALUE_'+i]]);assert(entries.some(([k,v])=>k===`http.https://${accountId}.artifacts.cloudflare.net/.extraHeader`&&v.startsWith('Authorization: Bearer fixture-private-token-')));assert(entries.some(([k,v])=>k==='http.followRedirects'&&v==='false'));assert.equal(c.settings.stdio,undefined);}
});

test('withArtifactGit revokes token even when callback fails and blocks environment override',async t=>{
  const f=await fixture(t);const {withArtifactGit}=await load();await assert.rejects(withArtifactGit({api:f.api,accountId,namespace,repo,run:f.run},async git=>{await git(['ls-remote',remote],{env:{GIT_CONFIG_GLOBAL:'dangerous',CLOUDFLARE_API_TOKEN:'leak'},stdio:'inherit'});throw Error('caller aborted');}),/caller aborted/);assert.equal(f.requests.at(-1).options.method,'DELETE');assert.equal(f.calls[0].settings.env.CLOUDFLARE_API_TOKEN,undefined);
});

for(const collision of ['namespace','repo account','remote'])test('selected account and repository metadata reject '+collision+' mismatch',async t=>{
  const f=await fixture(t,{existing:true});if(collision==='namespace')f.namespace.namespace='other-setup';if(collision==='repo account')f.repo.account_id=otherAccount;if(collision==='remote')f.repo.remote=remote.replace(accountId,otherAccount);
  await assert.rejects(f.open(),{code:'PC_STATE_OWNER_MISMATCH'});assert.equal(f.calls.length,0);
});

test('local account marker mismatch stops before any remote mutation',async t=>{
  const f=await fixture(t);await f.write('image-ledger.json',{schemaVersion:2,accountId:otherAccount},true);await assert.rejects(f.open(),{code:'PC_STATE_OWNER_MISMATCH'});assert.equal(f.requests.length,0);
});

for(const target of ['state','cache','ledger','manifest','image-ledger'])test('refuses '+target+' symlink without touching outside data',async t=>{
  const f=await fixture(t);const outside=join(f.directory,'outside');await mkdir(outside);await writeFile(join(outside,'retained'),'private');
  if(['state','cache','ledger'].includes(target))await symlink(outside,f[target+'Directory']);else{const path=target==='manifest'?f.stateDirectory:f.cacheDirectory;await mkdir(path);await symlink(join(outside,'retained'),join(path,target==='manifest'?'manifest.json':'image-ledger.json'));}
  await assert.rejects(f.open(),{code:'PC_STATE_UNSAFE_PATH'});assert.equal(await readFile(join(outside,'retained'),'utf8'),'private');assert.equal(f.requests.length,0);
});

test('checkpoint detects changed remote head and leaves local ownership untouched',async t=>{
  const f=await fixture(t,{existing:true,files:{'manifest.json':{schemaVersion:1,config}}});const state=await f.open();await f.write('manifest.json',{schemaVersion:1,config,resources:{new:'local'}});f.remoteHead='concurrent-commit';await assert.rejects(state.checkpoint(),{code:'PC_STATE_DIVERGED'});assert.equal(f.pushes.length,0);assert.equal(JSON.parse(await readFile(join(f.stateDirectory,'manifest.json'),'utf8')).resources.new,'local');
});

test('reopening a completed local ledger verifies its Git head and does not reclone',async t=>{
  const f=await fixture(t);const state=await f.open();await f.write('manifest.json',{schemaVersion:1,config});await state.checkpoint();await f.open();assert.equal(f.calls.filter(c=>c.args.includes('clone')).length,1);
});


test('uncommitted local ledger changes cannot masquerade as remote restore evidence',async t=>{
  const f=await fixture(t,{existing:true,files:{'manifest.json':{schemaVersion:1,config}}});await f.open();
  await writeFile(join(f.ledgerDirectory,'manifest.json'),json({schemaVersion:1,config,uncommitted:true}));await f.write('manifest.json',{schemaVersion:1,config,uncommitted:true});
  await assert.rejects(f.open(),{code:'PC_STATE_DIVERGED'});assert.equal(JSON.parse(await readFile(join(f.ledgerDirectory,'manifest.json'),'utf8')).uncommitted,true);
});

test('empty checkpoint never stages unspecified paths',async t=>{
  const f=await fixture(t);const state=await f.open();await state.checkpoint();assert.equal(f.calls.filter(c=>c.args.includes('add')).length,1);
});

test('Git wrapper ignores caller stdio settings that could reveal private output',async t=>{
  const f=await fixture(t);await (await load()).withArtifactGit({api:f.api,accountId,namespace,repo,run:f.run},async git=>git(['ls-remote',remote],{stdio:'inherit'}));assert.equal(f.calls[0].settings.stdio,undefined);
});

test('checkpoint verifies provider repository identity before any Git mutation',async t=>{
  const f=await fixture(t);const state=await f.open();f.repo.id='replacement-repo';await f.write('manifest.json',{schemaVersion:1,config});const before=f.calls.length;await assert.rejects(state.checkpoint(),{code:'PC_STATE_OWNER_MISMATCH'});assert.equal(f.calls.length,before);
});

test('Git process failure cannot expose token-bearing output and always revokes',async t=>{
  const f=await fixture(t,{existing:true});const state=await f.open();f.fetchFailure=true;await assert.rejects(state.checkpoint(),e=>e.code==='PC_ARTIFACT_GIT_FAILED'&&!e.message.includes('fixture-private-token'));assert.equal(f.requests.filter(c=>c.options.method==='DELETE').length,f.tokens);
});

test('checkpoint rejects newly introduced source and Git directory symlinks',async t=>{
  const f=await fixture(t);const state=await f.open();const retained=join(f.directory,'retained');await writeFile(retained,'private');await symlink(retained,join(f.stateDirectory,'manifest.json'));await assert.rejects(state.checkpoint(),{code:'PC_STATE_UNSAFE_PATH'});assert.equal(await readFile(retained,'utf8'),'private');
});


test('acknowledged empty repo safely resumes a failed clone without recreating resources',async t=>{
  const f=await fixture(t);f.cloneFailure=true;await assert.rejects(f.open(),{code:'PC_ARTIFACT_GIT_FAILED'});f.cloneFailure=false;const state=await f.open();assert.equal(state.repo,repo);assert.deepEqual(JSON.parse(f.remoteFiles.get('owner.json')),owner);assert.equal(f.requests.filter(r=>r.path===nsPath+'/repos'&&r.options.method==='POST').length,1);
});

test('empty bootstrap resume refuses remote history after its acknowledged empty clone failed',async t=>{
  const f=await fixture(t);f.cloneFailure=true;await assert.rejects(f.open());f.cloneFailure=false;f.remoteHead='unexpected-commit';await assert.rejects(f.open(),{code:'PC_STATE_DIVERGED'});assert.equal(f.pushes.length,0);
});

test('failed bootstrap push remains blocked even if its commit reached the remote',async t=>{
  const f=await fixture(t);f.pushFailure=true;await assert.rejects(f.open());f.pushFailure=false;f.remoteFiles=new Map(f.localFiles);f.remoteHead=f.head;await assert.rejects(f.open(),{code:'PC_STATE_UNCERTAIN'});assert.equal(f.pushes.length,0);
});

test('repository readiness waits using only reads and preserves its immutable identity',async()=>{
  const {waitArtifactRepo}=await load();let time=0,reads=0;
  const api={request:async(path,options)=>{assert.equal(path,repoPath);assert.equal(options,undefined);reads++;if(reads===1)throw Object.assign(Error('not ready'),{httpStatus:409});return {id:'repo-1',name:repo,default_branch:'main',remote,status:reads===2?'importing':'ready'};}};
  const result=await waitArtifactRepo({api,accountId,namespace,repo,expectedId:'repo-1',now:()=>time,sleep:async ms=>{time+=ms;}});assert.equal(result.status,'ready');assert.equal(reads,3);assert(time>0);
});

test('readiness polling rejects identity replacement and terminal states',async()=>{
  const {waitArtifactRepo}=await load();
  for(const value of [{id:'replacement',name:repo,default_branch:'main',remote,status:'ready'},{id:'repo-1',name:repo,default_branch:'main',remote,status:'failed'}])await assert.rejects(waitArtifactRepo({api:{request:async()=>value},accountId,namespace,repo,expectedId:'repo-1',sleep:async()=>{}}));
});

test('readiness polling is bounded and never retries creation',async()=>{
  const {waitArtifactRepo}=await load();let time=0,reads=0;
  await assert.rejects(waitArtifactRepo({api:{request:async()=>{reads++;throw Object.assign(Error('not ready'),{httpStatus:409});}},accountId,namespace,repo,expectedId:'repo-1',now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:10}),{code:'PC_STATE_REPO_NOT_READY'});assert(reads>=1&&reads<5);
});
