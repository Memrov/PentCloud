import { Browser, browserRun, type ListableBrowserSessionStore, type StoredBrowserSession } from "agents/browser";
import { readonlyBrowserLiveView } from "../../src/native/browser-live-view";

interface CanaryEnv {BROWSER: BrowserRun; CANARY_TOKEN: string}
interface Evidence {
  result: "passed" | "failed";
  phase: string;
  initialUnavailable: boolean;
  acquisitions: number;
  viewerRequests: number;
  readOnly: boolean;
  hostedOrigin?: string;
  expiresInMsRequested?: number;
  blankPage: boolean;
  credentialsInStore: boolean;
  closed: boolean;
  modelCalls: 0;
  scannerCalls: 0;
  kaliCalls: 0;
}

/** One request, one memory-only Browser. No Durable Object, storage, model or toolbox. */
export async function runBrowserLiveViewCanary(env: CanaryEnv): Promise<Evidence> {
  const records = new Map<string, StoredBrowserSession>();
  const locks = new Map<string, Promise<void>>();
  const store: ListableBrowserSessionStore = {
    async acquireLock(key) {
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>(resolve => { release = resolve; });
      const tail = previous.then(() => current);
      locks.set(key, tail);
      await previous;
      return {release() {release(); if (locks.get(key) === tail) locks.delete(key);}};
    },
    get: key => records.get(key),
    set: (key, record) => {records.set(key, record);},
    delete: key => {records.delete(key);},
    list: prefix => new Map([...records].filter(([key]) => key.startsWith(prefix))),
  };
  const evidence: Evidence = {
    result: "failed", phase: "initial", initialUnavailable: false, acquisitions: 0,
    viewerRequests: 0, readOnly: false, blankPage: false, credentialsInStore: false,
    closed: false, modelCalls: 0, scannerCalls: 0, kaliCalls: 0,
  };
  let sessionId: string | undefined;
  let closeRequested = false;
  const provider = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => env.BROWSER.fetch(input, init),
    acquire: async (options?: BrowserRunAcquireOptions) => {
      evidence.acquisitions++;
      const session = await env.BROWSER.acquire(options);
      sessionId = session.sessionId;
      return session;
    },
    closeSession: async (id: string) => {
      try { const result = await env.BROWSER.closeSession(id); closeRequested = true; return result; }
      catch { throw new Error("Canary session close failed"); }
    },
  };
  const browser = new Browser({
    store,
    provider: browserRun(provider, {keepAliveMs: 60_000, guardrails: {allowedDomains: []}}),
  });
  try {
    const initial = await readonlyBrowserLiveView(browser, env.BROWSER);
    evidence.initialUnavailable = !initial.available && evidence.acquisitions === 0 && records.size === 0;
    if (!evidence.initialUnavailable) throw new Error("Initial lookup woke a browser");
    evidence.phase = "acquire";
    // Intentional canary setup only: the production viewer never calls resolve.
    const existing = await browser.resolve();
    sessionId = existing.sessionId;
    if (evidence.acquisitions !== 1) throw new Error("Expected one canary browser");
    evidence.phase = "blank-page";
    let targets = await env.BROWSER.devtools.listTargets(sessionId, {liveViewUrlExpiresInMs: 60_000});
    if (!targets.some(target => target.type === "page")) {
      await env.BROWSER.devtools.newTarget(sessionId, "about:blank", {liveViewUrlExpiresInMs: 60_000});
      targets = await env.BROWSER.devtools.listTargets(sessionId, {liveViewUrlExpiresInMs: 60_000});
    }
    evidence.blankPage = targets.some(target => target.type === "page") && targets.filter(target => target.type === "page").every(target => target.url === "about:blank");
    if (!evidence.blankPage) throw new Error("Expected blank canary page");
    evidence.phase = "readonly-view";
    const view = await readonlyBrowserLiveView(browser, {getLiveView: async (id, options) => {
      evidence.viewerRequests++;
      if (options?.expiresInMs !== undefined) evidence.expiresInMsRequested = options.expiresInMs;
      return env.BROWSER.getLiveView(id, options);
    }});
    if (!view.available) throw new Error("Expected readonly view of the canary browser");
    evidence.readOnly = view.readOnly;
    evidence.hostedOrigin = new URL(view.url).origin;
    evidence.credentialsInStore = JSON.stringify([...records]).includes(view.url) || /jwt=|live\.browser\.run/.test(JSON.stringify([...records]));
    if (!view.readOnly || evidence.credentialsInStore || evidence.viewerRequests !== 1 || evidence.acquisitions !== 1)
      throw new Error("Readonly credential contract failed");
    evidence.result = "passed";
  } catch {
    // Browser responses and errors can contain bearer URLs. Only fixed metadata
    // may leave this function; never log, persist or return provider payloads.
    evidence.result = "failed";
  } finally {
    if (sessionId) {
      try {
        await browser.close();
        if (!closeRequested) await env.BROWSER.closeSession(sessionId);
        // Positive readback of our own session only; this never acquires a browser.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const observed = await env.BROWSER.getSession(sessionId);
            if (!observed || (typeof observed.endTime === "number" && observed.endTime > 0)) {evidence.closed = true; break;}
          } catch (error) {
            if (/status=(404|410)[,)]/.test(error instanceof Error ? error.message : "")) {evidence.closed = true; break;}
          }
          if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch { /* Fixed failure metadata below; never serialize provider errors. */ }
    }
    if (!evidence.closed) evidence.result = "failed";
    if (evidence.result === "passed") evidence.phase = "complete";
    records.clear();
  }
  return evidence;
}

export default {async fetch(request: Request, env: CanaryEnv): Promise<Response> {
  const headers = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"};
  if (!env.CANARY_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.CANARY_TOKEN}`)
    return Response.json({error: "Unauthorized"}, {status: 401, headers});
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET") return Response.json({ready: true}, {headers});
  if (path !== "/run" || request.method !== "POST") return new Response("Not found", {status: 404, headers});
  const evidence = await runBrowserLiveViewCanary(env);
  return Response.json(evidence, {status: evidence.result === "passed" ? 200 : 503, headers});
}};
