import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { fetchWeb } from "agents/webfetch";
import { targetHeaders } from "./target-headers";

const RESULT_LIMIT = 2 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const MANAGED_SEARCH_PROVIDER = "tinyfish";

export function nativeSearchOptions(args:Record<string,unknown>){
  if(args.sort!==undefined&&args.sort!=="default")throw new Error("Native web search does not support date/CVSS sorting; omit sort or use default");
  if(args.exploit_type!==undefined)throw new Error("Native web search does not filter exploit types; include the desired type in query. Kali-capable roles can use stock Searchsploit");
  return {requested_mode:args.mode??"answer",behavior:"Sourced retrieval only. The current specialist synthesizes the answer, research or exploit assessment. No automatic provider failover or exploit-type sorting is applied."};
}

interface BrowserOptions {
  binding: Ai;
  scopes: readonly string[];
  signal: AbortSignal;
  fetch?: typeof fetch;
}

export async function managedBrowser(args: Record<string, unknown>, options: BrowserOptions): Promise<Record<string, unknown>> {
  const signal = options.signal;
  signal.throwIfAborted();
  const scopes = options.scopes.flatMap((scope) => {
    try { return [new URL(scope)]; } catch { return []; }
  });
  const allowed = (url: URL) => ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && scopes.some((base) =>
    base.origin === url.origin && (base.pathname.endsWith("/") ? url.pathname.startsWith(base.pathname) : base.pathname === url.pathname),
  );
  const target = new URL(String(args.url));
  if (!allowed(target)) throw new Error("Browser URL is outside the explicit engagement scope");
  const raw = args.action === "html" || args.action === "links";
  // The SDK owns streaming, redirect limits, conversion and cancellation. Its
  // fetch hook adds PentAGI's stricter origin/path policy at every network hop.
  const page = await fetchWeb({ url: target.href, format: raw ? "raw" : "auto" }, {
    binding: options.binding,
    // Explicitly scoped labs remain eligible; the fetch hook confines every hop.
    allowPrivateHosts: true,
    maxBytes: RESULT_LIMIT,
    maxRedirects: 10,
    signal,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!allowed(url)) throw new Error("Browser URL is outside the explicit engagement scope");
      const headers = targetHeaders(init?.headers);
      if (raw) headers.set("accept", "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8");
      const response = await (options.fetch ?? fetch)(url.href, { ...init, headers });
      if (REDIRECTS.has(response.status) && !response.headers.get("location")) {
        await response.body?.cancel();
        throw new Error("Browser redirect omitted Location");
      }
      return response;
    },
  });
  signal.throwIfAborted();
  const base = { status: page.status, url: page.finalUrl };
  if (args.action === "html") return boundedResult({ ...base, html: page.content });
  if (args.action === "links") {
    const links = new Set<string>();
    const rewritten = new HTMLRewriter().on("a[href]", { element(element) {
      try {
        const href = element.getAttribute("href")!.replaceAll("&amp;", "&").replace(/&#(x[0-9a-f]+|\d+);/gi, (_all, value: string) => {
          const point = value[0]?.toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value);
          return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
        });
        const url = new URL(href, page.finalUrl);
        if (allowed(url)) links.add(url.href);
      } catch { /* Malformed links are not navigation targets. */ }
    } }).transform(new Response(page.content, { headers: { "content-type": "text/html" } }));
    await rewritten.arrayBuffer();
    signal.throwIfAborted();
    return boundedResult({ ...base, links: [...links] });
  }
  return boundedResult({ ...base, markdown: page.content, format: page.via });
}

export async function managedWebSearch(query: string, limit: number, signal: AbortSignal, api: Pick<OpenCodeWorkerd.Interface["websearch"], "query">) {
  if (!query.trim() || query.length > 1024) throw new Error("Web search query must contain 1–1024 characters");
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  signal.throwIfAborted();
  const count = Math.max(1, Math.min(10, Number.isFinite(limit) ? Math.floor(limit) : 5));
  const startedAt = Date.now();
  // Explicit provider selection prevents silent fallback to a billed provider.
  // The application has no TinyFish key; keyless access carries no service SLA.
  // OpenCode owns TinyFish transport, decoding, deadlines and rate-limit errors.
  const response = await api.query({ query, providerID: MANAGED_SEARCH_PROVIDER }, { signal });
  signal.throwIfAborted();
  if (response.data.providerID !== MANAGED_SEARCH_PROVIDER) throw new Error("Native web search returned an unexpected provider");
  const seen = new Set<string>();
  const items = response.data.results.flatMap((item) => {
    try {
      const url = new URL(item.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ url: url.href, title: (item.title || url.href).slice(0, 500), description: (item.content ?? "").slice(0, 2000) }];
    } catch { return []; }
  }).slice(0, count);
  if (!items.length) throw new Error("Native web search returned no usable source evidence");
  return { items, provider: response.data.providerID, metadata: { query, requestId: crypto.randomUUID(), latencyMs: Date.now() - startedAt, limit: count } };
}

function boundedResult<T>(result: T): T {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > RESULT_LIMIT) throw new Error("Browser result exceeds the 2 MiB output limit");
  return result;
}
