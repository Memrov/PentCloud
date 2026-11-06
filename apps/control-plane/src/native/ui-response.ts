/** Apply the browser policy to the hosted UI, including SPA fallback responses. */
export function hostedUIResponse(response: Response, requestURL: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  if (headers.get("Content-Type")?.includes("text/html")) {
    // Keep the private application HTML intact at the edge, including where
    // zone-wide analytics would otherwise inject a script blocked by the CSP.
    const cacheControl = headers.get("Cache-Control");
    if (!cacheControl?.split(",").some(value => value.trim().toLowerCase() === "no-transform"))
      headers.set("Cache-Control", [cacheControl, "no-transform"].filter(Boolean).join(", "));
    const url = new URL(requestURL);
    const socketOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
    headers.set("Content-Security-Policy", [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:", "font-src 'self' data:", `connect-src 'self' ${socketOrigin}`,
      "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'", "media-src 'none'",
      "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ].join("; "));
  }
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}
