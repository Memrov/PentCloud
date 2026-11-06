import { env, exports as entrypoints } from "cloudflare:workers";
import { dynamicWorkerTails } from "./dynamic-worker-tail";
import { budgetLoader, dynamicWorkerBudgets } from "./runtime-limits";
import rendererBytes from "./assets/prompt-renderer.bin";
import wasmExecSource from "./assets/wasm_exec.txt";
import workerSource from "./prompt-renderer-worker.txt";
import hashes from "./assets/SHA256SUMS.txt";
import { toolPackInstructions } from "./tool-backend";

export interface LaunchContext {
  toolBackend?: "tool-packs" | "stock-kali";
  promptFormat?: "markdown" | "pentagi-template";
  now?: string | Date;
  cwd?: string;
  dockerImage?: string;
  lang?: string;
  userFiles?: string;
  enabledTools?: string[];
}
interface RenderResponse {
  prompt?: string;
  promptDigest?: string;
  error?: string;
}

let workerName: Promise<string> | undefined;
async function rendererName(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(hashes + wasmExecSource + workerSource),
  );
  return "pentcloud-prompts-" + [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function entrypoint(): Promise<Fetcher> {
  if (!env.LOADER)
    throw new Error("Private prompt renderer requires the Worker Loader binding");
  // Only immutable Data is imported here. Wasm compilation and Go's runtime/heap
  // belong to the private child, outside OpenCode and Workspace's isolate.
  const name = await (workerName ??= rendererName());
  return budgetLoader(env.LOADER, dynamicWorkerBudgets["prompt-renderer"], dynamicWorkerTails({ exports: entrypoints }, env, "prompt-renderer")).get(name, () => ({
    compatibilityDate: "2026-08-27",
    mainModule: "worker.js",
    modules: {
      "worker.js": workerSource,
      "wasm_exec.js": wasmExecSource,
      "prompt-renderer.wasm": { wasm: rendererBytes },
    },
    globalOutbound: null,
  })).getEntrypoint();
}

async function render(input: object): Promise<RenderResponse> {
  const response = await (await entrypoint()).fetch(
    "https://prompt.internal/render",
    { method: "POST", body: JSON.stringify(input) },
  );
  if (!response.ok) throw new Error("Private Go prompt renderer failed");
  const result = await response.json() as RenderResponse;
  if (result.error) throw new Error(result.error);
  return result;
}

/** Safe diagnostic for local/protected startup probes; no prompt payloads. */
export async function promptRendererMemory(): Promise<{
  linearMemoryBytes: number;
  isolated: true;
}> {
  const response = await (await entrypoint()).fetch("https://prompt.internal/memory");
  const memory = await response.json() as { linearMemoryBytes: number };
  return { ...memory, isolated: true };
}

/** Exact Go text/template parsing and execution, including validation errors. */
export async function renderTemplate(
  source: string,
  data: Record<string, unknown>,
): Promise<string> {
  return (await render({ operation: "template", source, data })).prompt ?? "";
}

/** Original launchprompt defaults, JSON canonicalization, wrapper and SHA-256. */
export async function renderLaunch(
  role: string,
  args: Record<string, unknown>,
  source: string,
  context: LaunchContext = {},
): Promise<{ prompt: string; promptDigest: string }> {
  if (context.promptFormat === "markdown") {
    const { renderMarkdownLaunch } = await import("./markdown-launch");
    return renderMarkdownLaunch(role, args, source, context);
  }
  const result = await render({ operation: "launch", role, args, source, context });
  if (result.prompt === undefined || !result.promptDigest)
    throw new Error("Incomplete Go launch response");
  return { prompt: result.prompt + (context.toolBackend==="tool-packs" ? "\n# Installed tool backend\n\n"+toolPackInstructions+"\n" : ""), promptDigest: result.promptDigest };
}
