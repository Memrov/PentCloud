import { env } from "cloudflare:workers";
import { subscribe } from "agents/observability";
import { lifecycleDiagnostic, runtimeVersion } from "./runtime-diagnostics";

// One process-level subscription to the public SDK channel. No per-request or DO
// state is captured, and payload-bearing native events are ignored.
subscribe("lifecycle", event => {
  const diagnostic = lifecycleDiagnostic(event);
  if (!diagnostic) return;
  const metadata = { ...diagnostic, ...(runtimeVersion(env) ? { version: runtimeVersion(env) } : {}) };
  if (diagnostic.type === "alarm:memory_limit_reset" && diagnostic.sealed) console.error("pentagi.native.lifecycle", metadata);
  else console.warn("pentagi.native.lifecycle", metadata);
});
