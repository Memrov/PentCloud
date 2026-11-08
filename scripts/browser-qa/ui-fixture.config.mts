import {fileURLToPath} from 'node:url';
import type {ServerResponse} from 'node:http';
import {defineConfig, mergeConfig, type PreviewServer} from 'vite';
import appConfig from '../../apps/control-plane/vite.config.ts';
import {hostedUIResponse} from '../../apps/control-plane/src/native/ui-response.ts';

// The app's production bundle and CSP, plus a local-only, controllable SSE fixture.
export default defineConfig(env => mergeConfig(appConfig(env), {
  root: fileURLToPath(new URL('../../apps/control-plane', import.meta.url)),
  build: {outDir: fileURLToPath(new URL('../../node_modules/.cache/pentcloud-browser-fixture', import.meta.url)), emptyOutDir: true},
  preview: {host: '127.0.0.1', port: 4173, strictPort: true},
  plugins: [{name: 'pentcloud-browser-fixtures', configurePreviewServer(server: PreviewServer) {
    const feeds = new Map<string, {snapshot: unknown; response?: ServerResponse; connections: number}>();
    server.httpServer?.on('close', () => {for (const feed of feeds.values()) feed.response?.destroy();});
    server.middlewares.use(async (request, response, next) => {
      const path = new URL(request.url!, 'http://127.0.0.1').pathname;
      const control = path.match(/^\/__fixtures\/streams\/([^/]+)$/)?.[1];
      const stream = path.match(/^\/v1\/ui\/jobs\/([^/]+)\/events$/)?.[1];
      if (control) {
        let feed = feeds.get(control);
        if (request.method === 'DELETE') {feed?.response?.destroy(); feeds.delete(control); response.end(); return;}
        if (request.method === 'POST') {
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (!feed) {feed = {snapshot: {}, connections: 0}; feeds.set(control, feed);}
          if ('snapshot' in value) feed.snapshot = value.snapshot;
          if ('event' in value) feed.response?.write(`event: live\ndata: ${JSON.stringify(value.event)}\n\n`);
          if (value.disconnect) feed.response?.destroy();
        }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({connections: feed?.connections ?? 0})); return;
      }
      const feed = stream && feeds.get(stream);
      if (feed) {
        response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform'});
        feed.response = response; feed.connections++;
        response.write(`event: snapshot\ndata: ${JSON.stringify(feed.snapshot)}\n\n`); return;
      }
      const policy = hostedUIResponse(new Response(null, {headers: {'Content-Type': 'text/html'}}), `http://${request.headers.host}${request.url}`);
      policy.headers.forEach((value, key) => {if (key !== 'content-type') response.setHeader(key, value);});
      next();
    });
  }}],
}));
