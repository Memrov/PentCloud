// Cooperative local locks only: remote uncertain-operation receipts remain authoritative.
import {mkdir,chmod,lstat,open,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const sameInode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const integer=value=>Number.isSafeInteger(value)&&value>0&&value<=2147483647;
const valid=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join(',')==='host,nonce,pgid,pid,schemaVersion'&&value.schemaVersion===1&&
  integer(value.pid)&&integer(value.pgid)&&typeof value.host==='string'&&value.host.length>0&&value.host.length<=255&&!/[\x00-\x20\x7f]/.test(value.host)&&
  typeof value.nonce==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.nonce);
function groupId(fail){
  if(!['darwin','linux'].includes(process.platform))throw fail();
  const result=spawnSync('/bin/ps',['-o','pgid=','-p',String(process.pid)],{
    env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','ignore'],encoding:'utf8',timeout:5000,maxBuffer:1024,
  });
  const text=result.stdout?.trim();if(result.error||result.status!==0||!/^\d+$/.test(text??'')||!integer(Number(text)))throw fail();
  return Number(text);
}
function absent(pid){try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}}

export async function withPrivateLock(directory,callback,{code='PC_OPERATION_LOCKED'}={}){
  const fail=()=>Object.assign(Error(code+': operation.lock requires private reconciliation'),{code});
  await mkdir(directory,{recursive:true,mode:0o700});
  if((await lstat(directory)).isSymbolicLink())throw fail();
  await chmod(directory,0o700);
  const path=join(directory,'operation.lock'),guardPath=path+'.recovery';
  const prerequisite=()=>Object.assign(Error('PC_LOCK_PREREQUISITE'),{code:'PC_LOCK_PREREQUISITE'});
  const owner={schemaVersion:1,pid:process.pid,pgid:groupId(prerequisite),host:hostname(),nonce:randomUUID()};
  if(!valid(owner))throw prerequisite();
  async function snapshot(file,validate=true){
    let handle;
    try{
      const entry=await lstat(file,{bigint:true});
      if(!entry.isFile()||entry.nlink!==1n||entry.size>4096n||(entry.mode&0o077n)!==0n)throw fail();
      handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      const identity=await handle.stat({bigint:true});if(!sameInode(entry,identity))throw fail();
      const bytes=await handle.readFile('utf8');
      if(!sameInode(identity,await lstat(file,{bigint:true})))throw fail();
      let record;if(validate){try{record=JSON.parse(bytes);}catch{throw fail();}if(!valid(record))throw fail();}
      return {identity,bytes,record};
    }catch(error){if(error.code==='ENOENT')return null;throw fail();}
    finally{await handle?.close();}
  }
  async function create(file){
    const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const bytes=JSON.stringify({...owner,nonce:randomUUID()})+'\n';
    try{await handle.chmod(0o600);await handle.writeFile(bytes);await handle.sync();return {handle,bytes,identity:await handle.stat({bigint:true})};}
    catch(error){await handle.close();throw error;}
  }
  async function matches(file,claim){
    const current=await snapshot(file,false);return current&&sameInode(current.identity,claim.identity)&&current.bytes===claim.bytes;
  }
  async function release(file,claim){
    try{if(await matches(file,claim))await unlink(file);}catch{/* Preserve any replacement or unprovable ownership. */}
    finally{await claim.handle.close();}
  }
  // A recovery guard serializes stale removers. A killed guard owner requires
  // manual reconciliation; recursively breaking guards would reintroduce races.
  if(await lstat(guardPath).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw fail();}))throw fail();
  let lock;
  try{lock=await create(path);}catch(error){
    if(error.code!=='EEXIST')throw fail();
    let guard;try{guard=await create(guardPath);}catch{throw fail();}
    try{
      const stale=await snapshot(path);
      if(!stale||stale.record.host!==owner.host||!absent(stale.record.pid)||!absent(-stale.record.pgid))throw fail();
      if(!await matches(path,stale))throw fail();
      await unlink(path); // Exactly one guarded unlink; never remove a later owner.
      try{lock=await create(path);}catch{throw fail();}
    }finally{await release(guardPath,guard);}
  }
  try{return await callback();}finally{await release(path,lock);}
}
