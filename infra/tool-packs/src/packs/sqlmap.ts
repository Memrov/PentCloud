import { buildCommand, type PackRequest } from "@memrov2/pentcloud-sqlmap";
export { SqlmapRunner } from "@memrov2/pentcloud-sqlmap/worker";
import type { SqlmapRunner } from "@memrov2/pentcloud-sqlmap/worker";
import { packWorker } from "../pack-worker";

export class SqlmapService extends packWorker<SqlmapRunner>(
  "sqlmap",
  (request) => buildCommand(request as PackRequest),
  (runner, request) => runner.run(request as PackRequest)
) {}
