export { NativeAttempt } from "./native/attempt";
export { TargetEgress } from "./native/target-egress";
export { NativeDynamicWorkerTail } from "./native/dynamic-worker-tail";
export { WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";
export { InternalHostRouter } from "agents/browser";
export default { fetch: () => new Response("Not found", { status: 404 }) };
