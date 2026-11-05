import { DurableObject } from 'cloudflare:workers';
import { OpenCodeWorkerd } from '@opencode/sdk/workerd';
import { managedBrowser, managedWebSearch } from '../../src/native/managed-retrieval';
interface Env {CANARY_TOKEN:string;AI?:Ai;PROBE:DurableObjectNamespace<ResearchProbe>}
export class ResearchProbe extends DurableObject<Env>{
  async run(){
    const query='Cloudflare Agents SDK official docs';
    const host=await OpenCodeWorkerd.create({storage:this.ctx.storage,models:{fetch:false,snapshot:false},config:{websearch:{provider:'tinyfish'}}});
    try{
      const search=await managedWebSearch(query,3,AbortSignal.timeout(30000),host.websearch);
      const providers=await host.websearch.providers();
      // Markdown negotiation is an actual stock fetch path and needs no converter.
      const browser=await managedBrowser({url:'https://developers.cloudflare.com/agents/',action:'markdown'},{binding:(this.env.AI??{}) as Ai,scopes:['https://developers.cloudflare.com/agents/'],signal:AbortSignal.timeout(30000)});
      return {query,search,providers,browserStatus:browser.status,browserFormat:browser.format,browserCharacters:String(browser.markdown).length};
    }catch(error){return {query,error:error instanceof Error?error.message:String(error)};}
    finally{await host.close();}
  }
  async clean(){await this.ctx.storage.deleteAll();return true;}
}
export default {async fetch(request:Request,env:Env){
  if(!env.CANARY_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.CANARY_TOKEN}`)return new Response('Unauthorized',{status:401});
  const url=new URL(request.url);
  if(url.pathname==='/health')return Response.json({ready:true});
  if(url.pathname==='/clean')return Response.json({temporaryStorageCleared:await env.PROBE.getByName('research').clean()});
  if(url.pathname!=='/run'||request.method!=='POST')return new Response('Not found',{status:404});
  const durableObject=await env.PROBE.getByName('research').run();
  return Response.json({durableObject,modelCalls:0,scans:0});
}};
