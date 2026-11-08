import type { Browser } from "agents/browser";

export type BrowserLiveViewResult =
  | { available: false }
  | { available: true; readOnly: true; url: string; expiresAt: number };

/** Operator-only credentials: return directly to the caller, never persist or observe. */
export async function readonlyBrowserLiveView(
  browser: Pick<Browser, "liveView">,
  binding: Pick<BrowserRun, "getLiveView">
): Promise<BrowserLiveViewResult> {
  try {
    // The installed Browser's public accessor reads an existing session only.
    // Its default viewer links are discarded; only the guarded URL below leaves
    // this host-side call. resolve()/connect() would start a browser and are forbidden.
    const existing = await browser.liveView();
    const target = existing?.targets.find((item) => item.type === "page");
    if (!existing || !target) return { available: false };
    const expiresInMs = 60_000;
    const view = await binding.getLiveView(existing.sessionId, {
      mode: "tab",
      targetId: target.targetId,
      expiresInMs,
      guardrails: { mode: "readonly" }
    });
    const url = new URL(view.devtoolsFrontendUrl);
    if (
      view.options.mode !== "tab" ||
      view.options.guardrails?.mode !== "readonly" ||
      url.origin !== "https://live.browser.run" ||
      !url.pathname.startsWith("/ui/") ||
      url.username ||
      url.password
    )
      throw new Error("Provider did not confirm a readonly hosted view");
    return {
      available: true,
      readOnly: true,
      url: url.href,
      expiresAt: Date.now() + expiresInMs
    };
  } catch {
    // Provider errors may contain a signed URL. Keep them out of HTTP errors,
    // model transcripts, spans and logs as well as out of durable storage.
    throw new Error("503: Browser view is unavailable");
  }
}
