import type { NativeEnv } from "../types";
import type { LegacyHistory } from "../history";
export interface RouteContext {
  request: Request;
  url: URL;
  path: string;
  env: NativeEnv;
  coordinator: ReturnType<NativeEnv["COORDINATOR"]["getByName"]>;
  history: LegacyHistory;
  identity: string;
}
export const browserViewHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer"
};
export async function body(
  request: Request,
  limit = 2300 * 1024
): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit)
    throw new Error("413: request too large");
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error("413: request too large");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("400: invalid JSON object");
  }
}
