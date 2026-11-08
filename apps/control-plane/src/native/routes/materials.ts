import type { RouteContext } from "./context";
import { MATERIAL_FILE_LIMIT } from "../materials";
import { confinedRelative } from "../tool-policy";
export async function routeMaterials(
  context: RouteContext
): Promise<Response | undefined> {
  const { request, url, path, coordinator, identity } = context;
  const upload = path.match(
    /^\/runs\/([A-Za-z0-9._-]+)\/uploads\/([A-Za-z0-9._-]+)$/
  );
  if (upload && request.method === "POST") {
    const name = url.searchParams.get("name") ?? "";
    const sha256 = request.headers.get("X-Content-SHA256") ?? "";
    if (
      !name.trim() ||
      name.length > 180 ||
      /[/\\\x00-\x1f\x7f]/.test(name) ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !request.body
    )
      throw new Error(
        "400: valid filename, SHA-256 and file body are required"
      );
    const length = request.headers.get("Content-Length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
    )
      throw new Error("400: invalid upload length");
    if (length !== null && Number(length) > MATERIAL_FILE_LIMIT)
      throw new Error("413: file exceeds 2 MiB");
    return Response.json(
      await coordinator.stageUpload({
        runId: upload[1]!,
        id: upload[2]!,
        name,
        sha256,
        body: request.body,
        uploadedBy: identity
      }),
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  }
  const fileRoute = path.match(/^\/runs\/([A-Za-z0-9._-]+)\/(files|file)$/);
  if (fileRoute && request.method === "GET") {
    const runId = fileRoute[1]!;
    if (fileRoute[2] === "files")
      return Response.json(
        await coordinator.files(
          runId,
          url.searchParams.get("job") ?? undefined
        ),
        { headers: { "Cache-Control": "no-store" } }
      );
    const commit = url.searchParams.get("commit") ?? "";
    const requested = url.searchParams.get("path") ?? "";
    if (
      !/^[a-f0-9]{40}$/.test(commit) ||
      !requested ||
      requested.split("/").includes(".git")
    )
      throw new Error("400: immutable commit and file path are required");
    let filePath: string;
    try {
      filePath = confinedRelative(requested);
    } catch {
      throw new Error("400: invalid file path");
    }
    const response = await coordinator.file(
      runId,
      commit,
      filePath,
      url.searchParams.get("preview") === "1"
    );
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    headers.set("Cache-Control", "private, no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, {
      status: response.status,
      headers
    });
  }
}
