import { WorkerEntrypoint } from "cloudflare:workers";
import { dynamicWorkerFailure, runtimeVersion, type RuntimeVersion } from "./runtime-diagnostics";
import type { DynamicWorkerKind } from "./runtime-limits";
import type { NativeEnv } from "./types";

interface TailProps { kind: DynamicWorkerKind; version?: RuntimeVersion }

/** A local native Tail entrypoint; raw child events are deliberately discarded. */
export class NativeDynamicWorkerTail extends WorkerEntrypoint<NativeEnv, TailProps> {
  override async tail(events: TraceItem[]): Promise<void> {
    const kind = this.ctx.props.kind;
    if (!["shell", "javascript"].includes(kind)) return;
    const version = runtimeVersion({ CF_VERSION_METADATA: this.ctx.props.version });
    for (const event of events) {
      const failure = dynamicWorkerFailure(event);
      if (failure) {
        const incident = ["exception", "exceededCpu", "exceededMemory", "exceededSubrequests"].includes(String(failure.outcome));
        const metadata = { kind, ...failure, ...(version ? { version } : {}) };
        if (incident) console.error("pentagi.native.dynamic_worker", metadata);
        else console.warn("pentagi.native.dynamic_worker", metadata);
      }
    }
  }
}

export function dynamicWorkerTails(
  context: Pick<DurableObjectState, "exports">,
  env: Pick<NativeEnv, "CF_VERSION_METADATA">,
  kind: DynamicWorkerKind,
): Fetcher[] {
  // Older local fixtures intentionally omit this optional diagnostic export.
  const tail = context.exports.NativeDynamicWorkerTail;
  const version = runtimeVersion(env);
  return tail ? [tail({ props: { kind, ...(version ? { version } : {}) } })] : [];
}
