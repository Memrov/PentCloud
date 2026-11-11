import type { RouteContext } from "./context";
import { body } from "./context";
import type { AgentSettings } from "../../settings/catalog";
import { normalizeUploadIds } from "../materials";
export async function routeAdministration(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, url, path, coordinator, history, identity, env } = context;
  const preparation = path.match(/^\/runs\/([^/]+)\/preparation$/);
  if (preparation && request.method === "GET")
    return Response.json(
      await coordinator.runPreparation(decodeURIComponent(preparation[1]!)),
      { headers: { "Cache-Control": "no-store" } }
    );
  if (path === "/runs" && request.method === "GET") {
    const view = url.searchParams.get("view") ?? "active";
    if (!["active", "archived", "trash", "all"].includes(view))
      throw new Error("400: invalid run view");
    const current =
      view === "active"
        ? await coordinator.listRuns()
        : await coordinator.listRuns(view as "archived" | "trash" | "all");
    const previous =
      view === "active" || view === "all"
        ? await history.listRuns()
        : { runs: [] };
    const ids = new Set(current.runs.map((r) => r.id));
    return Response.json({
      runs: [...current.runs, ...previous.runs.filter((r) => !ids.has(r.id))]
    });
  }
  if (path === "/runs" && request.method === "POST") {
    const value = await body(request);
    if (value.upload_ids !== undefined)
      value.upload_ids = normalizeUploadIds(value.upload_ids);
    return Response.json(
      await (env.RUN_PREPARATION_WORKFLOW
        ? coordinator.enqueueRun({
            ...value,
            actor: identity
          } as unknown as import("../types").NewRunInput)
        : coordinator.createRun({
            ...value,
            actor: identity
          } as unknown as import("../types").NewRunInput)),
      { status: 202 }
    );
  }
  if (path === "/queue" && request.method === "GET")
    return Response.json(await coordinator.queueSnapshot());
  if (path === "/settings" && request.method === "GET")
    return Response.json(await coordinator.settings());
  if (path === "/settings" && request.method === "PUT") {
    const value = await body(request);
    const rawRevision = request.headers.get("If-Match");
    const revision = Number(rawRevision);
    if (
      rawRevision === null ||
      !/^\d+$/.test(rawRevision) ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      throw new Error("400: If-Match settings revision is required");
    return Response.json(
      await coordinator.saveSettings(
        value.roles as AgentSettings["roles"],
        revision,
        identity
      )
    );
  }
  if (path === "/settings/models" && request.method === "GET")
    return Response.json(
      await coordinator.modelCatalog(
        (url.searchParams.get("route") ?? "go") as "go" | "console",
        url.searchParams.get("refresh") === "1"
      ),
      { headers: { "Cache-Control": "no-store" } }
    );
}
