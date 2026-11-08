import { digest, identifier, canonical } from "./domain";
import { boundedText, checkAddress, normalizeTargetURL, type AddressCheck } from "./target-check";
import { operatorIdentityHeader, targetHeaders } from "./target-headers";
import { normalizeCatalog, type OpenCodeRoute, type OpenCodeModel, type PinnedModel } from "./opencode-models";
import type {SourceContext} from "./source-context";
import {validateTargetAccess,targetSecretBindings,parseTargetHeaders,resolveTargetHeaders,type TargetAccess,type ProgramScope} from "../../../../shared/target-access";
import {performTargetFetch} from "./target-fetch";
import {authenticator} from './target-verification';

import {MODEL_ROLES,type ModelRole} from "./onboarding-roles";
export {MODEL_ROLES,type ModelRole} from "./onboarding-roles";
export type ModelChoice={model:string;credentialId:string;credentialVersion:number};
export interface ModelProfile {default:ModelChoice;overrides:Partial<Record<ModelRole,ModelChoice>>}
export interface SavedTarget {
  access?:TargetAccess;
  sources?:SourceContext[];
  id:string;kind:"website"|"api";name:string;url:string;revision:number;archived:boolean;deleted?:boolean;
  createdAt:number;updatedAt:number;updatedBy:string;objective:string;exclusions:string;
}
export interface CredentialMetadata {
  binding?:string;id:string;purpose:"model"|"api";label:string;version:number;revoked:boolean;missing?:boolean;
  targetId?:string;audienceURL?:string;targetRevision?:number;header?:string;scheme?:"bearer"|"header";updatedAt:number;updatedBy:string;
}
interface TargetProof extends AddressCheck {targetId:string;targetRevision:number;checkedAt:number;expiresAt:number}
interface ModelProof {credentialFingerprint?:string;model:string;credentialId:string;credentialVersion:number;catalogDigest:string;testedAt:number;expiresAt:number}
export interface SetupDraft {
  revision:number;profile?:ModelProfile;publicAPI:boolean;
  endpoint?:string;expectedStatus?:number;expectedText?:string;updatedBy:string;
}
type Catalog={models:OpenCodeModel[];fetchedAt:string;stale:boolean;digest:string;modelDigests:Record<string,string>;providerConfig?:string};
export interface OnboardingIO {
  readTargetSecret?:(binding:string)=>Promise<string>;
  get<T>(key:string):T|undefined;put(key:string,value:unknown):void;list<T>(prefix:string):T[];remove(key:string):void;
  now?:()=>number;fetcher?:typeof fetch;probe?:(model:OpenCodeModel,key:string)=>Promise<void>;boundGoKey?:()=>string|undefined;modelBindings?:()=>CredentialMetadata[];readModelSecret?:(id:string)=>Promise<string>;byokProviders?:()=>import("./opencode-models").OpenCodeByokProvider[];
}
const prefix="onboarding:";
export class OnboardingStore {
  private readonly running=new Map<string,Promise<unknown>>();
  constructor(private readonly io:OnboardingIO){}
  private now(){return (this.io.now??Date.now)();}
  private key(type:string,id:string){return prefix+type+":"+id;}
  private audit(action:string,id:string,actor:string){this.io.put(this.key("audit",crypto.randomUUID()),{action,id,actor,at:this.now()});}
  target(id:string):SavedTarget {
    const value=this.io.get<SavedTarget>(this.key("target",identifier(id)));
    if(!value||value.deleted)throw new Error("404: Target not found");return structuredClone(value);
  }
  targets(){return this.io.list<SavedTarget>(prefix+"target:").filter(t=>!t.deleted);}
  saveTarget(raw:{id:string;kind:string;name:string;url:string;objective?:string;exclusions?:string},expected:number|null,actor:string) {
    const id=identifier(raw.id,"target id"),prior=this.io.get<SavedTarget>(this.key("target",id));
    if(prior?.deleted)throw new Error("409: Target identity was deleted; use a new ID");
    if(prior?expected!==prior.revision:expected!==null)throw new Error("409: Target changed; reload");
    if(!["website","api"].includes(raw.kind)||typeof raw.name!=="string"||!raw.name.trim()||raw.name.length>160)throw new Error("400: Target type and name are required");
    for(const v of [raw.objective,raw.exclusions])if(v!==undefined&&(typeof v!=="string"||v.length>16000))throw new Error("400: Target notes are too long");
    const target:SavedTarget={id,kind:raw.kind as SavedTarget["kind"],name:raw.name.trim(),url:normalizeTargetURL(raw.url),revision:(prior?.revision??0)+1,
      archived:prior?.archived??false,createdAt:prior?.createdAt??this.now(),updatedAt:this.now(),updatedBy:actor,objective:raw.objective??"",exclusions:raw.exclusions??"",...(prior?.sources?{sources:prior.sources}:{}),...(prior?.access?{access:validateTargetAccess(normalizeTargetURL(raw.url),prior.access)}:{})};
    this.io.put(this.key("target",id),target);this.audit(prior?"target.update":"target.create",id,actor);return target;
  }
  saveTargetAccess(id:string,revision:number,raw:unknown,actor:string,program?:ProgramScope|null){
    const target=this.target(id);if(target.archived||target.revision!==revision)throw new Error("409: Target changed or archived; reload");
    if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("400: Invalid target access settings");
    const nextProgram=program===undefined?target.access?.program:program??undefined;
    const access=validateTargetAccess(target.url,{...raw,program:nextProgram});
    const next={...target,access,revision:revision+1,updatedAt:this.now(),updatedBy:actor};
    this.io.put(this.key("target",id),next);this.audit(program?"scope.import":"target.access",id,actor);return next;
  }
  async checkTargetSecret(id:string,revision:number,kind:string,actor:string){
    const target=this.target(id);if(target.archived||target.revision!==revision)throw new Error("409: Target changed or archived; reload");
    if(!["username","password","api","headers","totp"].includes(kind))throw new Error("400: Unknown target secret");
    const names=await targetSecretBindings(id),access=target.access;
    const binding=kind==='totp'?(access?.login?.verification?.kind==='totp'?access.login.verification.binding:names.totp):kind==="username"?access?.login?.usernameBinding??names.username:kind==="password"?access?.login?.passwordBinding??names.password:kind==="api"?access?.api?.binding??names.api:access?.headerBinding??names.headers;
    let status:"ready"|"missing"|"invalid"="missing";
    try{const value=await this.io.readTargetSecret?.(binding);if(value){status="invalid";if(value.length<=8192&&!/[\r\n\0]/.test(value)&&value.trim()){if(kind==="headers")parseTargetHeaders(value);if(kind==='totp')authenticator(value);status="ready";}}}catch(error){if(error instanceof Error&&error.message==="409: Target secret has invalid format")status="invalid"; /* Never return provider errors or values. */ }
    const current=this.target(id);if(current.archived||current.revision!==revision)throw new Error("409: Target changed during verification; check again");
    this.audit("target.secret.check",id,actor);
    return {binding,status,ready:status==="ready",authenticated:false,checkedAt:this.now()};
  }
  saveSources(id:string,revision:number,sources:SourceContext[],actor:string){
    const target=this.target(id);
    if(target.archived||target.revision!==revision)throw new Error("409: Target changed or archived; reload");
    const next={...target,sources:structuredClone(sources),revision:revision+1,updatedAt:this.now(),updatedBy:actor};
    this.io.put(this.key("target",id),next);this.audit("source.update",id,actor);return next;
  }
  lifecycleTarget(id:string,expected:number,action:"archive"|"restore"|"delete",actor:string) {
    const target=this.target(id);if(target.revision!==expected)throw new Error("409: Target changed; reload");
    const next={...target,revision:target.revision+1,updatedAt:this.now(),updatedBy:actor,archived:action!=="restore",...(action==="delete"?{deleted:true}:{})};
    this.io.put(this.key("target",id),next);this.audit("target."+action,id,actor);
    return next;
  }
  async checkTarget(id:string,revision:number,operation:string,actor:string,checker?:(url:string)=>Promise<AddressCheck>) {
    const target=this.target(id);if(target.archived||target.revision!==revision)throw new Error("409: Target changed or archived; reload");
    return this.operation("check",operation,{id,revision},async()=>{
      const resolved=await resolveTargetHeaders(target,name=>this.io.readTargetSecret!(name));
      const fetcher:typeof fetch=target.access?(url,init)=>performTargetFetch(resolved,new Request(url,init),this.io.fetcher):this.io.fetcher??fetch;
      const checked=await (checker??(url=>checkAddress(url,fetcher)))(target.url);const current=this.target(id);
      if(current.revision!==revision||current.archived)throw new Error("409: Target changed during verification; verify again");
      const proof:TargetProof={...checked,targetId:id,targetRevision:revision,checkedAt:this.now(),expiresAt:this.now()+300000};
      this.io.put(this.key("target-proof",id),proof);this.audit("target.check",id,actor);return proof;
    });
  }
  requireTargetProof(id:string,revision:number):TargetProof {
    const target=this.target(id),proof=this.io.get<TargetProof>(this.key("target-proof",id));
    if(target.archived||target.revision!==revision||!proof||proof.targetRevision!==revision||proof.expiresAt<this.now()||!["reachable","needs-auth","path-review"].includes(proof.classification))
      throw new Error("409: Verify the current target address before starting a run");
    return structuredClone(proof);
  }
  credentials():CredentialMetadata[] {
    const records=this.io.list<CredentialMetadata>(prefix+"credential:");
    records.unshift(...(this.io.modelBindings?.()??(this.io.boundGoKey?.()?[{id:"bound-go",purpose:"model" as const,label:"OpenCode Go · Cloudflare",version:0,revoked:false,updatedAt:0,updatedBy:"deployment"}]:[])));
    return records;
  }
  private requireModelCredential(id:string,version:number) {
    const meta=this.credentials().find(c=>c.id===id&&c.purpose==="model");
    if(!["bound-go","bound-console"].includes(id)||version!==0||!meta||meta.revoked||meta.missing)throw new Error("409: Select a configured Cloudflare OpenCode secret binding");
  }
  async resolveModelCredential(id:string,version:number):Promise<string> {
    this.requireModelCredential(id,version);
    const key=this.io.readModelSecret?await this.io.readModelSecret(id):id==="bound-go"?this.io.boundGoKey?.():undefined;
    if(!key)throw new Error("409: Configure the OpenCode secret in Cloudflare");
    return key;
  }
  async catalog(route:OpenCodeRoute,refresh=false):Promise<Catalog> {
    if(!["go","console"].includes(route))throw new Error("400: Choose OpenCode Go or Console");
    const providers=route==="console"?this.io.byokProviders?.()??[]:[],providerConfig=canonical(providers);
    const key=this.key("catalog",route),cached=this.io.get<Catalog>(key),compatible=cached&&(cached.providerConfig??"[]")===providerConfig;
    if(compatible&&!refresh&&Date.parse(cached.fetchedAt)+900000>this.now())return {...cached,stale:false};
    let failure="network or timeout failure";
    try {
      const response=await (this.io.fetcher??fetch)("https://opencode.ai/inference/"+(route==="go"?"go/":"")+"v1/models",{signal:AbortSignal.timeout(10000),redirect:"manual"});
      if(!response.ok){failure="HTTP "+response.status;await response.body?.cancel();throw new Error();}
      failure="invalid or unsupported catalog response";
      const models=normalizeCatalog(JSON.parse(await boundedText(response,1024*1024)),route,providers);
      if(!models.length)throw new Error();
      if(canonical(route==="console"?this.io.byokProviders?.()??[]:[])!==providerConfig)throw new Error();
      const value:Catalog={models,fetchedAt:new Date(this.now()).toISOString(),stale:false,providerConfig,digest:await digest(models),modelDigests:Object.fromEntries(await Promise.all(models.map(async m=>[m.id,await digest(m)])))};
      this.io.put(key,value);return value;
    } catch {if(compatible&&canonical(route==="console"?this.io.byokProviders?.()??[]:[])===providerConfig)return {...cached,stale:true};throw new Error("503: OpenCode "+(route==="go"?"Go":"Console")+" catalog unavailable ("+failure+"). Refresh the catalog to retry.");}
  }
  private model(choice:ModelChoice):{model:OpenCodeModel;catalog:Catalog} {
    if(!choice||typeof choice.model!=="string")throw new Error("400: Choose an OpenCode model");
    const route=choice.model.startsWith("opencode-go:")?"go":choice.model.startsWith("opencode:")?"console":null;
    if(!route)throw new Error("400: Only OpenCode Console and Go models are supported");
    const catalog=this.io.get<Catalog>(this.key("catalog",route)),model=catalog?.models.find(m=>m.id===choice.model);
    if(!catalog||!model||(catalog.providerConfig??"[]")!==canonical(route==="console"?this.io.byokProviders?.()??[]:[])||Date.parse(catalog.fetchedAt)+900000<this.now())throw new Error("409: Refresh the OpenCode catalog before choosing a model");
    return {model,catalog};
  }
  private proofKey(choice:ModelChoice){return this.key("model-proof",choice.credentialId+":"+choice.credentialVersion+":"+choice.model);}
  async testModel(choice:ModelChoice,operation:string,actor:string) {
    const {model,catalog}=this.model(choice),key=await this.resolveModelCredential(choice.credentialId,choice.credentialVersion);
    const credentialFingerprint=await digest(key);
    const prior=this.io.get<ModelProof>(this.proofKey(choice));
    if(prior&&prior.expiresAt>this.now()&&prior.catalogDigest===catalog.modelDigests[choice.model]&&prior.credentialFingerprint===credentialFingerprint)return prior;
    return this.operation("model-test",operation,choice,async()=>{
      try {if(!this.io.probe)throw new Error("Native OpenCode test is unavailable");await this.io.probe(model,key);}
      catch {throw new Error("409: OpenCode test failed. Check key Models Request permission, plan, quota, privacy/region settings and model tool support in OpenCode.");}
      if(this.model(choice).catalog.modelDigests[choice.model]!==catalog.modelDigests[choice.model])throw new Error("409: OpenCode model configuration changed during the test; test again");
      if(await digest(await this.resolveModelCredential(choice.credentialId,choice.credentialVersion))!==credentialFingerprint)throw new Error("409: Cloudflare secret changed during the model test; test again");
      const proof:ModelProof={...choice,credentialFingerprint,catalogDigest:catalog.modelDigests[choice.model]!,testedAt:this.now(),expiresAt:this.now()+86400000};
      this.io.put(this.proofKey(choice),proof);this.audit("model.test",choice.credentialId,actor);return proof;
    });
  }
  pinnedModel(choice:ModelChoice):PinnedModel {
    const proof=this.io.get<ModelProof>(this.proofKey(choice));
    if(!proof||proof.expiresAt<this.now()||!/^[a-f0-9]{64}$/.test(proof.credentialFingerprint??""))throw new Error("409: Test the selected OpenCode model before starting analysis");
    const {model,catalog}=this.model(choice);
    if(catalog.modelDigests[choice.model]!==proof.catalogDigest)throw new Error("409: Model metadata changed; test the model again");
    this.requireModelCredential(choice.credentialId,choice.credentialVersion);
    return {...model,credentialId:choice.credentialId,credentialVersion:choice.credentialVersion,...(proof.credentialFingerprint?{credentialFingerprint:proof.credentialFingerprint}:{}),catalogDigest:catalog.modelDigests[choice.model]!,testedAt:proof.testedAt};
  }
  draft(runId:string):SetupDraft {return this.io.get<SetupDraft>(this.key("setup",identifier(runId)))??{revision:0,publicAPI:true,updatedBy:"system"};}
  saveDraft(runId:string,input:Omit<SetupDraft,"revision"|"updatedBy">,expected:number,actor:string):SetupDraft {
    const prior=this.draft(runId);if(prior.revision!==expected)throw new Error("409: Setup changed; reload");
    if(typeof input.publicAPI!=="boolean")throw new Error("400: Choose public or authenticated API access");
    if(input.profile){
      const choices=[input.profile.default,...Object.values(input.profile.overrides??{})];
      for(const choice of choices){if(!choice)continue;this.model(choice);this.requireModelCredential(choice.credentialId,choice.credentialVersion);}
      if(Object.keys(input.profile.overrides??{}).some(k=>!MODEL_ROLES.includes(k as ModelRole)))throw new Error("400: Unknown model role");
    }
    if(input.expectedStatus!==undefined&&(!Number.isInteger(input.expectedStatus)||input.expectedStatus<200||input.expectedStatus>299))throw new Error("400: Choose an expected successful status");
    if(input.expectedText!==undefined&&(typeof input.expectedText!=="string"||input.expectedText.length>500))throw new Error("400: Authentication match is too long");
    const next:SetupDraft={revision:prior.revision+1,publicAPI:input.publicAPI,updatedBy:actor,
      ...(input.profile?{profile:structuredClone(input.profile)}:{}),
      ...(input.endpoint?{endpoint:normalizeTargetURL(input.endpoint)}:{}),
      ...(input.expectedStatus?{expectedStatus:input.expectedStatus}:{}),
      ...(input.expectedText?{expectedText:input.expectedText}:{}),
    };
    const {revision:_oldRevision,updatedBy:_oldActor,...before}=prior,{revision:_newRevision,updatedBy:_newActor,...after}=next;
    if(canonical(before)===canonical(after))return prior;
    this.io.put(this.key("setup",runId),next);this.audit("setup.update",runId,actor);return next;
  }
  pinProfile(runId:string){const draft=this.draft(runId);if(!draft.profile)throw new Error("409: Configure OpenCode models first");return Object.fromEntries(MODEL_ROLES.map(role=>[role,this.pinnedModel(draft.profile!.overrides[role]??draft.profile!.default)])) as Record<ModelRole,PinnedModel>;}
  async verifyModelProfile(runId:string){
    const models=this.pinProfile(runId),fingerprints=new Map<string,Promise<string>>();
    for(const model of Object.values(models)){
      const ref=model.credentialId+":"+model.credentialVersion;
      if(!fingerprints.has(ref))fingerprints.set(ref,this.resolveModelCredential(model.credentialId,model.credentialVersion).then(key=>digest(key)));
      if(model.credentialFingerprint&&await fingerprints.get(ref)!==model.credentialFingerprint)throw new Error("409: Cloudflare model secret changed; test the selected models again");
    }
    return models;
  }
  async testAPI(runId:string,target:SavedTarget,operation:string,actor:string) {
    const draft=this.draft(runId),bound=target.access?.api;if(!bound||!draft.endpoint||!draft.expectedStatus)throw new Error("400: Configure a Cloudflare API binding, protected read-only endpoint and expected status");
    const config={targetURL:bound.url,header:bound.header,value:(bound.scheme==="bearer"?"Bearer ":"")+(this.io.readTargetSecret?await this.io.readTargetSecret(bound.binding):(()=>{throw new Error("409: Configure the Cloudflare target binding");})())};assertAudience(config.targetURL,draft.endpoint);
    const credentialFingerprint=await digest(config.value);
    const identity={runId,revision:draft.revision,targetRevision:target.revision,credentialFingerprint};
    return this.operation("api-test",operation,identity,async()=>{
      const resolved=await resolveTargetHeaders(target,name=>this.io.readTargetSecret!(name));
      const request=(authenticated:boolean)=>{const init={method:"GET",headers:targetHeaders(undefined,authenticated?config:undefined),redirect:"manual" as const,signal:AbortSignal.timeout(5000)};return target.access?performTargetFetch(resolved,new Request(draft.endpoint!,init),this.io.fetcher,authenticated?config:undefined):(this.io.fetcher??fetch)(draft.endpoint!,init);};
      const anonymous=await request(false),anonymousText=await boundedText(anonymous);
      const response=await request(true),text=await boundedText(response);
      const matches=(status:number,body:string)=>status===draft.expectedStatus&&(!draft.expectedText||body.includes(draft.expectedText));
      if(!matches(response.status,text)||matches(anonymous.status,anonymousText))throw new Error("409: The response did not distinguish authenticated access. Use a protected read-only endpoint and an accurate success condition.");
      if(this.draft(runId).revision!==draft.revision)throw new Error("409: Setup changed during API test");
      const current=await this.io.readTargetSecret!(bound.binding);if(await digest((bound.scheme==="bearer"?"Bearer ":"")+current)!==credentialFingerprint)throw new Error("409: Cloudflare API secret changed during testing; test it again");
      const proof={...identity,configuration:apiProofIdentity(draft,target),testedAt:this.now(),expiresAt:this.now()+86400000};
      this.io.put(this.key("api-proof",runId),proof);this.audit("api.test",target.id,actor);return {verified:true,testedAt:proof.testedAt};
    });
  }
  requireAPIProof(runId:string,target:SavedTarget) {
    const draft=this.draft(runId);if(target.kind!=="api"||draft.publicAPI)return;
    const proof=this.io.get<{revision:number;targetRevision:number;expiresAt:number;configuration:string;credentialFingerprint?:string}>(this.key("api-proof",runId));
    if(!proof||proof.configuration!==apiProofIdentity(draft,target)||proof.targetRevision!==target.revision||proof.expiresAt<this.now())throw new Error("409: Test API access before authenticated analysis");
    if(!target.access?.api)throw new Error("409: Configure Cloudflare API authentication in the saved target and start a new run");
    if(!proof.credentialFingerprint)throw new Error("409: Test the current Cloudflare API secret again");
    return proof;
  }
  async verifyAPIProof(runId:string,target:SavedTarget){
    const proof=this.requireAPIProof(runId,target),bound=target.access?.api;
    if(proof&&bound){const value=await this.io.readTargetSecret!(bound.binding);if(await digest((bound.scheme==="bearer"?"Bearer ":"")+value)!==proof.credentialFingerprint)throw new Error("409: Cloudflare API secret changed; test access again");}
    return proof;
  }
  async operation<T>(kind:string,id:string,input:unknown,run:()=>Promise<T>):Promise<T>{
    identifier(id,"operation id");const key=this.key("operation",kind+":"+id),fingerprint=await digest(input);
    const prior=this.io.get<{fingerprint:string;status:string;result?:T}>(key);
    if(prior){if(prior.fingerprint!==fingerprint)throw new Error("409: Operation identity reused with changed input");if(prior.status==="complete")return structuredClone(prior.result!);const active=this.running.get(key);if(active)return active as Promise<T>;throw new Error("409: Prior check/test did not finish; explicitly retry with a new operation ID");}
    this.io.put(key,{fingerprint,status:"pending"});
    const promise=run().then(result=>{this.io.put(key,{fingerprint,status:"complete",result});return result;},error=>{this.io.put(key,{fingerprint,status:"failed"});throw error;}).finally(()=>{this.running.delete(key);});
    this.running.set(key,promise);return promise;
  }
  exportData(){
    return {version:1,targets:this.targets(),credentials:this.credentials().filter(c=>!c.id.startsWith("bound-")&&(c.purpose==="model"||this.targets().some(t=>t.id===c.targetId))).map(c=>({...c,missing:true})),
      defaults:this.io.list<{targetId:string;draft:SetupDraft}>(prefix+"defaults:"),audit:this.io.list(prefix+"audit:")};
  }
  importData(raw:ReturnType<OnboardingStore["exportData"]>,actor:string){
    if(!raw||raw.version!==1||!Array.isArray(raw.targets)||!Array.isArray(raw.credentials))throw new Error("400: Invalid onboarding export");
    if(this.targets().length||this.credentials().some(c=>!c.id.startsWith("bound-")))throw new Error("409: Import needs an empty target/credential library");
    for(const target of raw.targets){
      let imported=this.saveTarget(target,null,actor);
      if(target.access)imported=this.saveTargetAccess(imported.id,imported.revision,target.access,actor,target.access.program??null);
      if(target.archived)this.lifecycleTarget(imported.id,imported.revision,"archive",actor);
    }
    for(const c of raw.credentials){
      identifier(c.id);
      if(!["api","model"].includes(c.purpose)||!Number.isSafeInteger(c.version)||c.version<1||c.version>10000)throw new Error("400: Invalid imported credential metadata");
      if(c.purpose==="api"&&(!c.targetId||!raw.targets.some(t=>t.id===c.targetId)||!c.header||!c.scheme||!c.audienceURL||normalizeTargetURL(c.audienceURL)!==c.audienceURL||!validAuthHeader(c.header,c.scheme)))throw new Error("400: Invalid imported API credential audience");
      this.io.put(this.key("credential",c.id),{id:c.id,purpose:c.purpose,label:String(c.label).slice(0,160),version:c.version,revoked:false,missing:true,
        ...(c.targetId?{targetId:c.targetId,audienceURL:c.audienceURL,targetRevision:c.targetRevision,header:c.header,scheme:c.scheme}:{}),updatedAt:this.now(),updatedBy:actor});
    }
    for(const defaults of raw.defaults??[]){
      if(!raw.targets.some(t=>t.id===defaults.targetId))throw new Error("400: Imported profile target is missing");
      const clean=(choice:ModelChoice):ModelChoice=>{
        if(!choice||!/^(opencode-go|opencode):[A-Za-z0-9][A-Za-z0-9._~/-]{0,180}$/.test(choice.model)||!Number.isSafeInteger(choice.credentialVersion))throw new Error("400: Invalid imported model choice");
        return {model:choice.model,credentialId:identifier(choice.credentialId),credentialVersion:choice.credentialVersion};
      };
      const d=defaults.draft;
      const draft:SetupDraft={revision:0,publicAPI:d.publicAPI===true,updatedBy:actor,
        ...(d.profile?{profile:{default:clean(d.profile.default),overrides:Object.fromEntries(MODEL_ROLES.filter(role=>!!d.profile?.overrides[role]).map(role=>[role,clean(d.profile!.overrides[role]!)]))}}:{}),
        ...(d.endpoint?{endpoint:normalizeTargetURL(d.endpoint)}:{}),
        ...(d.expectedStatus?{expectedStatus:Number(d.expectedStatus)}:{}),
        ...(d.expectedText?{expectedText:String(d.expectedText).slice(0,500)}:{}),
      };
      this.io.put(this.key("defaults",defaults.targetId),{targetId:defaults.targetId,draft});
    }
    this.audit("metadata.import","installation",actor);return {imported:true,credentialsNeedReentry:true,sourcesNeedReattachment:raw.targets.some(t=>t.sources?.length)};
  }
}
export function assertAudience(base:string,raw:string) {
  const target=new URL(base),url=new URL(raw);const path=target.pathname.endsWith("/")?target.pathname:target.pathname+"/";
  // Encoded separators and nested encodings can be decoded differently by an API
  // server. Do not attach a credential to an ambiguous path.
  if(url.origin!==target.origin||/%(?:25|2f|5c)/i.test(target.pathname+url.pathname)||!(url.pathname===target.pathname||url.pathname.startsWith(path))||url.username||url.password)throw new Error("403: API credentials cannot be sent outside the configured audience");
}
function validAuthHeader(header:string,scheme:string){
  return /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,80}$/.test(header) &&
    (scheme==="bearer"?header.toLowerCase()==="authorization":!operatorIdentityHeader(header)&&!["host","connection","content-length","transfer-encoding"].includes(header.toLowerCase()));
}

function apiProofIdentity(draft:SetupDraft,target:SavedTarget){return canonical({endpoint:draft.endpoint,status:draft.expectedStatus,text:draft.expectedText,target:{id:target.id,revision:target.revision,url:target.url}});}
