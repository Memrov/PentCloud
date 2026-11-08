import type { RouteContext } from "./context";
import { body } from "./context";
export async function routeOnboarding(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, url, path, coordinator, identity } = context;
  const definition = path.match(/^\/targets\/([A-Za-z0-9._-]+)\/definition$/);
  if (definition) {
    if (request.method === "GET")
      return coordinator.targetDefinition(
        definition[1]!,
        url.searchParams.has("version")
          ? Number(url.searchParams.get("version"))
          : undefined
      );
    if (request.method === "POST") {
      const name = url.searchParams.get("name") ?? "",
        sha256 = request.headers.get("X-Content-SHA256") ?? "",
        revision = request.headers.get("If-Match") ?? "0";
      if (
        !request.body ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !/^\d+$/.test(revision)
      )
        throw new Error(
          "400: File body, SHA-256 and expected definition version are required"
        );
      return Response.json(
        await coordinator.saveTargetDefinition(
          definition[1]!,
          Number(revision),
          { name, sha256, body: request.body, uploadedBy: identity }
        ),
        { status: 201, headers: { "Cache-Control": "no-store" } }
      );
    }
  }
  const pendingCreation = path.match(
    /^\/onboarding\/pending\/([A-Za-z0-9._-]+)$/
  );
  if (pendingCreation && request.method === "GET")
    return Response.json(
      await coordinator.creationSnapshot(pendingCreation[1]!),
      { headers: { "Cache-Control": "no-store" } }
    );
  if (path === "/onboarding" && request.method === "GET")
    return Response.json(
      await coordinator.onboardingSnapshot(
        url.searchParams.get("run") ?? undefined
      ),
      { headers: { "Cache-Control": "no-store" } }
    );
  if (path === "/onboarding/export" && request.method === "GET")
    return Response.json(await coordinator.onboardingExport(), {
      headers: { "Cache-Control": "no-store" }
    });
  const onboardingAction = path.match(
    /^\/onboarding\/([a-z]+(?:\.[a-z]+){1,2})$/
  );
  if (onboardingAction && request.method === "POST") {
    const input = await body(
      request,
      onboardingAction[1] === "metadata.import" ? 16 * 1024 * 1024 : 2300 * 1024
    );
    if (onboardingAction[1]!.startsWith("credential."))
      throw new Error(
        "400: Manage credentials through Cloudflare secret bindings"
      );
    return Response.json(
      await coordinator.onboardingAction(onboardingAction[1]!, input, identity),
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const activation = path.match(/^\/runs\/([A-Za-z0-9._-]+)\/analysis$/);
  if (activation && request.method === "POST") {
    const value = await body(request);
    if (
      typeof value.revision !== "number" ||
      typeof value.requestId !== "string"
    )
      throw new Error("400: Setup revision and request ID are required");
    return Response.json(
      await coordinator.activateAnalysis(
        activation[1]!,
        value.revision,
        value.requestId,
        value.acknowledgeFailure === true,
        typeof value.definitionVersion === "number"
          ? value.definitionVersion
          : 0
      ),
      { status: 202 }
    );
  }
}
