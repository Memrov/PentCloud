import { buildCommand, type PackRequest } from "@memrov2/pentcloud-nuclei";
export { NucleiRunner } from "@memrov2/pentcloud-nuclei/worker";
import type { NucleiRunner } from "@memrov2/pentcloud-nuclei/worker";
import { packWorker } from "../pack-worker";

export class NucleiService extends packWorker<NucleiRunner>(
  "nuclei",
  (request) => buildCommand(request as PackRequest),
  (runner, request) => runner.run(request as PackRequest)
) {}
