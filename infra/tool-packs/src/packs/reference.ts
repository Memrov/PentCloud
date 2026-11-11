import {
  buildCommand,
  referencePath,
  type PackRequest
} from "@memrov2/pentcloud-reference";
export { ReferenceRunner } from "@memrov2/pentcloud-reference/worker";
import type { ReferenceRunner } from "@memrov2/pentcloud-reference/worker";
import { packWorker } from "../pack-worker";

function validate(request: Record<string, unknown>): void {
  if (request.action === "read-source") {
    if (
      Object.keys(request).some((k) => !["action", "path"].includes(k)) ||
      typeof request.path !== "string"
    )
      throw Error("Select a pinned reference source path");
    referencePath(request.path);
  } else {
    buildCommand(request as PackRequest);
  }
}

export class ReferenceService extends packWorker<ReferenceRunner>(
  "reference",
  validate,
  async (runner, request) => {
    if (request.action !== "read-source")
      return runner.run(request as PackRequest);
    const source = await runner.readSource(String(request.path));
    return {
      ...source,
      bytes: undefined,
      bytesBase64: btoa(
        Array.from(source.bytes, (b) => String.fromCharCode(b)).join("")
      ),
      text: new TextDecoder().decode(source.bytes),
      size: source.bytes.byteLength
    };
  }
) {}
