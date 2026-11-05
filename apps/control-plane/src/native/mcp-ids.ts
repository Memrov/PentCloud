import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";

/** Client IDs are isolate-local; stock stdio correlation is shared by the resumed session. */
export function uniqueClientIds(base: Transport): Transport {
  const prefix = crypto.randomUUID();
  const outbound = new Map<RequestId, RequestId>();
  const inbound = new Map<RequestId, RequestId>();
  const progress = new Map<RequestId, RequestId>();
  const requestProgress = new Map<RequestId, RequestId>();
  const transport: Transport = {
    start: () => base.start(),
    close: async () => {
      await base.close();
      outbound.clear();
      inbound.clear();
      progress.clear();
      requestProgress.clear();
    },
    setProtocolVersion: (version) => base.setProtocolVersion?.(version),
    send: async (message, options) => {
      let wire: JSONRPCMessage = message;
      let cancelled: RequestId | undefined;
      if ("method" in message && "id" in message) {
        const id = `${prefix}:${typeof message.id}:${message.id}`;
        outbound.set(message.id, id);
        inbound.set(id, message.id);
        const meta = object(message.params?._meta);
        const token = meta?.progressToken;
        if (typeof token === "string" || typeof token === "number") {
          const wireToken = `${prefix}:progress:${typeof token}:${token}`;
          progress.set(wireToken, token);
          requestProgress.set(id, wireToken);
          wire = {
            ...message,
            id,
            params: {
              ...message.params,
              _meta: { ...meta, progressToken: wireToken },
            },
          };
        } else wire = { ...message, id };
      } else if (
        "method" in message &&
        message.method === "notifications/cancelled"
      ) {
        const id = message.params?.requestId;
        if (typeof id !== "string" && typeof id !== "number") return;
        const mapped = outbound.get(id);
        if (mapped === undefined) return; // Never cancel another connection's numeric ID.
        wire = { ...message, params: { ...message.params, requestId: mapped } };
        cancelled = mapped;
      }
      await base.send(wire, options);
      if (cancelled !== undefined) {
        const id = inbound.get(cancelled);
        if (id !== undefined) outbound.delete(id);
        inbound.delete(cancelled);
        const token = requestProgress.get(cancelled);
        if (token !== undefined) progress.delete(token);
        requestProgress.delete(cancelled);
      }
    },
  };
  // Public Transport property, kept dynamic as initialize assigns the server SID.
  Object.defineProperty(transport, "sessionId", { get: () => base.sessionId });
  base.onclose = () => transport.onclose?.();
  base.onerror = (error) => transport.onerror?.(error);
  base.onmessage = (message, extra) => {
    if ("id" in message && !("method" in message)) {
      if (typeof message.id !== "string" && typeof message.id !== "number") {
        transport.onmessage?.(message, extra);
        return;
      }
      const id = inbound.get(message.id);
      if (id === undefined) return; // A late response belonging to the evicted Client.
      inbound.delete(message.id);
      outbound.delete(id);
      const token = requestProgress.get(message.id);
      if (token !== undefined) progress.delete(token);
      requestProgress.delete(message.id);
      transport.onmessage?.({ ...message, id }, extra);
    } else if (
      "method" in message &&
      message.method === "notifications/progress"
    ) {
      const token = message.params?.progressToken;
      if (typeof token !== "string" && typeof token !== "number") return;
      const original = progress.get(token);
      if (original !== undefined)
        transport.onmessage?.(
          {
            ...message,
            params: { ...message.params, progressToken: original },
          },
          extra,
        );
    } else transport.onmessage?.(message, extra); // Server-owned requests/IDs are unchanged.
  };
  return transport;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
