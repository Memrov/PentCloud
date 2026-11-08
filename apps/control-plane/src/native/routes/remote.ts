import type { RouteContext } from "./context";
import { body } from "./context";
export async function routeRemoteReceipts(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, path, env, coordinator } = context;
  const remoteReceipt = path.match(
    /^\/jobs\/([A-Za-z0-9._-]+)\/remote-receipts(?:\/([^/]+)\/(reconcile))?$/
  );
  const apiReceipt = path.match(
    /^\/jobs\/([A-Za-z0-9._-]+)\/api-receipts\/([^/]+)\/reconcile$/
  );
  if (apiReceipt && request.method === "POST") {
    const attempt = env.ATTEMPTS.getByName(apiReceipt[1]!);
    const result = await attempt.reconcileAPIReceipt(
      decodeURIComponent(apiReceipt[2]!),
      (await body(request)) as {
        reference: string;
        outcome: "completed" | "not-executed";
        confirm: string;
      }
    );
    await coordinator.reconcileToolOutcome(apiReceipt[1]!);
    return Response.json(result);
  }
  if (remoteReceipt) {
    const id = remoteReceipt[1]!,
      attempt = env.ATTEMPTS.getByName(id);
    if (!remoteReceipt[2] && request.method === "GET")
      return Response.json(await attempt.remoteReceipts());
    if (remoteReceipt[2] && request.method === "POST") {
      let receiptId: string;
      try {
        receiptId = decodeURIComponent(remoteReceipt[2]);
      } catch {
        throw new Error("400: invalid remote receipt identifier");
      }
      if (!/^[A-Za-z0-9._~-]{1,300}$/.test(receiptId))
        throw new Error("400: invalid remote receipt identifier");
      const value = await body(request);
      if (
        typeof value.inspectionTool !== "string" ||
        typeof value.scanId !== "string"
      )
        throw new Error("400: inspectionTool and scanId must be strings");
      const proof = {
        inspectionTool: value.inspectionTool,
        scanId: value.scanId,
        ...(value.identityEvidence === undefined
          ? {}
          : { identityEvidence: value.identityEvidence })
      } as Parameters<typeof attempt.reconcileRemote>[1];
      const result: unknown = await attempt.reconcileRemote(receiptId, proof);
      if (
        !result ||
        typeof result !== "object" ||
        !("reconciled" in result) ||
        result.reconciled !== true
      )
        throw new Error("409: remote outcome remains unresolved");
      await coordinator.reconcileToolOutcome(id);
      return Response.json(result);
    }
  }
}
export async function routeRemoteControl(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, path, env, coordinator } = context;
  const remoteControl = path.match(
    /^\/jobs\/([A-Za-z0-9._-]+)\/remote-control$/
  );
  if (remoteControl && request.method === "POST") {
    const value = await body(request);
    if (
      typeof value.tool !== "string" ||
      !value.tool.trim() ||
      !value.args ||
      typeof value.args !== "object" ||
      Array.isArray(value.args) ||
      typeof value.request_id !== "string" ||
      !value.request_id.trim()
    )
      throw new Error("400: tool, args object, and request_id are required");
    const id = remoteControl[1]!;
    const result: unknown = await env.ATTEMPTS.getByName(id).controlRemote(
      value.tool,
      value.args as Record<string, unknown>,
      value.request_id
    );
    if (
      !result ||
      typeof result !== "object" ||
      !("controlled" in result) ||
      result.controlled !== true ||
      !("verified" in result) ||
      typeof result.verified !== "boolean"
    )
      throw new Error("409: remote control outcome remains unresolved");
    if (result.verified) await coordinator.reconcileToolOutcome(id);
    return Response.json(result, { status: result.verified ? 200 : 202 });
  }
}
export async function routeRemoteInspection(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, path, env } = context;
  const remoteInspect = path.match(
    /^\/jobs\/([A-Za-z0-9._-]+)\/remote-inspect$/
  );
  if (remoteInspect && request.method === "POST") {
    const value = await body(request);
    if (
      typeof value.tool !== "string" ||
      !value.args ||
      typeof value.args !== "object" ||
      Array.isArray(value.args)
    )
      throw new Error("400: tool and args object are required");
    return Response.json(
      await env.ATTEMPTS.getByName(remoteInspect[1]!).inspectRemote(
        value.tool,
        value.args as Record<string, unknown>
      )
    );
  }
}
