import type { RouteContext } from "./context";
import {
  TOOLBOX_GENERATION_HEADER,
  toolboxOperatorReply
} from "../../../../../shared/toolbox-rpc";
export async function routeToolbox(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, url, path, env } = context;
  if (
    !url.search &&
    ((path === "/toolbox/status" && ["GET", "POST"].includes(request.method)) ||
      (path === "/toolbox/start" && request.method === "POST"))
  ) {
    if (!env.TOOLBOX)
      return Response.json(
        {
          state: "not-installed",
          ...(env.TOOL_PACKS ? { runtime: "Cloudflare tool packs" } : {})
        },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    const reply = path.endsWith("status")
      ? await env.TOOLBOX.status()
      : await env.TOOLBOX.ready(
          request.headers.get(TOOLBOX_GENERATION_HEADER) ?? undefined
        );
    return toolboxOperatorReply(reply);
  }
}
