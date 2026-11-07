import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {REGCTL_HASHES,REGCTL_VERSION,regctlPlatform} from './lib/private-image.mjs';
import {recipeIdentity} from './ci/image-manifest.mjs';

const packs=['http','recon','nuclei','service','sqlmap','web-context','file-analysis','password','pcap','reference','metasploit'];
const accountId='a'.repeat(32),commit='b'.repeat(40);
const binary=Buffer.from('private upstream OCI client fixture');
const manifest=Buffer.from('{"schemaVersion":2,"layers":[{"size":123}]}');
const digest='sha256:'+createHash('sha256').update(manifest).digest('hex');
const load=()=>import('./lib/package-images.mjs');

async function fixture(t,{withTools=true,tarName='bsdtar'}={}){
  const base=await mkdtemp(join(tmpdir(),'pentcloud-images-test-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'app'),directory=join(base,'private-cache'),tools=join(base,'tools'),bin=join(base,'bin');
  await Promise.all([mkdir(join(root,'ci'),{recursive:true}),mkdir(directory),mkdir(bin)]);
  await writeFile(join(root,'ci/tool-pack-images.json'),JSON.stringify({schemaVersion:1,repository:'Memrov/PentCloud-tools',commit,packs:packs.map(id=>({id}))}));
  const locks=Object.fromEntries(packs.map(id=>[id,{packId:id,platform:'linux/amd64',baseImage:'example@sha256:'+'c'.repeat(64),tools:[]}]));
  const source=async path=>{
    await mkdir(join(path,'scripts'),{recursive:true});
    for(const pack of packs){const file=pack==='recon'?join(path,'tools.lock.json'):join(path,'packages',pack,'tools.lock.json');await mkdir(join(file,'..'),{recursive:true});await writeFile(file,JSON.stringify(locks[pack]));}
  };
  for(const pack of packs){const path=join(root,'node_modules/@memrov2/pentcloud-'+pack);await mkdir(path,{recursive:true});await writeFile(join(path,'tools.lock.json'),JSON.stringify(locks[pack]));}
  if(withTools)await source(tools);
  for(const command of ['git','go','python3',tarName])await writeFile(join(bin,command),'fixture',{mode:0o700});
  const key=regctlPlatform(),originalPin=REGCTL_HASHES[key];REGCTL_HASHES[key]=createHash('sha256').update(binary).digest('hex');t.after(()=>{REGCTL_HASHES[key]=originalPin;});
  const f={base,root,directory,tools,bin,locks,config:{accountId,instance:'customer-one'},calls:[],checkpoints:[],logs:[],registry:new Map(),builds:[],preparations:[],downloads:[],head:commit,goVersion:'go1.26.5',pythonVersion:'Python 3.11.9',tarVersion:'bsdtar 3.7.7 - libarchive 3.7.7',copyFailure:false,manifestBytes:manifest,
    environment:{PATH:bin,HOME:base,LANG:'C',CLOUDFLARE_API_TOKEN:'fixture-cf-private',OPENCODE_GO_API_KEY:'fixture-model-private',AWS_SECRET_ACCESS_KEY:'fixture-aws-private',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'dangerous'}};
  f.identity=pack=>recipeIdentity(pack,locks[pack],commit,REGCTL_VERSION);
  f.ready=(pack,instance='previous-one')=>({status:'ready',pack,sourceCommit:commit,recipeIdentity:f.identity(pack),digest,image:`registry.cloudflare.com/${accountId}/${instance}-${pack}@${digest}`,compressedBytes:123});
  f.seed=async change=>{const records={schemaVersion:2,accountId,recipes:Object.fromEntries(packs.map(pack=>[f.identity(pack),f.ready(pack)]))};change?.(records);await writeFile(join(directory,'image-ledger.json'),JSON.stringify(records));for(const record of Object.values(records.recipes))if(record.image)f.registry.set(record.image,manifest);return records;};
  f.run=async(kind,args,options={})=>{
    f.calls.push({kind,args,options});const command=basename(kind);
    if(command==='git'){
      if(args.includes('clone')){await source(args.at(-1));return Buffer.alloc(0);}
      if(args.includes('rev-parse'))return Buffer.from(f.head+'\n');
      if(args.includes('status'))return Buffer.alloc(0);
      return Buffer.alloc(0);
    }
    if(command==='go')return Buffer.from(f.goVersion+'\n');
    if(command==='python3')return Buffer.from(f.pythonVersion+'\n');
    if(command==='bsdtar'||command==='tar')return Buffer.from(f.tarVersion+'\n');
    if(kind==='wrangler'){
      assert(args.includes('--push')&&args.includes('--pull'));
      const selector=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8'));
      assert.equal(selector.account_id,accountId);
      return Buffer.from(JSON.stringify({registry_host:'registry.cloudflare.com',username:'fixture-user',password:'fixture-registry-private'}));
    }
    if(kind==='node'||kind===process.execPath){
      const pack=args[0].endsWith('build-image.mjs')?'recon':args[1];f.builds.push(pack);
      const path=pack==='recon'?join(options.cwd,'.cache/image-release.json'):join(options.cwd,'.cache/packs',pack,'image-release.json');
      await mkdir(join(path,'..'),{recursive:true});await writeFile(path,JSON.stringify({digest:'sha256:'+createHash('sha256').update(f.manifestBytes).digest('hex'),platform:'linux/amd64',compressedBytes:123}));
      const downloads=join(options.cwd,'.cache',pack==='recon'?'downloads':'pack-downloads');await mkdir(downloads,{recursive:true});await writeFile(join(downloads,'large-build-cache'),'discard me');return Buffer.alloc(0);
    }
    if(command==='regctl'){
      if(args[0]==='registry')return Buffer.alloc(0);
      if(args[0]==='image'&&args[1]==='copy'){
        if(f.copyFailure)throw Error('fixture interrupted copy');
        const repo=args.at(-1).split(':recipe-')[0],d='sha256:'+createHash('sha256').update(f.manifestBytes).digest('hex');f.registry.set(repo+'@'+d,f.manifestBytes);return Buffer.alloc(0);
      }
      if(args[0]==='manifest'){const body=f.registry.get(args[2]);if(!body)throw Error('fixture manifest missing');return body;}
    }
    throw Error('Unexpected fixture subprocess: '+kind+' '+JSON.stringify(args));
  };
  f.fetcher=async url=>{f.downloads.push(url);return {ok:true,arrayBuffer:async()=>binary};};
  f.api={request:async(path,options)=>{assert.equal(path,`/accounts/${accountId}/containers/image-preparations`);assert.equal(options.method,'POST');f.preparations.push(options.body.image);return f.preparationResult??{status:'ready'};}};
  f.checkpoint=async()=>{f.checkpoints.push(JSON.parse(await readFile(join(directory,'image-ledger.json'),'utf8')));};
  f.prepare=async overrides=>(await load()).preparePackageImages({root,config:f.config,directory,toolsDirectory:withTools?tools:undefined,api:f.api,run:f.run,checkpoint:f.checkpoint,log:record=>f.logs.push(record),environment:f.environment,fetcher:f.fetcher,...overrides});
  f.readLedger=async()=>JSON.parse(await readFile(join(directory,'image-ledger.json'),'utf8'));
  return f;
}

// Catches skipped digest/ownership/preparation checkpoints and leaked build credentials.
test('fresh preparation returns eleven prepared immutable images and checkpoints private ownership',async t=>{
  const f=await fixture(t),images=await f.prepare();
  assert.equal(Object.keys(images).length,11);assert.equal(f.builds.length,11);assert.equal(f.preparations.length,11);
  const ledger=await f.readLedger();assert.equal(ledger.schemaVersion,2);assert.equal(ledger.accountId,accountId);
  for(const pack of packs){assert.equal(images[pack],`registry.cloudflare.com/${accountId}/customer-one-${pack}@${digest}`);assert.deepEqual(ledger.recipes[f.identity(pack)],f.ready(pack,'customer-one'));
    const states=f.checkpoints.map(s=>s.recipes[f.identity(pack)]).filter(Boolean);assert(states.some(s=>s.status==='pending'&&!s.candidateDigest));assert(states.some(s=>s.status==='pending'&&s.candidateDigest===digest));assert.equal(states.at(-1).status,'ready');}
  assert.equal((await stat(join(f.directory,'image-ledger.json'))).mode&0o777,0o600);
  assert.equal(f.calls.filter(c=>c.kind==='wrangler').length,11);
  for(const c of f.calls.filter(c=>c.kind!=='wrangler')){assert.equal(c.options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(c.options.env.OPENCODE_GO_API_KEY,undefined);assert.equal(c.options.env.AWS_SECRET_ACCESS_KEY,undefined);}
  const build=f.calls.find(c=>c.kind==='node'||c.kind===process.execPath);assert.equal(basename(build.options.env.REGCTL),'regctl');assert.equal(basename(build.options.env.PATH.split(':')[0]),'bin');
  assert(!JSON.stringify(f.logs).includes('private'));assert.equal((await readdir(f.directory)).some(name=>name.startsWith('package-images-')),false);
  for(const name of ['image','base','image-root','recon-layer.tar','downloads','pack-downloads'])await assert.rejects(stat(join(f.tools,'.cache',name)),{code:'ENOENT'});
});

// Catches replacing known image bytes with another instance's new repository.
test('same-account ready cache reuses the recorded full image reference across instances',async t=>{
  const f=await fixture(t);await f.seed();const images=await f.prepare({config:{accountId,instance:'customer-two'}});
  assert.equal(f.builds.length,0);assert.equal(f.preparations.length,11);assert.equal(images.http,`registry.cloudflare.com/${accountId}/previous-one-http@${digest}`);
});

// Catches adopting foreign cache state before the account mutates anything.
test('foreign-account cache is rejected before registry credentials or native preparation',async t=>{
  const f=await fixture(t);await f.seed(s=>{s.accountId='d'.repeat(32);});await assert.rejects(f.prepare(),/account/i);
  assert.equal(f.calls.filter(c=>c.kind==='wrangler').length,0);assert.equal(f.builds.length,0);assert.equal(f.preparations.length,0);
});

// Catches silent adoption of an invalid/missing ready image and rebuilt candidates.
for(const mutation of ['foreign image','changed digest','wrong recipe','missing image','missing registry manifest','changed manifest'])test('ready cache refuses '+mutation,async t=>{
  const f=await fixture(t);await f.seed(s=>{const r=s.recipes[f.identity('http')];if(mutation==='foreign image')r.image=r.image.replace(accountId,'d'.repeat(32));if(mutation==='changed digest')r.digest='sha256:'+'e'.repeat(64);if(mutation==='wrong recipe')r.sourceCommit='e'.repeat(40);if(mutation==='missing image')delete r.image;});
  if(mutation==='missing registry manifest')f.registry.clear();if(mutation==='changed manifest')f.registry.set(f.ready('http').image,Buffer.from('changed'));
  const reasons={'foreign image':/selected-account reference/,'changed digest':/immutable digest/,'wrong recipe':/expected recipe/,'missing image':/selected-account reference/,'missing registry manifest':/manifest missing/,'changed manifest':/Existing pack manifest changed/};
  await assert.rejects(f.prepare(),reasons[mutation]);assert.equal(f.builds.length,0);assert.equal(f.preparations.length,0);
});

// Catches losing the first candidate when the second interrupted build emits new bytes.
test('interrupted copies retain their first candidate digest on every retry',async t=>{
  const f=await fixture(t);f.copyFailure=true;await assert.rejects(f.prepare(),/interrupted/);
  const first=(await f.readLedger()).recipes[f.identity('http')];assert.equal(first.status,'pending');assert.equal(first.candidateDigest,digest);
  await assert.rejects(f.prepare(),/interrupted/);assert.equal((await f.readLedger()).recipes[f.identity('http')].candidateDigest,digest);
  f.manifestBytes=Buffer.from('different deterministic image');await assert.rejects(f.prepare(),/different bytes|candidate digest/i);assert.equal((await f.readLedger()).recipes[f.identity('http')].candidateDigest,digest);
});

// Catches late preflight checks after another pack already mutated the registry.
for(const prerequisite of ['Go','Python','archive','SDK lock'])test('preflight rejects '+prerequisite+' before registry, build, or preparation mutations',async t=>{
  const f=await fixture(t);if(prerequisite==='Go')f.goVersion='go1.25.0';if(prerequisite==='Python')f.pythonVersion='Python 3.10.9';if(prerequisite==='archive')f.tarVersion='tar (GNU tar) 1.35';if(prerequisite==='SDK lock')await writeFile(join(f.root,'node_modules/@memrov2/pentcloud-metasploit/tools.lock.json'),'{}');
  await assert.rejects(f.prepare(),prerequisite==='SDK lock'?/SDK lock/:/Go|Python|bsdtar|archive/i);
  assert.equal(f.calls.filter(c=>c.kind==='wrangler').length,0);assert.equal(f.builds.length,0);assert.equal(f.preparations.length,0);
});

// Catches trusting an existing checkout with a different SHA.
test('existing source checkout must match the reviewed commit',async t=>{
  const f=await fixture(t);f.head='e'.repeat(40);await assert.rejects(f.prepare(),/commit|checkout/i);assert.equal(f.calls.filter(c=>c.kind==='wrangler').length,0);
});

// Catches cloning through a shell/credentialed Git environment or unpinned checkout.
test('missing source is cloned publicly, pinned, and retained without operator credentials',async t=>{
  const f=await fixture(t,{withTools:false});await f.prepare();const clone=f.calls.find(c=>c.args.includes('clone'));
  assert(clone);assert.equal(basename(clone.kind),'git');assert(clone.args.includes('https://github.com/Memrov/PentCloud-tools.git'));assert.equal(clone.args.at(-1),join(await realpath(f.directory),'tools-source-'+commit));
  assert.equal(clone.options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(clone.options.env.OPENCODE_GO_API_KEY,undefined);assert.equal(clone.options.env.GIT_TERMINAL_PROMPT,'0');assert.notEqual(clone.options.env.GIT_CONFIG_VALUE_0,'dangerous');
  assert(f.calls.some(c=>c.args.includes('checkout')&&c.args.includes(commit)));await stat(join(f.directory,'tools-source-'+commit,'tools.lock.json'));
});
test('a later reviewed tools commit gets a separate managed checkout without rewriting older source',async t=>{
  const f=await fixture(t,{withTools:false}),old=join(f.directory,'tools-source-'+'e'.repeat(40));
  await mkdir(old);await writeFile(join(old,'retained.txt'),'older reviewed checkout');await f.seed();await f.prepare();
  assert.equal(await readFile(join(old,'retained.txt'),'utf8'),'older reviewed checkout');
  const managed=join(await realpath(f.directory),'tools-source-'+commit);assert(f.calls.some(c=>c.args.includes('clone')&&c.args.at(-1)===managed));
});

// Catches requiring GNU tar or mutating a global installation when system tar is BSD tar.
test('BSD system tar is selected through a disposable local PATH shim',async t=>{
  const f=await fixture(t,{tarName:'tar'});await f.seed();await f.prepare();assert(f.calls.some(c=>basename(c.kind)==='tar'&&c.args.includes('--version')));
});

// Catches a hardcoded Linux/x64 regctl fetch on another supported host.
test('OCI client selection follows the host platform and verifies its release checksum',async t=>{
  const f=await fixture(t);await f.seed();await f.prepare();assert.equal(f.downloads[0],`https://github.com/regclient/regclient/releases/download/v0.9.0/regctl-${regctlPlatform()}`);
  assert.equal(regctlPlatform('linux','x64'),'linux-amd64');assert.equal(regctlPlatform('darwin','arm64'),'darwin-arm64');assert.throws(()=>regctlPlatform('win32','x64'),/supports/);
  await assert.rejects(f.prepare({fetcher:async()=>({ok:true,arrayBuffer:async()=>Buffer.from('untrusted download')})}),/checksum/i);
});
test('a mismatched downloaded executable cannot reach credentials, execution, or image preparation',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.prepare({fetcher:async()=>({ok:true,arrayBuffer:async()=>Buffer.from('altered upstream executable')})}),/checksum/i);
  assert.equal(f.calls.some(call=>call.kind==='wrangler'||basename(call.kind)==='regctl'||call.kind==='node'),false);
  assert.equal(f.preparations.length,0);assert.equal(f.builds.length,0);
  assert.equal((await readdir(f.directory)).some(name=>name.startsWith('package-images-')),false);
});

test('failed checkpoint stops before image build or upload',async t=>{
  const f=await fixture(t);await assert.rejects(f.prepare({checkpoint:async()=>{throw Error('checkpoint unavailable');}}),/checkpoint unavailable/);assert.equal(f.builds.length,0);assert.equal(f.preparations.length,0);
});

// Catches falsely marking a manifest ready when Cloudflare native preparation fails.
test('native preparation failure retains the candidate and removes disposable files',async t=>{
  const f=await fixture(t);f.preparationResult={status:'failed'};await assert.rejects(f.prepare(),/preparation failed/);
  const record=(await f.readLedger()).recipes[f.identity('http')];assert.equal(record.status,'pending');assert.equal(record.candidateDigest,digest);
  assert.equal((await readdir(f.directory)).some(name=>name.startsWith('package-images-')),false);
  await assert.rejects(stat(join(f.tools,'.cache/packs/http')),{code:'ENOENT'});
});

// Catches using a shared/global Go build cache, leaving build data behind, or changing the tar shim target.
test('builders use only validated executables and disposable private Go caches',async t=>{
  const f=await fixture(t),runner=f.run;
  f.run=async(kind,args,options={})=>{
    if(kind==='node'){
      assert.equal(await realpath(join(options.env.PATH.split(':')[0],'tar')),await realpath(join(f.bin,'bsdtar')));
      assert.equal(await realpath(join(options.env.PATH.split(':')[0],'go')),await realpath(join(f.bin,'go')));
      assert.equal(options.env.GOTOOLCHAIN,'local');
      assert(options.env.GOCACHE?.startsWith(await realpath(f.directory)),'Go cache must be private and disposable');
      assert(options.env.GOMODCACHE?.startsWith(await realpath(f.directory)),'Go module cache must be private and disposable');
      await mkdir(options.env.GOCACHE,{recursive:true});await writeFile(join(options.env.GOCACHE,'compiled-build-data'),'discard');
    }
    if(args[0]==='registry'){
      const auth=join(options.env.DOCKER_CONFIG,'config.json');assert.equal((await stat(auth)).mode&0o777,0o600);
    }
    return runner(kind,args,options);
  };
  await f.prepare();
  assert.equal((await readdir(f.directory)).some(name=>name.startsWith('package-images-')),false);
});

test('malformed credential output is rejected without including private response bytes',async t=>{
  const f=await fixture(t),runner=f.run;
  f.run=async(kind,args,options)=>kind==='wrangler'?Buffer.from('PRIVACYMARK-fixture-private-credential'):runner(kind,args,options);
  await assert.rejects(f.prepare(),error=>!error.message.includes('PRIVACYMARK')&&/private JSON/.test(error.message));
});

// Catches treating a pending native image as ready or skipping its readiness poll.
test('native preparation polls pending images before saving ready ownership',async t=>{
  const f=await fixture(t);await f.seed();t.mock.timers.enable({apis:['setTimeout']});
  let signalPending;const pending=new Promise(resolve=>{signalPending=resolve;});let attempts=0;
  f.api={request:async(_path,options)=>{f.preparations.push(options.body.image);if(++attempts===1){signalPending();return {status:'pending'};}return {status:'ready'};}};
  const preparing=f.prepare();await pending;await new Promise(setImmediate);
  assert.equal(attempts,1);t.mock.timers.tick(15_000);const images=await preparing;
  assert.equal(images.http,`registry.cloudflare.com/${accountId}/previous-one-http@${digest}`);assert.equal(attempts,12);
});
