import { WorkerEntrypoint } from "cloudflare:workers";
import {
  assertPackAccess,
  type ToolPack,
  type ToolPackRequest,
  type ToolPackScope,
  type ToolPackService
} from "../../../shared/tool-packs";
import type { PackWorkerService } from "./pack-worker";

type Env = Record<
  | "RECON"
  | "HTTP"
  | "NUCLEI"
  | "SQLMAP"
  | "SERVICE"
  | "WEB_CONTEXT"
  | "PCAP"
  | "FILE_ANALYSIS"
  | "PASSWORD"
  | "REFERENCE"
  | "METASPLOIT",
  PackWorkerService
>;

const binding = {
  recon: "RECON",
  http: "HTTP",
  nuclei: "NUCLEI",
  sqlmap: "SQLMAP",
  service: "SERVICE",
  "web-context": "WEB_CONTEXT",
  pcap: "PCAP",
  "file-analysis": "FILE_ANALYSIS",
  password: "PASSWORD",
  reference: "REFERENCE",
  metasploit: "METASPLOIT"
} as const satisfies Record<ToolPack, keyof Env>;

/** Private MCP dispatch. Tool packages and their Durable Objects live in separate Workers. */
export class ToolPackGateway
  extends WorkerEntrypoint<Env>
  implements ToolPackService
{
  private service(scope: ToolPackScope, pack: ToolPack): PackWorkerService {
    assertPackAccess(scope, pack);
    return this.env[binding[pack]];
  }

  async ready(scope: ToolPackScope, pack: ToolPack) {
    return this.service(scope, pack).ready(scope);
  }

  async run(
    scope: ToolPackScope,
    input: ToolPackRequest,
    files: Record<string, Uint8Array>
  ) {
    assertPackAccess(scope, input?.pack, input?.request);
    return this.service(scope, input.pack).run(scope, input, files);
  }

  async stop(scope: ToolPackScope, packs: ToolPack[]) {
    if (!Array.isArray(packs) || packs.length > 11)
      throw Error("Invalid tool runtime list");
    for (const pack of new Set(packs))
      if (!(await this.service(scope, pack).stop(scope)).stopped)
        throw Error("Tool runtime did not stop");
    return { stopped: true };
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  }
};
