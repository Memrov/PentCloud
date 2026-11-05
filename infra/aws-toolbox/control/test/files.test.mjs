import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,mkdir,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
const require=createRequire(new URL('../../../../apps/control-plane/package.json',import.meta.url));
const {build}=require('esbuild');
const compiled=await build({entryPoints:[new URL('../src/worker.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',target:'es2023',plugins:[{name:'native',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'native',namespace:'native'}));b.onLoad({filter:/.*/,namespace:'native'},()=>({contents:'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}} export class WorkerEntrypoint extends DurableObject {}'}));}}]});
const {KaliToolbox}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text+'\n//# sourceURL=pentcloud-native-file-test.mjs').toString('base64'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const scope={generation:'generation-fixture',runId:'run-fixture',attemptId:'attempt-fixture'};
async function fixture(){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'pentcloud-transfer-'))),calls=[];let running=true;
 const pending=[];
 const container={get running(){return running},images:{},async inspect(){return running?{labels:{'pentcloud-gen':scope.generation}}:null},async setInactivityTimeout(){},start(){assert.fail('transfer must not start a Container')},async exec(argv,options={}){
  calls.push(argv);assert.equal(argv[1],'-c');
  const value=JSON.parse(argv[3]);value.root=join(directory,value.root.startsWith('/opt/kali-mcp/output/')?'stock':'workspace');
  const child=spawn('/usr/bin/python3',['-c',argv[2],JSON.stringify(value)],{stdio:['pipe','pipe','pipe']});
  if(options.stdin&&options.stdin!=='pipe')void Readable.fromWeb(options.stdin).pipe(child.stdin);else child.stdin.end();
  options.signal?.addEventListener('abort',()=>child.kill(),{once:true});
  const stdout=Readable.toWeb(child.stdout),stderr=Readable.toWeb(child.stderr),exitCode=new Promise(resolve=>child.on('exit',c=>resolve(c??1)));
  return {stdout,stderr,exitCode,kill(){child.kill()},async output(){const [o,e,c]=await Promise.all([new Response(stdout).arrayBuffer(),new Response(stderr).arrayBuffer(),exitCode]);return {stdout:o,stderr:e,exitCode:c}}};
 }};
 const ctx={container,waitUntil(p){pending.push(p)},blockConcurrencyWhile(fn){return fn()}};
 const runtime=new KaliToolbox(ctx,{KALI_MCP_TOKEN:'fixture-private-token-long-enough'});
 return {runtime,directory,calls,stop(){running=false},async close(){await Promise.allSettled(pending);await rm(directory,{recursive:true,force:true})}};
}
test('private transfer imports exact binary bytes, replays identical input and downloads them without booting',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from([0,255,10,13,128,65]),file={path:'inputs/config.bin',size:bytes.length,sha256:hash(bytes)};
  const value=await f.runtime.putFile(scope,file,new Response(bytes).body);assert.equal(value.sha256,file.sha256);assert.equal(value.path,'/work/pentcloud/run-fixture/attempt-fixture/inputs/config.bin');
  const duplicate=await f.runtime.putFile(scope,file,new Response(bytes).body);assert.equal(duplicate.sha256,value.sha256);
  const listed=await f.runtime.listFiles(scope);assert.equal(listed.files.length,1);assert.equal(listed.files[0].path,'inputs/config.bin');
  const response=await f.runtime.getFile(scope,'inputs/config.bin');assert.equal(response.status,200);assert.equal(response.headers.get('X-Content-SHA256'),file.sha256);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 }finally{await f.close()}
});
test('transfer rejects changed bytes, symlinks and invalid paths; generation loss never executes',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('original'),file={path:'inputs/config.txt',size:bytes.length,sha256:hash(bytes)};
  await f.runtime.putFile(scope,file,new Response(bytes).body);
  await assert.rejects(()=>f.runtime.putFile(scope,{...file,sha256:hash(Buffer.from('changed!'))},new Response('changed!').body));
  assert.equal(await readFile(join(f.directory,'workspace/inputs/config.txt'),'utf8'),'original');
  await mkdir(join(f.directory,'workspace/outputs'),{recursive:true});await writeFile(join(f.directory,'outside'),'private');await symlink(join(f.directory,'outside'),join(f.directory,'workspace/outputs/link'));
  await assert.rejects(()=>f.runtime.getFile(scope,'outputs/link'));
  for(const path of ['../outside','/etc/passwd','outputs/../../outside','inputs/.git/config'])await assert.rejects(()=>f.runtime.getFile(scope,path));
  const before=f.calls.length;await assert.rejects(()=>f.runtime.listFiles({...scope,generation:'different'}));f.stop();await assert.rejects(()=>f.runtime.listFiles(scope));assert.equal(f.calls.length,before);
 }finally{await f.close()}
});
test('truncated upload never becomes a completed input and a retry can finish it',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('complete input'),file={path:'inputs/retry.txt',size:bytes.length,sha256:hash(bytes)};
  await assert.rejects(()=>f.runtime.putFile(scope,file,new Response('partial').body));
  await f.runtime.putFile(scope,file,new Response(bytes).body);assert.equal(await readFile(join(f.directory,'workspace/inputs/retry.txt'),'utf8'),bytes.toString());
 }finally{await f.close()}
});
test('stock evidence accepts native eight-character scan IDs and excludes other operations',async()=>{
 const f=await fixture();try{
  const stock={family:'whatweb',scanId:'ac26cffd'},bytes=Buffer.from('{"http_status":200}');
  await mkdir(join(f.directory,'stock'),{recursive:true});
  await writeFile(join(f.directory,'stock/ac26cffd.json'),bytes);
  await writeFile(join(f.directory,'stock/81db6b96.json'),'unrelated');
  await symlink(join(f.directory,'stock/81db6b96.json'),join(f.directory,'stock/ac26cffd-link'));
  const listed=await f.runtime.listFiles(scope,stock);
  assert.deepEqual(listed.files,[{path:'ac26cffd.json',size:bytes.length,sha256:hash(bytes)}]);
  const response=await f.runtime.getFile(scope,'ac26cffd.json',stock);
  assert.equal(response.headers.get('X-Content-SHA256'),hash(bytes));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  await assert.rejects(()=>f.runtime.getFile(scope,'81db6b96.json',stock));
  for(const scanId of ['abc','../ac26cffd','ac26cffd/other'])
   await assert.rejects(()=>f.runtime.listFiles(scope,{...stock,scanId}));
 }finally{await f.close()}
});
