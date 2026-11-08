// Temporary API-only upload transport. Cloudflare's SQL query API stages the
// compressed bundle in this new trial namespace, without an API token or an
// externally accessible upload endpoint. The full bundle replaces this module.
import {DurableObject} from "cloudflare:workers";
export class ServerCoordinator extends DurableObject {}
export class CloudServerAttempt extends DurableObject {}
export class OpenCodeCloudHost extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000));
  }
  async alarm() {await this.ctx.storage.deleteAll();}
}
export default {fetch() {return new Response("Trial is preparing", {status: 503});}};
