import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
export { MetasploitRunner } from "@memrov2/pentcloud-metasploit/worker";
import type { MetasploitRunner } from "@memrov2/pentcloud-metasploit/worker";
import { packWorker } from "../pack-worker";

function validate(request: Record<string, unknown>): void {
  if (
    !["list", "call"].includes(String(request.action)) ||
    Object.keys(request).some(
      (k) => !["action", "name", "arguments"].includes(k)
    ) ||
    (request.action === "call" &&
      (typeof request.name !== "string" ||
        !request.name ||
        !request.arguments ||
        typeof request.arguments !== "object" ||
        Array.isArray(request.arguments)))
  )
    throw Error("Use list, then call an official MCP tool with its arguments");
}

export class MetasploitService extends packWorker<MetasploitRunner>(
  "metasploit",
  validate,
  async (runner, request) => {
    const validator = new CfWorkerJsonSchemaValidator();
    const client = new Client(
      { name: "pentcloud-tool-packs", version: "1" },
      { capabilities: {}, jsonSchemaValidator: validator }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL("https://toolpacks.internal/mcp"),
      { fetch: (url, init) => runner.fetch(new Request(url, init)) }
    );
    try {
      await client.connect(transport, { timeout: 180000 });
      if (request.action === "list") return await client.listTools();
      let cursor: string | undefined;
      for (let page = 0; page < 16; page++) {
        const listing = await client.listTools(cursor ? { cursor } : undefined);
        const tool = listing.tools.find((t) => t.name === request.name);
        if (tool) {
          const valid = validator.getValidator(
            tool.inputSchema as Parameters<typeof validator.getValidator>[0]
          )(request.arguments);
          if (!valid.valid)
            return {
              rejected: true,
              notExecuted: true,
              error: valid.errorMessage
            };
          return client.callTool(
            {
              name: tool.name,
              arguments: request.arguments as Record<string, unknown>
            },
            undefined,
            { timeout: 120000 }
          );
        }
        cursor = listing.nextCursor;
        if (!cursor) break;
      }
      return {
        rejected: true,
        notExecuted: true,
        error: "Select a tool name from the official MCP list"
      };
    } finally {
      try {
        await transport.terminateSession();
      } catch {
        /* The owned runtime is stopped when the attempt drains. */
      }
      await client.close();
    }
  }
) {}
