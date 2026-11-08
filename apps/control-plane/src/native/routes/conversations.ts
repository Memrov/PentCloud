import type { RouteContext } from "./context";
import { body, browserViewHeaders } from "./context";
import { normalizeUploadIds } from "../materials";
export async function routeRunEvents(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, url, path, coordinator, history } = context;
  const run = path.match(
    /^\/runs\/([A-Za-z0-9._-]+)\/(jobs|workflow-events|cancel)$/
  );
  if (run) {
    const id = run[1]!,
      action = run[2]!;
    if (request.method === "GET") {
      try {
        if (action === "jobs")
          return Response.json(await coordinator.getRun(id));
        if (action === "workflow-events")
          return await coordinator.stream(id, request);
      } catch (error) {
        if (!String(error).includes("404:")) throw error;
        const archived = await history.getRun(id);
        if (action === "jobs") return Response.json(archived);
        return new Response(
          url.searchParams.get("protocol") === "2"
            ? "event: done\ndata: {}\n\n"
            : "event: end\ndata: {}\n\n",
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store"
            }
          }
        );
      }
    }
    if (action === "cancel" && request.method === "POST")
      return Response.json(await coordinator.cancelRun(id));
  }
}
export async function routeSessionControls(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, path, env } = context;
  const browserView = path.match(
    /^\/jobs\/([A-Za-z0-9._-]+)\/browser-live-view$/
  );
  if (browserView) {
    if (request.method !== "POST")
      return new Response("Not found", {
        status: 404,
        headers: browserViewHeaders
      });
    return Response.json(
      await env.ATTEMPTS.getByName(browserView[1]!).browserLiveView(),
      { headers: browserViewHeaders }
    );
  }
  const controls = path.match(/^\/jobs\/([A-Za-z0-9._-]+)\/session-controls$/);
  if (controls && request.method === "GET")
    return Response.json(
      await env.ATTEMPTS.getByName(controls[1]!).sessionControls(),
      { headers: { "Cache-Control": "no-store" } }
    );
  const nativeReply = path.match(
    /^\/jobs\/([A-Za-z0-9._-]+)\/(forms|permissions)\/([A-Za-z0-9._~-]{1,255})\/(reply|cancel)$/
  );
  if (
    nativeReply &&
    request.method === "POST" &&
    !(nativeReply[2] === "permissions" && nativeReply[4] === "cancel")
  ) {
    const input = await body(request);
    return Response.json(
      await env.ATTEMPTS.getByName(nativeReply[1]!).replyNative(
        nativeReply[2] === "forms" ? "form" : "permission",
        nativeReply[3]!,
        input,
        nativeReply[4] === "cancel"
      ),
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
export async function routeConversation(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, path, env, coordinator, history } = context;
  const job = path.match(
    /^\/jobs\/([A-Za-z0-9._-]+)\/(events|inspect|steer|revisions|interrupt)$/
  );
  if (job) {
    const id = job[1]!,
      action = job[2]!;
    if (action === "events" && request.method === "GET") {
      let response: Response;
      try {
        response = await env.ATTEMPTS.getByName(id).events(request);
      } catch (error) {
        if (!/not initialized|not found|404|uninitialized/i.test(String(error)))
          throw error;
        return await history.events(id);
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return await history.events(id);
      }
      return response;
    }
    if (action === "inspect" && request.method === "GET")
      return Response.json(await env.ATTEMPTS.getByName(id).inspect());
    if (request.method === "POST") {
      if (action === "interrupt")
        return Response.json(await coordinator.interrupt(id));
      if (action === "steer" || action === "revisions") {
        const value = await body(request);
        if (action === "steer") {
          if (typeof value.message !== "string")
            throw new Error("400: steering message must be a string");
          return Response.json(await coordinator.steer(id, value.message));
        }
        if (
          typeof value.instructions !== "string" ||
          typeof value.request_id !== "string"
        )
          throw new Error(
            "400: revision instructions and request identity must be strings"
          );
        return Response.json(
          value.upload_ids === undefined
            ? await coordinator.revise(id, value.instructions, value.request_id)
            : await coordinator.revise(
                id,
                value.instructions,
                value.request_id,
                undefined,
                normalizeUploadIds(value.upload_ids)
              ),
          { status: 202 }
        );
      }
    }
  }
}
