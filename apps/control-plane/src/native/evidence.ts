import {identifier} from "./domain";
export const EVIDENCE_TOTAL_LIMIT=16*1024*1024;
export const EVIDENCE_FILE_LIMIT=2*1024*1024;
export interface EvidenceFile {path:string;size:number;sha256:string;tool:string;receiptId:string;generation?:string;source:string;kaliPath?:string;sourceSha256?:string}
export interface EvidenceManifest {version:1;runId:string;jobId:string;inputCommit:string;promptDigest:string;sequence:number;files:EvidenceFile[];unavailable?:Array<{tool:string;receiptId:string;reason:string}>}
export interface EvidenceCheckpoint {commit:string;parentCommit:string;manifestPath:string;manifestDigest:string;sequence:number}
interface EvidenceRepo {
 readCommit(commit:string):Promise<{parents:string[];treeHash:string}|null>;
 readTree(tree:string):Promise<Array<{name:string;type:string;hash:string}>|null>;
 readFile(input:{ref:string;path:string}):Promise<Blob|null>;
}
export function evidenceRoot(id:string){return `.pentagi/evidence/${identifier(id)}`;}
export function evidenceManifestPath(id:string){return `${evidenceRoot(id)}/manifest.json`;}
/** Only exact output references from an operation result, never arbitrary roots. */
export function stockOutputPaths(family:string,result:unknown):string[]{
 const root=`/opt/kali-mcp/output/${family}/`,found=new Set<string>();let visited=0;
 const add=(value:string)=>{
  if(value.startsWith('../opt/kali-mcp/output/'))value=value.slice(2);
  try{value=decodeURIComponent(value);}catch{return;}
  if(value.startsWith(root)&&value.length<=512&&!/[\\\x00-\x1f\x7f]/.test(value)&&!value.slice(root.length).split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))found.add(value);
 };
 const walk=(value:unknown,depth=0):void=>{
  if(depth>8||++visited>2048)return;
  if(typeof value==='string'){
   add(value);
   if(value.length<=EVIDENCE_FILE_LIMIT){
    for(const match of value.matchAll(/\]\(([^\s)]+)\)/g))add(match[1]!);
    if(/^[\[{]/.test(value))try{walk(JSON.parse(value),depth+1);}catch{}
   }
  }
  else if(Array.isArray(value))for(const item of value)walk(item,depth+1);
  else if(value&&typeof value==='object')for(const item of Object.values(value))walk(item,depth+1);
 };
 walk(result);return [...found].slice(0,64);
}
export async function evidenceBytesHash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes))),v=>v.toString(16).padStart(2,"0")).join("");}
export async function boundedEvidenceBytes(response:Response,maximum=EVIDENCE_FILE_LIMIT):Promise<Uint8Array>{
 if(!response.body)throw new Error("Evidence body is unavailable");
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maximum)throw new Error("Evidence exceeds file limit");chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
/** Checkpoints contain only immutable own-job evidence, never terminal authority. */
export async function validateEvidenceCheckpoint(repo:EvidenceRepo,scope:{id:string;runId:string;inputCommit:string;promptDigest?:string},receipt:EvidenceCheckpoint,prior?:EvidenceCheckpoint):Promise<EvidenceManifest>{
 const root=evidenceRoot(scope.id),manifestPath=evidenceManifestPath(scope.id);
 if(!receipt||!/^[a-f0-9]{40}$/.test(receipt.commit)||receipt.parentCommit!==(prior?.commit??scope.inputCommit)||receipt.manifestPath!==manifestPath||!/^[a-f0-9]{64}$/.test(receipt.manifestDigest)||receipt.sequence!==(prior?.sequence??0)+1||receipt.sequence>128)throw new Error("400: Invalid evidence checkpoint lineage");
 const [current,parent,blob]=await Promise.all([repo.readCommit(receipt.commit),repo.readCommit(receipt.parentCommit),repo.readFile({ref:receipt.commit,path:manifestPath})]);
 if(!current||!parent||current.parents.length!==1||current.parents[0]!==receipt.parentCommit||!blob||blob.size>65536)throw new Error("400: Evidence checkpoint is unavailable");
 const raw=new Uint8Array(await blob.arrayBuffer());if(await evidenceBytesHash(raw)!==receipt.manifestDigest)throw new Error("400: Evidence manifest digest changed");
 const m=JSON.parse(new TextDecoder().decode(raw)) as EvidenceManifest;
 if(m.version!==1||m.runId!==scope.runId||m.jobId!==scope.id||m.inputCommit!==scope.inputCommit||m.sequence!==receipt.sequence||!/^[a-f0-9]{64}$/.test(m.promptDigest)||(scope.promptDigest!==undefined&&m.promptDigest!==scope.promptDigest)||!Array.isArray(m.files)||m.files.length>64)throw new Error("400: Evidence manifest provenance mismatch");
 if(m.unavailable!==undefined&&(!Array.isArray(m.unavailable)||m.unavailable.length>64||m.unavailable.some(x=>!x||[x.tool,x.receiptId,x.reason].some(v=>typeof v!=="string"||v.length>1024))))throw new Error("400: Invalid evidence collection notes");
 if(prior){
  const previous=await repo.readFile({ref:prior.commit,path:prior.manifestPath});
  if(!previous||previous.size>65536)throw new Error("400: Prior evidence manifest unavailable");
  const old=JSON.parse(await previous.text()) as EvidenceManifest;
  if(old.files.some(f=>!m.files.some(next=>next.path===f.path&&next.sha256===f.sha256&&next.size===f.size)))throw new Error("400: Checkpoint removed or modified prior evidence");
 }
 const paths=new Set<string>();let size=0;
 for(const f of m.files){
  if(typeof f.path!=="string"||!f.path.startsWith(root+"/")||f.path===manifestPath||f.path.length>768||f.path.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git')||/[\\\x00-\x1f\x7f]/.test(f.path)||paths.has(f.path)||!Number.isSafeInteger(f.size)||f.size<0||f.size>EVIDENCE_FILE_LIMIT||!/^[a-f0-9]{64}$/.test(f.sha256))throw new Error("400: Invalid evidence file");
  paths.add(f.path);size+=f.size;if(size>EVIDENCE_TOTAL_LIMIT)throw new Error("400: Evidence set exceeds limit");
  const file=await repo.readFile({ref:receipt.commit,path:f.path});if(!file||file.size!==f.size||await evidenceBytesHash(new Uint8Array(await file.arrayBuffer()))!==f.sha256)throw new Error("400: Evidence file bytes changed");
 }
 const expected=new Set([...paths,manifestPath]);
 async function ownTree(tree:string,prefix:string,depth=0):Promise<void>{
  if(depth>8)throw new Error("400: Evidence tree exceeds depth");const entries=await repo.readTree(tree);if(!entries)throw new Error("400: Evidence tree missing");
  for(const entry of entries){const path=`${prefix}/${entry.name}`;if(entry.type==='tree')await ownTree(entry.hash,path,depth+1);else if(!['blob','exec'].includes(entry.type)||!expected.delete(path))throw new Error("400: Unlisted evidence file");}
 }
 async function compare(before:string|undefined,after:string|undefined,prefix=''):Promise<void>{
  if(before===after)return;
  if(prefix===root){if(!after)throw new Error("400: Evidence removed");await ownTree(after,prefix);return;}
  const [a,b]=await Promise.all([before?repo.readTree(before):Promise.resolve([]),after?repo.readTree(after):Promise.resolve([])]);if(!a||!b)throw new Error("400: Evidence tree missing");
  const left=new Map(a.map(e=>[e.name,e])),right=new Map(b.map(e=>[e.name,e]));
  for(const name of new Set([...left.keys(),...right.keys()])){
   const x=left.get(name),y=right.get(name);if(x?.hash===y?.hash&&x?.type===y?.type)continue;
   const path=prefix?`${prefix}/${name}`:name;
   if(!root.startsWith(path+'/')&&path!==root||x&&x.type!=='tree'||y&&y.type!=='tree')throw new Error("400: Checkpoint changed non-evidence files");
   await compare(x?.hash,y?.hash,path);
  }
 }
 await compare(parent.treeHash,current.treeHash);if(expected.size)throw new Error("400: Evidence tree did not include manifest files");return m;
}
export async function assertEvidencePreserved(repo:Pick<EvidenceRepo,"readFile">,commit:string,receipt:EvidenceCheckpoint,files:EvidenceFile[]):Promise<void>{
 const manifest=await repo.readFile({ref:commit,path:receipt.manifestPath});
 if(!manifest||manifest.size>65536||await evidenceBytesHash(new Uint8Array(await manifest.arrayBuffer()))!==receipt.manifestDigest)throw new Error("400: Captured evidence manifest was modified");
 for(const file of files){const blob=await repo.readFile({ref:commit,path:file.path});if(!blob||blob.size!==file.size||await evidenceBytesHash(new Uint8Array(await blob.arrayBuffer()))!==file.sha256)throw new Error("400: Captured evidence bytes were modified");}
}
