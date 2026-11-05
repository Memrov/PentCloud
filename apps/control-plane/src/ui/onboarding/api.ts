import { APIError, parseRun, parseJob, type UIRun, type UIJob } from "../api";
import type { SavedTarget, CredentialMetadata, SetupDraft } from "../../native/onboarding";
import type { OpenCodeModel } from "../../native/opencode-models";
export interface OnboardingSnapshot {
  sourceImports?:{requestId:string;targetId:string;revision:number;repo:string;url:string;branch?:string;replaceId?:string}[];
  targets:SavedTarget[];credentials:CredentialMetadata[];defaults:{targetId:string;draft:SetupDraft}[];
  checks?:{targetId:string;status:number;classification:string;checkedAt:number}[];
  definition?:{version:number;name:string;sha256:string};
  run?:UIRun;draft?:SetupDraft;discovery?:UIJob[];apiTested?:boolean;
  readiness?:{modelsTested:boolean;apiTested:boolean;discoverySettled:boolean};
}
export async function setupRequest<T>(path:string,body?:unknown,fetcher:typeof fetch=fetch):Promise<T> {
  const response=await fetcher("/v1/ui"+path,{cache:"no-store",...(body!==undefined?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
  const value=await response.json().catch(()=>null) as {error?:unknown}|null;
  if(!response.ok)throw new APIError(response.status,typeof value?.error==="string"?value.error:"Setup request failed");
  return value as T;
}
export const snapshot=(runId?:string)=>setupRequest<OnboardingSnapshot>("/onboarding"+(runId?"?run="+encodeURIComponent(runId):""));
export const action=<T=unknown>(name:string,body:unknown)=>setupRequest<T>("/onboarding/"+name,body);
export async function catalogs(refresh=false,fetcher:typeof fetch=fetch) {
  const settled=await Promise.allSettled((["go","console"] as const).map(route=>setupRequest<{models:OpenCodeModel[];fetchedAt:string;stale:boolean}>("/settings/models?route="+route+(refresh?"&refresh=1":""),undefined,fetcher)));
  const results=settled.filter((r):r is PromiseFulfilledResult<{models:OpenCodeModel[];fetchedAt:string;stale:boolean}>=>r.status==="fulfilled").map(r=>r.value);
  const failures=settled.filter((r):r is PromiseRejectedResult=>r.status==="rejected").map(r=>r.reason instanceof Error?r.reason.message:"OpenCode catalog unavailable");
  if(!results.length)throw new Error(failures.join("; "));
  return {models:results.flatMap(c=>c.models),stale:results.length<2||results.some(c=>c.stale),fetchedAt:results.map(c=>c.fetchedAt),failures};
}
export function canActivate(value:OnboardingSnapshot):boolean {
  return ["discovery","setup"].includes(value.run?.phase??"")&&value.readiness?.modelsTested===true&&value.readiness.apiTested===true;
}
export async function activate(runId:string,revision:number,requestId:string,acknowledgeFailure:boolean,definitionVersion=0) {
  const value=await setupRequest<{run:unknown;rootJob:unknown}>("/runs/"+encodeURIComponent(runId)+"/analysis",{revision,requestId,acknowledgeFailure,definitionVersion});
  return {run:parseRun(value.run),rootJob:parseJob(value.rootJob)};
}
