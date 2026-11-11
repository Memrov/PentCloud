import { buildCommand, type PackRequest } from "@memrov2/pentcloud-web-context";
export { WebContextRunner } from "@memrov2/pentcloud-web-context/worker";
import type { WebContextRunner } from "@memrov2/pentcloud-web-context/worker";
import { packWorker } from "../pack-worker";

export class WebContextService extends packWorker<WebContextRunner>(
  "web-context",
  (request) => buildCommand(request as PackRequest),
  (runner, request) => runner.run(request as PackRequest)
) {}
