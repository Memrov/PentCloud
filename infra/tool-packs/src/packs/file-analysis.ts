import {
  buildCommand,
  type PackRequest
} from "@memrov2/pentcloud-file-analysis";
export { FileRunner } from "@memrov2/pentcloud-file-analysis/worker";
import type { FileRunner } from "@memrov2/pentcloud-file-analysis/worker";
import { packWorker } from "../pack-worker";

export class FileService extends packWorker<FileRunner>(
  "file-analysis",
  (request) => buildCommand(request as PackRequest),
  (runner, request, files) =>
    runner.run(request as PackRequest, { input: files.input! })
) {}
