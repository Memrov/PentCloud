import {parseFindingSnapshot} from "../findings-model";
import {Banner,Button,Collapsible,LayerDialog,LinkButton,Loader,Select,Text} from '@cloudflare/kumo';
import {DownloadSimpleIcon,FileTextIcon,PrinterIcon} from '@phosphor-icons/react';
import {useEffect,useState} from 'react';
import {reportDownloadUrl,type UIJob} from '../api';
import {listRunFiles,materialFileURL,type RunFile} from '../materials-api';
import {readReportFile,readReportText,referencedReport,reportCandidates} from '../report-model';
import {ChatMarkdown} from './chat-markdown';

export function ReportButton({runId,jobs,verifiedFile,label="Open report"}:{runId:string;jobs:UIJob[];verifiedFile?:RunFile|undefined;label?:string}){
 const [open,setOpen]=useState(false);
 const reporter=jobs.filter(j=>j.runId===runId&&j.role==='reporter'&&j.status==='completed'&&j.outputCommit).sort((a,b)=>(b.conversationOrder??0)-(a.conversationOrder??0)||(b.attempt??1)-(a.attempt??1))[0];
 if(!reporter)return null;
 return <><Button variant="secondary" icon={<FileTextIcon size={15}/>} onClick={()=>setOpen(true)}>{label}</Button><ReportReader key={`${runId}:${reporter.id}:${reporter.outputCommit}`} runId={runId} reporter={reporter} verifiedFile={verifiedFile} open={open} onOpenChange={setOpen}/></>;
}
function ReportReader({runId,reporter,verifiedFile,open,onOpenChange}:{runId:string;reporter:UIJob;verifiedFile?:RunFile|undefined;open:boolean;onOpenChange:(value:boolean)=>void}){
 const [files,setFiles]=useState<RunFile[]>([]),[notes,setNotes]=useState(''),[selected,setSelected]=useState(''),[body,setBody]=useState<string>(),[error,setError]=useState<string>(),[loading,setLoading]=useState(false),[reading,setReading]=useState(false),[retry,setRetry]=useState(0),[canonical,setCanonical]=useState(false);
 const file=files.find(f=>f.path===selected);
 useEffect(()=>{
  if(!open)return;
  let live=true;setLoading(true);setReading(false);setError(undefined);setBody(undefined);setFiles([]);setNotes('');setSelected('');
  const reportFiles=async()=>{
   if(verifiedFile)return {runId,commit:verifiedFile.commit,files:[verifiedFile],canonical:true};
   const response=await fetch(`/v1/ui/runs/${encodeURIComponent(runId)}/findings?job=${encodeURIComponent(reporter.id)}`,{cache:'no-store'});
   if(response.status!==404){
    if(!response.ok)throw new Error(`Accepted findings unavailable (HTTP ${response.status})`);
    const snapshot=parseFindingSnapshot(await response.json(),runId,reporter.id,reporter.outputCommit!),bundle=snapshot.bundle;
    if(bundle){const descriptor=bundle.files.find(f=>f.path===bundle.document.reportPath)!;const file:RunFile={...descriptor,name:descriptor.path.split('/').at(-1)!,kind:'report',previewable:true,mediaType:'text/markdown',commit:snapshot.commit};return {runId,commit:snapshot.commit,files:[file],canonical:true};}
   }
   return {...await listRunFiles(runId,reporter.id),canonical:false};
  };
  void Promise.all([reportFiles(),fetch(reportDownloadUrl(runId,reporter.id),{cache:'no-store'}).then(async response=>{if(response.headers.get('X-Source-Commit')!==reporter.outputCommit)throw new Error('Reviewer notes do not match the accepted report commit.');return readReportText(response);})]).then(([snapshot,notes])=>{
   if(!live)return;if(snapshot.commit!==reporter.outputCommit)throw new Error('Report files do not match the accepted reporter commit.');
   const candidates=reportCandidates(snapshot.files);setFiles(candidates);setNotes(notes);setCanonical(snapshot.canonical);setSelected(snapshot.canonical?candidates[0]?.path??'':referencedReport(candidates,notes)?.path??'');
  }).catch(caught=>{if(live)setError(caught instanceof Error?caught.message:'Report unavailable');}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};
 },[open,runId,reporter.id,reporter.outputCommit,verifiedFile?.path,verifiedFile?.commit,retry]);
 useEffect(()=>{
  if(!open){setReading(false);return;}
  setBody(undefined);if(!file){setReading(false);return;}
  let live=true;setReading(true);setError(undefined);
  void readReportFile(runId,file).then(text=>{if(live)setBody(text);}).catch(caught=>{if(live)setError(caught instanceof Error?caught.message:'Report file unavailable');}).finally(()=>{if(live)setReading(false);});
  return()=>{live=false;};
 },[open,runId,file]);
 return <LayerDialog.Root open={open} onOpenChange={onOpenChange}><LayerDialog.Content size="xl" closeLabel="Close report">
  <LayerDialog.Title>{canonical?"Security assessment report":"Assessment files"}</LayerDialog.Title>
  <LayerDialog.Description>Accepted files and separate reviewer notes. Review sensitive evidence before sharing.</LayerDialog.Description>
  <LayerDialog.Body><div className="report-reader grid min-w-0 gap-4 text-base">
  {!loading&&!canonical&&<Banner variant="secondary" title="Legacy assessment" description="This assessment has no canonical report index. Choose a file below; evidence files and repository documentation may also appear."/>}
  <div className="report-reader-controls">{files.length>0&&!canonical&&<Select label="Assessment file" placeholder="Choose the assessment document" value={selected} onValueChange={value=>setSelected(String(value??''))}>{files.map(f=><Select.Option key={f.path} value={f.path}>{f.path}</Select.Option>)}</Select>}
   <div className="report-reader-actions">{file&&body!==undefined&&<><LinkButton variant="secondary" className="material-download" href={materialFileURL(runId,file)} download={file.name}><DownloadSimpleIcon size={16}/>Markdown</LinkButton><Button variant="secondary" icon={<PrinterIcon size={16}/>} onClick={()=>window.print()}>Print / Save as PDF</Button></>}</div>
  </div>
  {(loading||reading)&&<div className="report-loading" role="status"><Loader size="sm"/>{loading?'Loading accepted report files…':'Opening assessment…'}</div>}
  {error&&<Banner variant="error" role="alert" description={error} action={<Button variant="secondary" onClick={()=>setRetry(v=>v+1)}>Retry</Button>}/>}
  {!loading&&!error&&!selected&&<p className="report-selection-note">{files.length?'Choose the assessment file. Reviewer notes do not identify one unambiguous document.':'No readable Markdown assessment file was found at this accepted commit. Inspect the run Files for other deliverables.'}</p>}
  {file&&body!==undefined&&<article className="assessment-document"><header className="report-source"><h1>Security assessment report</h1><p>{file.path}</p><p>Run {runId} · Accepted commit <code>{file.commit}</code></p><p>Private assessment · Evidence may contain sensitive information.</p></header><div className="prose-block"><ChatMarkdown>{body}</ChatMarkdown></div></article>}
  {!loading&&notes&&<Collapsible className="report-reviewer-notes"><Collapsible.DefaultTrigger>Reviewer notes</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><Text variant="secondary">These verify the deliverable; they are separate from the assessment document.</Text><ChatMarkdown>{notes}</ChatMarkdown><LinkButton variant="secondary" href={reportDownloadUrl(runId,reporter.id)} download>Download reviewer notes</LinkButton></Collapsible.DefaultPanel></Collapsible>}
 </div></LayerDialog.Body></LayerDialog.Content></LayerDialog.Root>;
}
