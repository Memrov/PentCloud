import { hostedUIResponse } from "../../apps/control-plane/src/native/ui-response";
import { DurableObject } from "cloudflare:workers";

interface Feed {
  snapshot: unknown;
  connections: number;
  controller?: ReadableStreamDefaultController<Uint8Array>;
}
const encoder = new TextEncoder();
const close = (feed: Feed | undefined) => {
  const controller = feed?.controller;
  if (feed) delete feed.controller;
  controller?.close();
};

// A Durable Object owns stream I/O across requests. Harness reset discards it.
export class StreamFixture extends DurableObject<BrowserFixtureEnv> {
  private feed: Feed | undefined;

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const control = path.match(/^\/__fixtures\/streams\/([^/]+)$/)?.[1];
    if (control) {
      let feed = this.feed;
      if (request.method === "DELETE") {
        close(feed);
        this.feed = undefined;
        return new Response(null);
      }
      if (request.method === "POST") {
        const value = await request.json<{
          snapshot?: unknown;
          event?: unknown;
          disconnect?: boolean;
        }>();
        if (!feed) {
          feed = { snapshot: {}, connections: 0 };
          this.feed = feed;
        }
        if ("snapshot" in value) feed.snapshot = value.snapshot;
        if ("event" in value)
          feed.controller?.enqueue(
            encoder.encode(
              `event: live\ndata: ${JSON.stringify(value.event)}\n\n`
            )
          );
        if (value.disconnect) {
          const controller = feed.controller;
          delete feed.controller;
          controller?.error(new Error("Injected stream disconnect"));
        }
      }
      return Response.json({ connections: feed?.connections ?? 0 });
    }
    const feed = this.feed;
    if (feed) {
      close(feed);
      let connection: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          connection = controller;
          feed.controller = controller;
          feed.connections++;
          controller.enqueue(
            encoder.encode(
              `event: snapshot\ndata: ${JSON.stringify(feed.snapshot)}\n\n`
            )
          );
        },
        cancel() {
          if (feed.controller === connection) delete feed.controller;
        }
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform"
        }
      });
    }
    return new Response("Missing stream fixture", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const id =
      path.match(/^\/__fixtures\/streams\/([^/]+)$/)?.[1] ??
      path.match(/^\/v1\/ui\/jobs\/([^/]+)\/events$/)?.[1];
    if (id) return env.STREAMS.getByName(id).fetch(request);
    return hostedUIResponse(await env.ASSETS.fetch(request), request.url);
  }
} satisfies ExportedHandler<BrowserFixtureEnv>;
