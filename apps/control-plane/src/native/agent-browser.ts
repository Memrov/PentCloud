import { DurableObject } from "cloudflare:workers";
import { Browser, browserRun, type InternalHostMessage } from "agents/browser";
import { browserTool } from "agents/browser/ai-sdk";
import { Lifecycle } from "agents/lifecycle";
import worker, { actor } from "./worker";
import { hostedUIResponse } from "./ui-response";
import type { NativeEnv } from "./types";
import { readBounded } from "./material-store";
import { MATERIAL_FILE_LIMIT } from "./materials";

export const AGENT_BROWSER_ORIGIN = "http://pentcloud.internal";
const bootstrapPath = "/__pentcloud_agent_browser.js";
const digestPath = "/__pentcloud_agent_browser_digest";
// Native internal hosts use HTTP. Web Crypto's random bytes remain available,
// but randomUUID is secure-context-only. Keep this compatibility code private
// to this browser and use the same cryptographic entropy and UUID v4 bits.
const bootstrap = `if (!crypto.randomUUID) crypto.randomUUID = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0"));
  return [hex.slice(0,4).join(""), hex.slice(4,6).join(""), hex.slice(6,8).join(""), hex.slice(8,10).join(""), hex.slice(10).join("")].join("-");
};
if (!crypto.subtle) Object.defineProperty(crypto, "subtle", { value: {
  async digest(algorithm, data) {
    if ((typeof algorithm === "string" ? algorithm : algorithm?.name)?.toUpperCase() !== "SHA-256")
      throw new DOMException("Only SHA-256 is available", "NotSupportedError");
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const response = await fetch("${digestPath}", { method: "POST", body: bytes });
    if (!response.ok) throw new Error("Could not hash this upload; reconnect your agent and retry");
    return response.arrayBuffer();
  }
} });`;
export interface AgentBrowserAuthorization {
  assertion: string;
  origin: string;
  identity: string;
  expiresAt: number;
}

/** One private browser per verified operator, never shared with assessment browsers.
 * The assertion stays in memory on the server; Chromium never receives it. */
export class AgentBrowser extends DurableObject<NativeEnv> {
  private authorization: AgentBrowserAuthorization | undefined;
  private readonly browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      keepAliveMs: 10 * 60 * 1000,
      guardrails: { allowedDomains: [] },
      internalHosts: {
        router: this.ctx.exports.InternalHostRouter,
        hosts: {
          "pentcloud.internal": {
            description:
              "Your authenticated PentCloud application. Open http://pentcloud.internal/.",
            fetch: (request) =>
              agentBrowserResponse(request, this.authorization, this.env)
          }
        }
      }
    })
  });
  private readonly lifecycle = Lifecycle.install(this).use(this.browser);
  private readonly tool = browserTool({
    browser: {
      name: this.browser.name,
      connect: (options) => this.browser.connect(options),
      ...(this.browser.internalHosts
        ? { internalHosts: this.browser.internalHosts }
        : {})
    },
    loader: this.env.LOADER,
    timeoutMs: 45_000
  });

  async description() {
    return this.tool.description;
  }

  async execute(
    assertion: string,
    origin: string,
    code: string
  ): Promise<string> {
    // Defense in depth: the public MCP router already validated this assertion.
    const identity = await actor(
      new Request(origin, {
        headers: { "Cf-Access-Jwt-Assertion": assertion }
      }),
      this.env
    );
    if (identity === "access-service")
      throw Error("403: Sign in as an operator");
    this.authorization = {
      assertion,
      origin,
      identity,
      expiresAt: Date.now() + 5 * 60 * 1000
    };
    await this.lifecycle.start();
    return JSON.stringify(await this.tool.execute({ code }, {}));
  }

  async close() {
    this.authorization = undefined;
    await this.lifecycle.start();
    return { closed: await this.browser.close() };
  }

  fetchInternalHost(message: InternalHostMessage) {
    return this.browser.fetchInternalHost(message);
  }
}

export async function agentBrowserResponse(
  request: Request,
  auth: AgentBrowserAuthorization | undefined,
  env: NativeEnv
): Promise<Response> {
  if (!auth || auth.expiresAt <= Date.now())
    return new Response("Reconnect your agent to continue", { status: 401 });
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (
    url.origin !== AGENT_BROWSER_ORIGIN ||
    (origin && origin !== AGENT_BROWSER_ORIGIN) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site" ||
    request.headers.has("Upgrade") ||
    url.pathname === "/mcp"
  )
    return new Response("Unavailable in the application browser", {
      status: 403
    });
  const headers = new Headers(request.headers);
  for (const name of [
    "Authorization",
    "Cookie",
    "Cf-Access-Token",
    "Cf-Access-Jwt-Assertion",
    "Host"
  ])
    headers.delete(name);
  headers.set("Cf-Access-Jwt-Assertion", auth.assertion);
  if (origin) headers.set("Origin", auth.origin);
  const forwarded = new Request(auth.origin + url.pathname + url.search, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual"
  });
  try {
    // Validate expiry even for assets. Reconnection never extends a grant.
    if ((await actor(forwarded, env)) !== auth.identity)
      return new Response("Reconnect your agent", { status: 401 });
    if (url.pathname === bootstrapPath && request.method === "GET")
      return new Response(bootstrap, {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    if (url.pathname === digestPath && request.method === "POST") {
      if (!request.body)
        return new Response("Missing upload bytes", { status: 400 });
      let bytes: Uint8Array;
      try {
        bytes = await readBounded(request.body, MATERIAL_FILE_LIMIT);
      } catch {
        return new Response("Upload exceeds two MiB or could not be read", {
          status: 413
        });
      }
      return new Response(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store"
          }
        }
      );
    }
    const response = await worker.fetch(forwarded, env);
    const safe = new Headers(response.headers);
    safe.delete("Set-Cookie");
    safe.set("Cache-Control", "no-store");
    // Keep redirects inside the private hostname; never leak a login or bearer URL.
    const location = safe.get("Location");
    if (location) {
      const target = new URL(location, auth.origin);
      if (target.origin !== auth.origin)
        return new Response("External navigation is unavailable", {
          status: 403
        });
      safe.set(
        "Location",
        AGENT_BROWSER_ORIGIN + target.pathname + target.search + target.hash
      );
    }
    const result = hostedUIResponse(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: safe
      }),
      request.url
    );
    return result.headers.get("Content-Type")?.includes("text/html")
      ? new HTMLRewriter()
          .on("head", {
            element(head) {
              head.append(`<script src="${bootstrapPath}"></script>`, {
                html: true
              });
            }
          })
          .transform(result)
      : result;
  } catch {
    return new Response("Reconnect your agent to continue", { status: 401 });
  }
}
