import {DeleteResource} from "@cloudflare/kumo";
import {useEffect,useState} from "react";
import {permanentlyDeleteRun} from "../api";

export const runDeletionDescription="Delete a run to remove its chats, reports, findings, attachments, evidence and Git history. Saved targets and settings stay. The target application is unchanged. Shared scanner scratch is cleared once no other run is active.";

export function RunDeleteDialog({runId,open,onOpenChange,onDeleted}:{runId:string;open:boolean;onOpenChange:(open:boolean)=>void;onDeleted:(id:string)=>void}){
  const [pending,setPending]=useState(false),[error,setError]=useState<string>();
  useEffect(()=>{if(open)setError(undefined);},[open,runId]);
  const remove=async()=>{
    if(pending)return;
    setPending(true);setError(undefined);
    try{await permanentlyDeleteRun(runId);onDeleted(runId);onOpenChange(false);}
    catch(caught){setError(caught instanceof Error?caught.message:"Could not delete run");}
    finally{setPending(false);}
  };
  return <DeleteResource open={open} onOpenChange={value=>{if(!pending)onOpenChange(value);}} resourceType="run and all its saved data" resourceName={runId} onDelete={remove} isDeleting={pending} caseSensitive deleteButtonText="Permanently delete run" className="break-words" {...(error?{errorMessage:error}:{})}/>;
}
