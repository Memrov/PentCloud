import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
}

export default {
  async fetch(_request, env) {
    return Response.json({
      count: await env.COUNTER.getByName("counter").increment()
    });
  }
};
