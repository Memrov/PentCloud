import {
  toolboxGeneration,
  type ToolboxLifecycle,
  type ToolboxReadiness,
  type ToolboxFailure
} from "../../../../shared/toolbox-rpc";
export {
  TOOLBOX_GENERATION_HEADER,
  toolboxGeneration
} from "../../../../shared/toolbox-rpc";
const REQUEST_TIMEOUT_MS = 10_000;

/** A bounded startup observation; the existing Coordinator wake retries later. */
export class ToolboxPendingError extends Error {
  constructor() {
    super(
      "503: native toolbox is starting; durable recovery will retry readiness"
    );
    this.name = "ToolboxPendingError";
  }
}
/** Never initialize another MCP session or retry a mutation after boot identity loss. */
export class ToolboxGenerationLostError extends Error {
  constructor(readonly confirmedLost = false) {
    super(
      "409: native toolbox generation was lost; existing scanner/session outcomes remain fenced"
    );
    this.name = "ToolboxGenerationLostError";
  }
}

/** RPC has no Request signal. Bound the observation without retrying remote mutations. */
function observe<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      reject(new ToolboxPendingError());
    }, REQUEST_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    pending.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

/** Only unpinned readiness can boot. The first observed generation pins subsequent polls. */
export async function waitForToolbox(
  gateway: Pick<ToolboxLifecycle, "ready">,
  generation: string | undefined,
  options: {
    signal?: AbortSignal;
    startupWindowMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<string> {
  if (generation !== undefined && !toolboxGeneration(generation))
    throw new ToolboxGenerationLostError();
  const until = Date.now() + (options.startupWindowMs ?? 150_000);
  for (;;) {
    options.signal?.throwIfAborted();
    let reply: ToolboxReadiness | ToolboxFailure | undefined;
    try {
      reply = await observe(gateway.ready(generation), options.signal);
    } catch {
      options.signal?.throwIfAborted();
    }
    if (reply && "error" in reply) {
      if (reply.error === "generation_lost")
        throw new ToolboxGenerationLostError(true);
    } else if (reply) {
      if (!toolboxGeneration(reply.generation))
        throw new Error(
          "503: native toolbox readiness returned an invalid generation"
        );
      if (generation && reply.generation !== generation)
        throw new ToolboxGenerationLostError();
      generation = reply.generation;
      if (reply.state === "ready") return reply.generation;
      if (reply.state !== "booting")
        throw new Error("503: native toolbox readiness state is invalid");
    }
    if (Date.now() >= until) throw new ToolboxPendingError();
    await pause(options.pollIntervalMs ?? 2000, options.signal);
  }
}

/** Activity only refreshes an existing matching native container; it cannot boot. */
export async function touchToolbox(
  gateway: Pick<ToolboxLifecycle, "activity">,
  generation: string
): Promise<void> {
  if (!toolboxGeneration(generation)) throw new ToolboxGenerationLostError();
  const reply = await observe(gateway.activity(generation));
  if ("error" in reply) {
    if (reply.error === "generation_lost")
      throw new ToolboxGenerationLostError(true);
    throw new ToolboxPendingError();
  }
  if (reply.generation !== generation) throw new ToolboxGenerationLostError();
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
