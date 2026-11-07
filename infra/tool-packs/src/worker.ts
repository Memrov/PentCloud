import {WorkerEntrypoint} from "cloudflare:workers";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CfWorkerJsonSchemaValidator} from "@modelcontextprotocol/sdk/validation/cfworker";
import {prepareFiles} from "@memrov2/pentcloud-tool-runtime";
import {buildCommand as recon, type ReconRequest} from "@memrov2/pentcloud-recon";
import {buildCommand as http, type PackRequest as HttpRequest} from "@memrov2/pentcloud-http";
import {buildCommand as nuclei, type PackRequest as NucleiRequest} from "@memrov2/pentcloud-nuclei";
import {buildCommand as sqlmap, type PackRequest as SqlmapRequest} from "@memrov2/pentcloud-sqlmap";
import {buildCommand as service, type PackRequest as ServiceRequest} from "@memrov2/pentcloud-service";
import {buildCommand as web, type PackRequest as WebRequest} from "@memrov2/pentcloud-web-context";
import {buildCommand as pcap, type PackRequest as PcapRequest} from "@memrov2/pentcloud-pcap";
import {buildCommand as file, type PackRequest as FileRequest} from "@memrov2/pentcloud-file-analysis";
import {buildCommand as password, type PackRequest as PasswordRequest} from "@memrov2/pentcloud-password";
import {referencePath, buildCommand as reference, type PackRequest as ReferenceRequest} from "@memrov2/pentcloud-reference";
import {assertPackAccess,packFileNames,type ToolPack,type ToolPackRequest,type ToolPackScope,type ToolPackService} from "../../../shared/tool-packs";
export {ReconRunner} from "@memrov2/pentcloud-recon/worker";
export {HttpRunner} from "@memrov2/pentcloud-http/worker";
export {NucleiRunner} from "@memrov2/pentcloud-nuclei/worker";
export {SqlmapRunner} from "@memrov2/pentcloud-sqlmap/worker";
export {ServiceRunner} from "@memrov2/pentcloud-service/worker";
export {WebContextRunner} from "@memrov2/pentcloud-web-context/worker";
export {PcapRunner} from "@memrov2/pentcloud-pcap/worker";
export {FileRunner} from "@memrov2/pentcloud-file-analysis/worker";
export {PasswordRunner} from "@memrov2/pentcloud-password/worker";
export {ReferenceRunner} from "@memrov2/pentcloud-reference/worker";
export {MetasploitRunner} from "@memrov2/pentcloud-metasploit/worker";

type Env={
  RECON:DurableObjectNamespace<import("@memrov2/pentcloud-recon/worker").ReconRunner>;
  HTTP:DurableObjectNamespace<import("@memrov2/pentcloud-http/worker").HttpRunner>;
  NUCLEI:DurableObjectNamespace<import("@memrov2/pentcloud-nuclei/worker").NucleiRunner>;
  SQLMAP:DurableObjectNamespace<import("@memrov2/pentcloud-sqlmap/worker").SqlmapRunner>;
  SERVICE:DurableObjectNamespace<import("@memrov2/pentcloud-service/worker").ServiceRunner>;
  WEB_CONTEXT:DurableObjectNamespace<import("@memrov2/pentcloud-web-context/worker").WebContextRunner>;
  PCAP:DurableObjectNamespace<import("@memrov2/pentcloud-pcap/worker").PcapRunner>;
  FILE_ANALYSIS:DurableObjectNamespace<import("@memrov2/pentcloud-file-analysis/worker").FileRunner>;
  PASSWORD:DurableObjectNamespace<import("@memrov2/pentcloud-password/worker").PasswordRunner>;
  REFERENCE:DurableObjectNamespace<import("@memrov2/pentcloud-reference/worker").ReferenceRunner>;
  METASPLOIT:DurableObjectNamespace<import("@memrov2/pentcloud-metasploit/worker").MetasploitRunner>;
};
const binding={recon:"RECON",http:"HTTP",nuclei:"NUCLEI",sqlmap:"SQLMAP",service:"SERVICE","web-context":"WEB_CONTEXT",pcap:"PCAP","file-analysis":"FILE_ANALYSIS",password:"PASSWORD",reference:"REFERENCE",metasploit:"METASPLOIT"} as const;

function reconRequest(input:Record<string,unknown>):ReconRequest {
  const {tool,target}=input;
  if((tool!=="httpx"&&tool!=="dnsx"&&tool!=="katana"&&tool!=="subfinder")||typeof target!=="string"||Object.keys(input).some(k=>k!=="tool"&&k!=="target"))throw Error("Select one supported recon tool and target");
  return {tool,target};
}

/** Private service binding only. Image lifecycle belongs to the SDK Durable Objects. */
export class ToolPackGateway extends WorkerEntrypoint<Env> implements ToolPackService {
  private runner(scope:ToolPackScope,pack:ToolPack){
    assertPackAccess(scope,pack);
    return this.env[binding[pack]].getByName(scope.runId+":"+scope.attemptId);
  }
  async ready(scope:ToolPackScope,pack:ToolPack){return this.runner(scope,pack).ready();}
  async stop(scope:ToolPackScope,packs:ToolPack[]){
    if(!Array.isArray(packs)||packs.length>11)throw Error("Invalid tool runtime list");
    for(const pack of new Set(packs))if(!(await this.runner(scope,pack).retire()).stopped)throw Error("Tool runtime did not stop");
    return {stopped:true};
  }
  async run(scope:ToolPackScope,input:ToolPackRequest,files:Record<string,Uint8Array>){
    assertPackAccess(scope,input?.pack,input?.request);
    // Validate before starting a runtime. A model can correct rejected input without an uncertain dispatch.
    try {
      const required=packFileNames(input);await prepareFiles(required,files);
      const r=input.request;
      switch(input.pack){
        case "recon":recon(reconRequest(r));break;
        case "http":http(r as HttpRequest);break;
        case "nuclei":nuclei(r as NucleiRequest);break;
        case "sqlmap":sqlmap(r as SqlmapRequest);break;
        case "service":service(r as ServiceRequest);break;
        case "web-context":web(r as WebRequest);break;
        case "pcap":pcap(r as PcapRequest);break;
        case "file-analysis":file(r as FileRequest);break;
        case "password":password(r as PasswordRequest);break;
        case "reference":
          if(r.action==="read-source"){
            if(Object.keys(r).some(k=>!["action","path"].includes(k))||typeof r.path!=="string")throw Error("Select a pinned reference source path");
            referencePath(r.path);
          }else reference(r as ReferenceRequest);
          break;
        case "metasploit":
          if(!["list","call"].includes(String(r.action))||Object.keys(r).some(k=>!["action","name","arguments"].includes(k))||r.action==="call"&&(typeof r.name!=="string"||!r.name||!r.arguments||typeof r.arguments!=="object"||Array.isArray(r.arguments)))throw Error("Use list, then call an official MCP tool with its arguments");
      }
    }catch(error){return {rejected:true,notExecuted:true,error:error instanceof Error?error.message:"Invalid tool input"};}
    const r=input.request,id=scope.runId+":"+scope.attemptId;
    switch(input.pack){
      case "recon":return this.env.RECON.getByName(id).run(reconRequest(r));
      case "http":return this.env.HTTP.getByName(id).run(r as HttpRequest);
      case "nuclei":return this.env.NUCLEI.getByName(id).run(r as NucleiRequest);
      case "sqlmap":return this.env.SQLMAP.getByName(id).run(r as SqlmapRequest);
      case "service":return this.env.SERVICE.getByName(id).run(r as ServiceRequest);
      case "web-context":return this.env.WEB_CONTEXT.getByName(id).run(r as WebRequest);
      case "pcap":return this.env.PCAP.getByName(id).run(r as PcapRequest,{input:files.input!});
      case "file-analysis":return this.env.FILE_ANALYSIS.getByName(id).run(r as FileRequest,{input:files.input!});
      case "password":return this.env.PASSWORD.getByName(id).run(r as PasswordRequest,{input:files.input!,...(files.dictionary?{dictionary:files.dictionary}:{})});
      case "reference":{
        const runner=this.env.REFERENCE.getByName(id);
        if(r.action!=="read-source")return runner.run(r as ReferenceRequest);
        const source=await runner.readSource(String(r.path));
        return {...source,bytes:undefined,bytesBase64:btoa(Array.from(source.bytes,b=>String.fromCharCode(b)).join("")),text:new TextDecoder().decode(source.bytes),size:source.bytes.byteLength};
      }
      case "metasploit":{
        const runner=this.env.METASPLOIT.getByName(id);
        const validator=new CfWorkerJsonSchemaValidator();
        const client=new Client({name:"pentcloud-tool-packs",version:"1"},{capabilities:{},jsonSchemaValidator:validator});
        const transport=new StreamableHTTPClientTransport(new URL("https://toolpacks.internal/mcp"),{fetch:(url,init)=>runner.fetch(new Request(url,init))});
        try{
          await client.connect(transport,{timeout:180000});
          if(r.action==="list")return await client.listTools();
          let cursor:string|undefined;
          for(let page=0;page<16;page++){
            const listing=await client.listTools(cursor?{cursor}:undefined),tool=listing.tools.find(t=>t.name===r.name);
            if(tool){
              const valid=validator.getValidator(tool.inputSchema as Parameters<typeof validator.getValidator>[0])(r.arguments);
              if(!valid.valid)return {rejected:true,notExecuted:true,error:valid.errorMessage};
              return await client.callTool({name:tool.name,arguments:r.arguments as Record<string,unknown>},undefined,{timeout:120000});
            }
            cursor=listing.nextCursor;if(!cursor)break;
          }
          return {rejected:true,notExecuted:true,error:"Select a tool name from the official MCP list"};
        }finally{
          try{await transport.terminateSession();}catch{/* The owned runtime is stopped when the attempt drains. */}
          await client.close();
        }
      }
    }
  }
}
export default {fetch(){return new Response("Not found",{status:404});}};
