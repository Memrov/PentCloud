import type {ToolboxFileService} from "./toolbox-files";
/** Private lifecycle capabilities shared by the app and gateway; no gateway implementation import. */
export const TOOLBOX_GENERATION_HEADER = "X-Pentcloud-Toolbox-Generation";

export type ToolboxUnavailable = { error: "unavailable" };
export type ToolboxFailure = ToolboxUnavailable | { error: "generation_lost"; generation?: string };
export type ToolboxStatus = { state: "running" | "stopped"; generation?: string; inactivityTimeoutMs: number };
export type ToolboxReadiness = { state: "booting" | "ready"; generation: string };
export type ToolboxActivity = { state: "running"; generation: string };

export interface ToolboxLifecycle {
  status(): Promise<ToolboxStatus | ToolboxUnavailable>;
  /** Only an omitted generation permits booting the shared runtime. */
  ready(expectedGeneration?: string): Promise<ToolboxReadiness | ToolboxFailure>;
  /** Refresh an existing generation; never start a replacement. */
  activity(generation: string): Promise<ToolboxActivity | ToolboxFailure>;
}
export interface ToolboxService extends ToolboxLifecycle, ToolboxFileService {
  configureAccess(generation:string,attempt:string):Promise<void>;
  /** Explicit operator purge only, after global admission/drain fencing. Never boots. */
  clear():Promise<{state:"stopped"}|ToolboxUnavailable>;
  /** Official SDK streaming MCP transport, separate from lifecycle RPC. */
  fetch(request: Request): Promise<Response>;
}
export function toolboxGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

/** Read-only status or explicit start; serialization at the Access app boundary. */
export function toolboxOperatorReply(reply:ToolboxReadiness|ToolboxStatus|ToolboxFailure):Response {
  const headers:Record<string,string>={"Cache-Control":"no-store"};
  if("generation" in reply&&reply.generation)headers[TOOLBOX_GENERATION_HEADER]=reply.generation;
  if("error" in reply){
    if(reply.error==="generation_lost"){headers["X-Pentcloud-Toolbox-Lost"]="true";return Response.json({error:"Toolbox generation lost"},{status:409,headers});}
    return Response.json({state:"unavailable"},{status:503,headers});
  }
  if(reply.state==="booting")headers["Retry-After"]="2";
  const status=reply.state==="booting"?202:200;
  const value=reply.state==="stopped"||reply.state==="running"?{runtime:"stock Kali MCP",hosting:"Cloudflare on demand",...reply,running:reply.state==="running"}:reply;
  return Response.json(value,{status,headers});
}
