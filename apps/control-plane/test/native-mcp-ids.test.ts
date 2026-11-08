import { describe, expect, it } from "vite-plus/test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { uniqueClientIds } from "../src/native/mcp-ids";

function fixture() {
  const sent: JSONRPCMessage[] = [];
  const base: Transport = {
    sessionId: "same-server-session",
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      sent.push(message);
    }
  };
  return { base, sent, client: uniqueClientIds(base) };
}
describe("MCP client request identity across session resume", () => {
  it("separates reset numeric IDs and maps cancellation only to the new request", async () => {
    const old = fixture(),
      resumed = fixture();
    await old.client.send({
      jsonrpc: "2.0",
      id: 0,
      method: "tools/call",
      params: { name: "mutation", arguments: { target: "127.0.0.1" } }
    });
    await resumed.client.send({
      jsonrpc: "2.0",
      id: 0,
      method: "tools/call",
      params: { name: "inspect", arguments: { scan_id: "scan" } }
    });
    const oldId = "id" in old.sent[0]! ? old.sent[0].id : undefined;
    const newId = "id" in resumed.sent[0]! ? resumed.sent[0].id : undefined;
    expect(newId).not.toBe(oldId);
    await resumed.client.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 0 }
    });
    expect(resumed.sent[1]).toMatchObject({ params: { requestId: newId } });
    expect(old.sent[0]).toMatchObject({
      params: { arguments: { target: "127.0.0.1" } }
    });
  });
  it("forgets cancelled correlations and ignores late responses and progress", async () => {
    const { base, sent, client } = fixture();
    const received: JSONRPCMessage[] = [];
    client.onmessage = (message) => {
      received.push(message);
    };
    for (let id = 0; id < 100; id++) {
      await client.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "inspect", _meta: { progressToken: id } }
      });
      const request = sent.at(-1)!;
      if (!("id" in request) || !("method" in request))
        throw new Error("request missing");
      const token = (request.params?._meta as { progressToken: string })
        .progressToken;
      await client.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id }
      });
      const count = sent.length;
      await client.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id }
      });
      expect(sent).toHaveLength(count);
      base.onmessage?.({
        jsonrpc: "2.0",
        id: request.id,
        result: { late: true }
      });
      base.onmessage?.({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: 1 }
      });
    }
    expect(received).toEqual([]);
  });
  it("maps progress and responses while preserving server-owned IDs and dropping stale responses", async () => {
    const { base, sent, client } = fixture();
    const received: JSONRPCMessage[] = [];
    client.onmessage = (message) => {
      received.push(message);
    };
    await client.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "inspect", _meta: { progressToken: 7 } }
    });
    const request = sent[0]!;
    if (!("id" in request) || !("method" in request))
      throw new Error("missing request");
    const token = (request.params?._meta as { progressToken: string })
      .progressToken;
    base.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress: 1 }
    });
    base.onmessage?.({
      jsonrpc: "2.0",
      id: "old-client:7",
      result: { unexpected: true }
    });
    base.onmessage?.({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
    base.onmessage?.({ jsonrpc: "2.0", id: "server-owned", method: "ping" });
    await client.send({ jsonrpc: "2.0", id: "server-owned", result: {} });
    expect(received).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: 7, progress: 1 }
      },
      { jsonrpc: "2.0", id: 7, result: { ok: true } },
      { jsonrpc: "2.0", id: "server-owned", method: "ping" }
    ]);
    expect(sent[1]).toMatchObject({ id: "server-owned" });
  });
});
