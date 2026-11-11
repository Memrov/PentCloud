import { buildCommand, type PackRequest } from "@memrov2/pentcloud-password";
export { PasswordRunner } from "@memrov2/pentcloud-password/worker";
import type { PasswordRunner } from "@memrov2/pentcloud-password/worker";
import { packWorker } from "../pack-worker";

export class PasswordService extends packWorker<PasswordRunner>(
  "password",
  (request) => buildCommand(request as PackRequest),
  (runner, request, files) =>
    runner.run(request as PackRequest, {
      input: files.input!,
      ...(files.dictionary ? { dictionary: files.dictionary } : {})
    })
) {}
