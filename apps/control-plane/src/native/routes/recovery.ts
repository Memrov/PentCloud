import type { RouteContext } from "./context";
import { body } from "./context";
export async function routeRecovery(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, path, coordinator } = context;
  if (path === "/runtime-diagnostics" && request.method === "GET")
    return Response.json(await coordinator.diagnostics(), {
      headers: { "Cache-Control": "no-store" }
    });
  if (path === "/runtime-recovery" && request.method === "POST") {
    const value = await body(request);
    if (
      !Object.keys(value).every((key) =>
        ["scope", "observedAt", "attemptId"].includes(key)
      ) ||
      !["coordinator", "attempt"].includes(String(value.scope)) ||
      typeof value.observedAt !== "number" ||
      !Number.isSafeInteger(value.observedAt) ||
      value.observedAt < 0 ||
      (value.attemptId !== undefined &&
        (typeof value.attemptId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value.attemptId))) ||
      (value.scope === "attempt" && !value.attemptId)
    )
      throw new Error("400: invalid runtime recovery identity");
    return Response.json(
      await coordinator.rearmPlatformRecovery(
        value as {
          scope: "coordinator" | "attempt";
          observedAt: number;
          attemptId?: string;
        }
      )
    );
  }
}
