import { WorkerEntrypoint } from "cloudflare:workers";
import type { NativeEnv } from "./types";
/** Private, attempt-bound capability used by the native Worker shell. */
export class TargetEgress extends WorkerEntrypoint<
  NativeEnv,
  { attempt?: string }
> {
  override async fetch(request: Request): Promise<Response> {
    const id = this.ctx.props.attempt;
    if (!id || !/^[a-f0-9]{64}$/.test(id))
      return new Response("No active assessment", { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete("X-Pentcloud-Egress-Attempt");
    try {
      return await this.env.ATTEMPTS.get(
        this.env.ATTEMPTS.idFromString(id)
      ).targetFetch(new Request(request, { headers }));
    } catch {
      return new Response("Target scope denied or assessment stopped", {
        status: 403
      });
    }
  }
}
