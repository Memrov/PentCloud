import {digest} from "./domain";
import type {RemoteTool} from "./tools";

// Name/input-schema digest of the official SDK's 126-tool catalog from unchanged
// stock image sha256:d895…4491. Full evidence stays outside the runtime bundle:
// apps/control-plane/test/fixtures/stock-kali-catalog.json.
export const STOCK_KALI_TOOL_COUNT = 126;
const STOCK_KALI_SCHEMA_DIGEST = "200ae9b4191c7ed4e175502e791799887a1b9cfa7979b82233c0f01c757c7eab";
export async function stockKaliCatalogReady(tools: readonly RemoteTool[]): Promise<boolean> {
  if (tools.length !== STOCK_KALI_TOOL_COUNT || new Set(tools.map(tool => tool.name)).size !== STOCK_KALI_TOOL_COUNT) return false;
  return await digest(tools.map(({name, inputSchema}) => ({name, inputSchema})).sort((a, b) => a.name.localeCompare(b.name))) === STOCK_KALI_SCHEMA_DIGEST;
}
