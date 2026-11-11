import { buildCommand, type PackRequest } from "@memrov2/pentcloud-http";
export { HttpRunner } from "@memrov2/pentcloud-http/worker";
import type { HttpRunner } from "@memrov2/pentcloud-http/worker";
import { packWorker } from "../pack-worker";

export class HttpService extends packWorker<HttpRunner>(
  "http",
  (request) => buildCommand(request as PackRequest),
  (runner, request) => runner.run(request as PackRequest)
) {}
