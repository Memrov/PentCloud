import { assertAudience } from "./onboarding";
import { boundedText } from "./target-check";
import { targetHeaders } from "./target-headers";
export interface APIAccess {
  targetURL: string;
  header?: string;
  value?: string;
}
export interface APIRequest {
  path: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
}
export function validateAPIRequest(
  access: APIAccess,
  raw: unknown
): APIRequest {
  const input = raw as APIRequest;
  if (
    !input ||
    typeof input.path !== "string" ||
    input.path.length > 2048 ||
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(input.method) ||
    (input.body !== undefined &&
      (typeof input.body !== "string" ||
        new TextEncoder().encode(input.body).length > 65536))
  )
    throw new Error("400: Invalid bounded API request");
  if (["GET", "HEAD"].includes(input.method) && input.body)
    throw new Error("400: Read-only requests cannot include a body");
  const url = new URL(
    input.path,
    access.targetURL.endsWith("/") ? access.targetURL : access.targetURL + "/"
  );
  assertAudience(access.targetURL, url.href);
  return {
    path: url.href,
    method: input.method,
    ...(input.body !== undefined ? { body: input.body } : {})
  };
}
export async function performAPIRequest(
  access: APIAccess,
  raw: unknown,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
) {
  const input = validateAPIRequest(access, raw);
  const headers = targetHeaders(
    { Accept: "application/json,text/plain;q=0.9,*/*;q=0.1" },
    access.header && access.value
      ? { header: access.header, value: access.value }
      : undefined
  );
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetcher(input.path, {
    method: input.method,
    headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000)
  });
  return {
    url: input.path,
    status: response.status,
    authenticated: !!access.value,
    contentType: response.headers.get("Content-Type"),
    body: await boundedText(response)
  };
}
