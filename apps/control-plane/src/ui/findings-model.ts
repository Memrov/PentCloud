import {findingFilePath,parseFindings,type FindingsBundle} from '../../../../shared/findings';
import {getRunJobs,type UIJob,type UIRun} from './api';
export interface FindingSnapshot {version:1;runId:string;jobId:string;commit:string;bundle?:FindingsBundle}
export interface Assessment {run:UIRun;job:UIJob;snapshot?:FindingSnapshot;error?:string}
export const retained=(run:UIRun)=>!['trashed','purging'].includes(run.lifecycle??'active');
export const targetKey=(run:UIRun)=>run.target?'target:'+run.target.id:'run:'+run.id;
export function findingTargets(runs:readonly UIRun[]){const map=new Map<string,{key:string;label:string}>();for(const r of runs.filter(retained)){const key=targetKey(r);if(!map.has(key))map.set(key,{key,label:r.target?`${r.target.name} · ${r.target.url}`:`Legacy assessment · ${r.id}`});}return [...map.values()];}
export function latestReporters(jobs:readonly UIJob[]):UIJob[]{const map=new Map<string,UIJob>();for(const j of jobs){if(j.role!=='reporter'||j.status!=='completed'||!j.outputCommit)continue;const key=j.logicalThreadId??j.id,prior=map.get(key);if(!prior||(j.attempt??1)>(prior.attempt??1))map.set(key,j);}return [...map.values()];}
export function parseFindingSnapshot(value:unknown,runId:string,jobId:string,commit:string):FindingSnapshot {
 const x=value as Record<string,unknown>|null;if(!x||x.version!==1||x.runId!==runId||x.jobId!==jobId||x.commit!==commit||!/^[a-f0-9]{40}$/.test(commit))throw new Error('Findings provenance does not match the accepted assessment');
 if(x.bundle===undefined)return {version:1,runId,jobId,commit};
 const bundle=x.bundle as FindingsBundle,document=parseFindings(bundle?.document);
 if(!Array.isArray(bundle.files)||bundle.files.length>2000)throw new Error('Invalid finding files');
 const files=bundle.files.map(f=>{const path=findingFilePath(f.path);if(!Number.isSafeInteger(f.size)||f.size<0)throw new Error('Invalid finding file size');return {path,size:f.size};});
 const paths=new Set(files.map(f=>f.path));if([document.reportPath,...document.findings.flatMap(f=>f.evidencePaths)].some(path=>!paths.has(path)))throw new Error('Incomplete finding file references');
 return {version:1,runId,jobId,commit,bundle:{document,files}};
}
/** Bounded concurrency; results stay associated with the captured source target/run. */
export async function loadAssessments(runs:readonly UIRun[]):Promise<{assessments:Assessment[];errors:string[]}>{
 const assessments:Assessment[]=[],errors:string[]=[];const fetcher=fetch;let next=0;
 await Promise.all(Array.from({length:Math.min(3,runs.length)},async()=>{while(next<runs.length){const run=runs[next++]!;try{const snapshot=await getRunJobs(run.id);if(snapshot.run.id!==run.id||targetKey(snapshot.run)!==targetKey(run)||snapshot.jobs.some(j=>j.runId!==run.id))throw new Error("Assessment provenance mismatch");for(const job of latestReporters(snapshot.jobs)){try{const response=await fetcher(`/v1/ui/runs/${encodeURIComponent(run.id)}/findings?job=${encodeURIComponent(job.id)}`,{cache:'no-store'});if(!response.ok)throw new Error(`Findings unavailable (HTTP ${response.status})`);assessments.push({run,job,snapshot:parseFindingSnapshot(await response.json(),run.id,job.id,job.outputCommit!)});}catch(error){assessments.push({run,job,error:error instanceof Error?error.message:'Findings unavailable'});}}}catch(error){errors.push(`${run.id}: ${error instanceof Error?error.message:'Assessment unavailable'}`);}}}));
 return {assessments:assessments.sort((a,b)=>a.run.id.localeCompare(b.run.id)||a.job.id.localeCompare(b.job.id)),errors};
}
