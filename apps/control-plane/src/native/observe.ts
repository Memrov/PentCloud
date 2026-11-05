import * as workers from "cloudflare:workers";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import type { WorkspaceObserver } from "@cloudflare/computer";
import { runtimeVersion } from "./runtime-diagnostics";

function versionAttributes() {
  const version = runtimeVersion(workers.env);
  return version ? {
    "cloudflare.version.id": version.id,
    ...(version.tag ? { "cloudflare.version.tag": version.tag } : {}),
  } : {};
}

/** DOs expose the module tracing handle; Workers may also expose it on ctx. */
export function nativeTracing(
  context: DurableObjectState,
): Tracing | undefined {
  return (
    (context as DurableObjectState & { tracing?: Tracing }).tracing ??
    workers.tracing
  );
}
/** Payloads never enter span attributes; unavailable user tracing is a no-op. */
export function observe<T>(
  context: DurableObjectState,
  name: string,
  attributes: Readonly<Record<string, string | number | boolean | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const tracing = nativeTracing(context);
  if (!tracing) return run();
  return tracing.enterSpan(name, (span) => {
    span.setAttributes({ ...attributes, ...versionAttributes() });
    return run();
  });
}

/** Workspace errors, paths and grep patterns can contain payloads. Export names only. */
export function workspaceObserver(
  context: DurableObjectState,
): WorkspaceObserver {
  const adapter = createCloudflareObserver({ tracing: nativeTracing(context) });
  return {
    span: (name, _attributes, run) =>
      adapter.span(name, versionAttributes(), () => run({ setAttribute() {} })),
  };
}
