import {
  assertTargetRequest,
  requestHeaders,
  type ScopedTarget
} from "../../../../shared/target-access";
/** All redirects return to the client and must pass the same boundary on the next request. */
export async function performTargetFetch(
  target: ScopedTarget,
  request: Request,
  fetcher: typeof fetch = fetch,
  credential?: { header: string; value: string }
): Promise<Response> {
  const url = assertTargetRequest(target, request.url);
  if (
    !["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(
      request.method
    )
  )
    throw new Error("403: This HTTP method is unavailable for managed targets");
  if (request.headers.get("Upgrade"))
    throw new Error(
      "403: WebSocket upgrades are unavailable for managed targets"
    );
  const size = Number(request.headers.get("Content-Length") ?? 0);
  if (size > 2 * 1024 * 1024)
    throw new Error("413: Target request is too large");
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.body) {
    const reader = request.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2 * 1024 * 1024)
          throw new Error("413: Target request is too large");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const headers = requestHeaders(target, request.headers, {
    cookies: true,
    targetContext: true,
    ...(credential ? { credential } : {})
  });
  return fetcher(url.href, {
    method: request.method,
    headers,
    ...(body ? { body } : {}),
    redirect: "manual",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)])
  });
}
