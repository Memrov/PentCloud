import { buildCommand, type PackRequest } from "@memrov2/pentcloud-pcap";
export { PcapRunner } from "@memrov2/pentcloud-pcap/worker";
import type { PcapRunner } from "@memrov2/pentcloud-pcap/worker";
import { packWorker } from "../pack-worker";

export class PcapService extends packWorker<PcapRunner>(
  "pcap",
  (request) => buildCommand(request as PackRequest),
  (runner, request, files) =>
    runner.run(request as PackRequest, { input: files.input! })
) {}
