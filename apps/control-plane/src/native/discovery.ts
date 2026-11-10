import { remoteResultObject } from "./tool-policy";

interface HTTPProbe {
  method: "HEAD" | "GET";
  status: "completed" | "failed" | "timed_out";
  http_status?: number;
  headers?: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  error?: string;
}
/** Read-only bootstrap probes share a deadline; scanners remain optional agent tools. */
export async function httpDiscovery(
  url: string,
  fetcher: (request: Request) => Promise<Response>,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("Initial discovery time budget expired")),
    10000
  );
  const combined = AbortSignal.any([
    deadline.signal,
    ...(signal ? [signal] : [])
  ]);
  try {
    const probes = await Promise.all(
      (["HEAD", "GET"] as const).map(async (method): Promise<HTTPProbe> => {
        const observed: Pick<HTTPProbe, "method" | "http_status" | "headers"> =
          { method };
        try {
          const response = await fetcher(
            new Request(url, { method, redirect: "manual", signal: combined })
          );
          observed.http_status = response.status;
          observed.headers = {};
          for (const name of [
            "content-type",
            "content-length",
            "server",
            "location",
            "www-authenticate",
            "retry-after"
          ])
            if (response.headers.has(name))
              observed.headers[name] = response.headers
                .get(name)!
                .slice(0, 2048);
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            if (method === "GET" && reader)
              while (size < 65536) {
                const chunk = await reader.read();
                if (chunk.done) break;
                const part = chunk.value.subarray(0, 65536 - size);
                chunks.push(part);
                size += part.byteLength;
              }
          } finally {
            await reader?.cancel().catch(() => undefined);
            reader?.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return {
            ...observed,
            status: "completed",
            ...(method === "GET"
              ? {
                  body: new TextDecoder().decode(bytes),
                  bodyTruncated: size === 65536
                }
              : {})
          };
        } catch (error) {
          return {
            ...observed,
            status: deadline.signal.aborted ? "timed_out" : "failed",
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    signal?.throwIfAborted();
    const completed = probes.filter((probe) => probe.status === "completed");
    return {
      status: completed.length ? "completed" : "failed",
      http_status: completed[0]?.http_status ?? null,
      coverage:
        completed.length === 2 && !probes.some((probe) => probe.bodyTruncated)
          ? "initial"
          : completed.length
            ? "partial"
            : "unavailable",
      budgetMs: 10000,
      probes
    };
  } finally {
    clearTimeout(timer);
  }
}
export function discoveryOutcome(raw: unknown): {
  success: boolean;
  status: string;
} {
  if (raw && typeof raw === "object" && "isError" in raw && raw.isError)
    return { success: false, status: "tool-error" };
  try {
    const result = remoteResultObject(raw),
      status = String(result.status ?? "unknown").toLowerCase();
    const completed =
      ["completed", "complete", "success", "succeeded"].includes(status) &&
      result.error == null &&
      result.success !== false;
    const observed =
      typeof result.http_status === "number" &&
      Number.isInteger(result.http_status) &&
      result.http_status >= 100 &&
      result.http_status <= 599;
    return {
      success: completed && observed,
      status: completed && !observed ? "no-http-response" : status
    };
  } catch {
    return { success: false, status: "invalid-result" };
  }
}
