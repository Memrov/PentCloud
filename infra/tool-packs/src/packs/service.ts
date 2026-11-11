import { buildCommand, type PackRequest } from "@memrov2/pentcloud-service";
export { ServiceRunner } from "@memrov2/pentcloud-service/worker";
import type { ServiceRunner } from "@memrov2/pentcloud-service/worker";
import { packWorker } from "../pack-worker";

export class ServiceService extends packWorker<ServiceRunner>(
  "service",
  (request) => buildCommand(request as PackRequest),
  (runner, request) => runner.run(request as PackRequest)
) {}
