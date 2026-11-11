import { buildCommand, type ReconRequest } from "@memrov2/pentcloud-recon";
export { ReconRunner } from "@memrov2/pentcloud-recon/worker";
import type { ReconRunner } from "@memrov2/pentcloud-recon/worker";
import { packWorker } from "../pack-worker";

function reconRequest(input: Record<string, unknown>): ReconRequest {
  const { tool, target } = input;
  if (
    (tool !== "httpx" &&
      tool !== "dnsx" &&
      tool !== "katana" &&
      tool !== "subfinder") ||
    typeof target !== "string" ||
    Object.keys(input).some((k) => k !== "tool" && k !== "target")
  )
    throw Error("Select one supported recon tool and target");
  return { tool, target };
}

export class ReconService extends packWorker<ReconRunner>(
  "recon",
  (request) => buildCommand(reconRequest(request)),
  (runner, request) => runner.run(reconRequest(request))
) {}
