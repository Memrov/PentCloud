import {materialHash} from "./materials";
import type { MaterialStore, StageMaterialInput } from "./material-store";
export interface TargetDefinition {targetId:string;version:number;name:string;sha256:string;size:number;stagingRunId:string;uploadId:string}
export class TargetDefinitions {
  constructor(private readonly io:{get<T>(key:string):T|undefined;put(key:string,value:unknown):void;materials:MaterialStore;runMaterials?:MaterialStore;read(path:string):Promise<ReadableStream<Uint8Array>>;validate?:(id:string)=>void}){}
  current(id:string){return this.io.get<TargetDefinition>("onboarding:definition:"+id);}
  async save(id:string,version:number,input:Omit<StageMaterialInput,"runId"|"id">) {
    this.io.validate?.(id);
    if(!/\.(json|ya?ml)$/i.test(input.name))throw new Error("400: Use a JSON or YAML API definition");
    const prior=this.current(id);
    // Consume and hash even identical retries using the normal material pipeline.
    const staged=await this.io.materials.stage({...input,runId:id,id:"definition-"+(await materialHash(new TextEncoder().encode(input.name+"|"+input.uploadedBy+"|"+input.sha256))).slice(0,32)});
    this.io.validate?.(id);
    if(prior?.sha256===staged.sha256&&prior.name===staged.name)return prior;
    if((this.current(id)?.version??0)!==version)throw new Error("409: Saved definition changed; reload before replacing it");
    const next:TargetDefinition={targetId:id,version:version+1,name:staged.name,sha256:staged.sha256,size:staged.size,stagingRunId:staged.runId,uploadId:staged.id};
    this.io.put("onboarding:definition-version:"+id+":"+next.version,next);this.io.put("onboarding:definition:"+id,next);return next;
  }
  async copyIntoRun(definition:TargetDefinition,runId:string,actor:string) {
    const stored=this.io.get<TargetDefinition>("onboarding:definition-version:"+definition.targetId+":"+definition.version);
    if(!stored||stored.sha256!==definition.sha256)throw new Error("409: Saved definition version is unavailable");
    const material=this.io.materials.get(stored.stagingRunId,stored.uploadId);
    const receipt=await (this.io.runMaterials??this.io.materials).stage({runId,id:"api-definition-"+stored.sha256.slice(0,32),name:stored.name,sha256:stored.sha256,uploadedBy:actor,body:await this.io.read(material.sourceFile)});
    return receipt.id;
  }
  async response(id:string,version?:number) {
    const current=this.current(id),definition=version?this.io.get<TargetDefinition>("onboarding:definition-version:"+id+":"+version):current;
    if(!definition)throw new Error("404: API definition not found");
    const material=this.io.materials.get(definition.stagingRunId,definition.uploadId);
    return new Response(await this.io.read(material.sourceFile),{headers:{"Content-Type":"text/plain;charset=utf-8","Cache-Control":"private,no-store","X-Content-SHA256":definition.sha256,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}});
  }
}
