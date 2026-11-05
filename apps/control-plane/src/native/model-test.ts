import {DurableObject} from "cloudflare:workers";
import type {OpenCodeWorkerd} from "@opencode/sdk/workerd";
import {probeOpenCode,type OpenCodeModel} from "./opencode-models";

/** One disposable native SDK host per explicit connection test, without a Workspace or Kali. */
export class OpenCodeConnectionTest extends DurableObject {
  private used=false;
  protected async create(options:OpenCodeWorkerd.CreateOptions){const {OpenCodeWorkerd}=await import("@opencode/sdk/workerd");return OpenCodeWorkerd.create(options);}
  async probeModel(model:OpenCodeModel,key:string):Promise<void> {
    if(this.used)throw new Error("409: Connection test already used; retry explicitly");
    this.used=true;
    try {await probeOpenCode(model,key,this.ctx.storage,options=>this.create(options));}
    finally {await this.ctx.storage.deleteAll();}
  }
}
