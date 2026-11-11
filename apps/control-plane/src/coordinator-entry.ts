export { Coordinator } from "./native/coordinator";
export { WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";
export default { fetch: () => new Response("Not found", { status: 404 }) };
