import type { RouteContext } from "./context";
import { body } from "./context";
export async function routeLifecycle(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, url, path, coordinator } = context;
  if (path === "/lifecycle" && request.method === "GET")
    return Response.json(await coordinator.lifecycleStatus(), {
      headers: { "Cache-Control": "no-store" }
    });
  if (path === "/lifecycle/prepare-uninstall" && request.method === "POST")
    return Response.json(
      await coordinator.prepareUninstall(
        request.body ? (await body(request)).deleteOnboarding === true : false
      )
    );
  const lifecycleRoute = path.match(
    /^\/runs\/([A-Za-z0-9._-]+)(?:\/(archive|trash|restore|report|findings))?$/
  );
  if (lifecycleRoute) {
    const id = lifecycleRoute[1]!,
      action = lifecycleRoute[2];
    if (request.method === "DELETE" && !action) {
      const value = await body(request);
      return Response.json(
        await coordinator.purgeRun(id, String(value.confirm ?? ""))
      );
    }
    if (request.method === "POST" && action === "archive")
      return Response.json(await coordinator.archiveRun(id));
    if (request.method === "POST" && action === "trash")
      return Response.json(await coordinator.trashRun(id));
    if (request.method === "POST" && action === "restore")
      return Response.json(await coordinator.restoreRun(id));
    if (request.method === "GET" && action === "findings")
      return Response.json(
        await coordinator.findings(id, url.searchParams.get("job") ?? ""),
        { headers: { "Cache-Control": "private, no-store" } }
      );
    if (request.method === "GET" && action === "report")
      return coordinator.report(id, url.searchParams.get("job") ?? undefined);
  }
}
