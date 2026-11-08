import { targetHeaders } from "./target-headers";

export interface AddressCheck {
  url: string;
  status: number;
  classification:
    | "reachable"
    | "needs-auth"
    | "path-review"
    | "rate-limited"
    | "redirect-review"
    | "unavailable";
  redirectURL?: string;
}
export function normalizeTargetURL(raw: string): string {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.trim())
    throw new Error("400: Enter a website or API address");
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(raw.trim())
        ? raw.trim()
        : "https://" + raw.trim()
    );
  } catch {
    throw new Error("400: Enter a valid HTTP or HTTPS address");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
    throw new Error("400: Only HTTP and HTTPS targets are supported");
  if (url.username || url.password)
    throw new Error(
      "400: Put credentials in API test access, not in the address"
    );
  if (url.hash || url.search)
    throw new Error(
      "400: Enter a base address without a query or fragment; use API test access for credentials"
    );
  return url.href;
}
export async function boundedText(
  response: Response,
  limit = 65536
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const pieces: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.length > limit)
        throw new Error("413: Response exceeds the allowed size");
      size += chunk.value.length;
      pieces.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const p of pieces) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return new TextDecoder().decode(bytes);
}
export async function checkAddress(
  raw: string,
  fetcher: typeof fetch = fetch
): Promise<AddressCheck> {
  const url = normalizeTargetURL(raw),
    signal = AbortSignal.timeout(5000);
  const call = (method: string) =>
    fetcher(url, {
      method,
      redirect: "manual",
      signal,
      headers: targetHeaders({ "User-Agent": "PentCloud address check" })
    });
  let response: Response;
  try {
    response = await call("HEAD");
    if ([405, 501].includes(response.status)) {
      await response.body?.cancel();
      response = await call("GET");
    }
    const status = response.status;
    await response.body?.cancel();
    if (status >= 300 && status < 400 && response.headers.get("Location")) {
      const redirectURL = normalizeTargetURL(
        new URL(response.headers.get("Location")!, url).href
      );
      return { url, status, classification: "redirect-review", redirectURL };
    }
    return {
      url,
      status,
      classification: [401, 403].includes(status)
        ? "needs-auth"
        : status === 404
          ? "path-review"
          : status === 429
            ? "rate-limited"
            : status >= 200 && status < 400
              ? "reachable"
              : "unavailable"
    };
  } catch {
    throw new Error(
      "503: Address check could not complete. Check the address, TLS and connectivity, then retry."
    );
  }
}
