// Execute the bundled Go binary in real workerd, and compare with both the
// pinned upstream goldens and native Go (including its errors and wrapper).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import * as miniflare from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const cases = JSON.parse(read('internal/prompts/testdata/render-cases.json'));
const template = name => read(`internal/prompts/assets/${name}.tmpl`);
const requests = [];
const add = request => { requests.push(request); return requests.length - 1; };
const golden = [];
for (const [role, name] of [['primary', 'primary_agent'], ['pentester', 'pentester']]) {
  golden.push([add({ operation: 'template', source: template(name), data: cases[role] }), read(`internal/prompts/testdata/${name}.golden`)]);
}
for (const [source, data] of [
  ['{{- $x := .X -}}{{if $x}}{{printf "%q" $x}}{{else}}empty{{end}}', { X: '<&>' }],
  ['{{range $k, $v := .Map}}{{$k}}={{$v}};{{end}}', { Map: { z: 2, a: 1 } }],
  ['{{define "nested"}}{{.Name | printf "%s!"}}{{end}}{{with .Item}}{{template "nested" .}}{{end}}', { Item: { Name: 'Привет 🐈' } }],
  ['{{range .Values}}{{if eq . "stop"}}{{break}}{{end}}{{.}};{{end}}/{{.Missing}}', { Values: ['a', 'stop', 'b'] }],
  ['{{if .Lang}}missing end', {}], ['{{unknown .Lang}}', {}], ['{{index .List 9}}', { List: [1] }],
  ['', {}],
]) add({ operation: 'template', source, data });
const context = { now: '2026-10-29T00:00:00Z', userFiles: '  α.txt\n  ', enabledTools: ['graphiti_search'] };
for (const [role, name] of [['primary','primary_agent'], ['adviser','adviser'], ['coder','coder'], ['maintenance','installer'], ['memorist','memorist'], ['pentester','pentester'], ['searcher','searcher'], ['reporter','reporter']]) {
  add({ operation: 'launch', role, args: { question: 'work <&> 🐈', z: 1, message: 'delegate', nested: { z: 2, a: 1 } }, source: template(name), context });
}
add({ operation: 'launch', role: 'coder', args: { question: 'work' }, source: '{{.CurrentTime}}|{{.Cwd}}|{{.DockerImage}}|{{.Lang}}|{{.UserFiles}}|{{.N}}|{{.GraphitiEnabled}}', context });
for (const bad of [
  { role: 'coder', args: {}, source: '' },
  { role: 'invalid', args: {}, source: 'x' },
  { role: 'coder', args: null, source: 'x' },
  { role: 'coder', args: [], source: 'x' },
]) add({ operation: 'launch', ...bad, context });
const native = spawnSync(process.env.GO_BIN ?? 'go', ['run', './cmd/pentcloud-render-wasm'], {
  cwd: root, input: requests.map(value => JSON.stringify(value)).join('\n')+'\n', encoding: 'utf8', maxBuffer: 16*1024*1024,
});
assert.equal(native.status, 0, native.stderr);
const expected = native.stdout.trim().split('\n').map(value => JSON.parse(value));
const bundled = await build({
  absWorkingDir: root, entryPoints: ['apps/control-plane/test/fixtures/prompt-worker.ts'], bundle: true,
  format: 'esm', platform: 'neutral', target: 'es2022', external: ['*.bin', 'cloudflare:workers'], write: false, loader: {'.txt':'text'},
  plugins: [{name: 'worker-raw-sources', setup(plugin) {
    plugin.onResolve({filter: /\?raw$/}, args => ({path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw'}));
    plugin.onLoad({filter: /.*/, namespace: 'raw'}, args => ({contents: readFileSync(args.path, 'utf8'), loader: 'text'}));
  }}],
});
const workerOptions = {
  ...(process.env.PENTCLOUD_RENDERER_HEAP_REPORT ? { inspectorPort: 0 } : {}),
  compatibilityDate: process.env.WORKERD_COMPATIBILITY_DATE ?? '2026-10-19', compatibilityFlags: ['nodejs_compat'], workerLoaders: { LOADER: {} },
  modules: [
    { type: 'ESModule', path: resolve(root, 'prompt-worker.mjs'), contents: bundled.outputFiles[0].text },
    { type: 'Data', path: resolve(root, 'assets/prompt-renderer.bin'), contents: readFileSync(resolve(root, 'apps/control-plane/src/native/assets/prompt-renderer.bin')) },
  ],
};
const worker = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions?.(workerOptions) ?? workerOptions);
try {
  const actual = [];
  for (const input of requests) {
    const response = await worker.dispatchFetch('https://prompt.test/', { method: 'POST', body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    actual.push(await response.json());
  }
  for (let i = 0; i < requests.length; i++) {
    // Go omits empty strings on the wire; the public adapter returns ''.
    if (!expected[i].error && expected[i].prompt === undefined) expected[i].prompt = '';
    assert.deepEqual(actual[i], expected[i], `workerd/native Go case ${i}: ${requests[i].role ?? requests[i].source.slice(0, 40)}`);
  }
  for (const [index, body] of golden) assert.equal(actual[index].prompt, body, 'pinned upstream golden bytes');
  const concurrent = await Promise.all(Array.from({ length: 12 }, (_, n) => worker.dispatchFetch('https://prompt.test/', {
    method: 'POST', body: JSON.stringify({ operation: 'template', source: '{{.N}}', data: { N: n } }),
  }).then(response => response.json())));
  assert.deepEqual(concurrent.map(value => value.prompt), Array.from({ length: 12 }, (_, n) => String(n)));
  const memory = await (await worker.dispatchFetch('https://prompt.test/memory')).json();
  assert.equal(memory.isolated, true);
  assert.equal(memory.parentHasGoRuntime, false, 'Go must not initialize in the caller isolate');
  assert.ok(memory.linearMemoryBytes > 0);
  console.log(`isolated Go renderer memory: ${memory.linearMemoryBytes} bytes; caller Go runtime absent`);
  if (process.env.PENTCLOUD_RENDERER_HEAP_REPORT) {
    const inspector = await worker.getInspectorURL();
    inspector.protocol = inspector.protocol === 'wss:' ? 'https:' : 'http:';
    const targets = await (await fetch(new URL('/json/list', inspector))).json();
    for (const target of targets) {
      if (!target.webSocketDebuggerUrl || (target.id !== 'core:user:' && !target.id.startsWith('LOADER:'))) continue;
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      const heap = await new Promise((resolveHeap, rejectHeap) => {
        const timeout = setTimeout(() => { socket.close(); rejectHeap(new Error('Inspector heap timeout')); }, 5000);
        socket.addEventListener('open', () => socket.send(JSON.stringify({id: 1, method: 'Runtime.getHeapUsage'})));
        socket.addEventListener('message', event => {
          const value = JSON.parse(String(event.data));
          if (value.id === 1) { clearTimeout(timeout); socket.close(); resolveHeap(value); }
        });
        socket.addEventListener('error', rejectHeap);
      });
      console.log('workerd heap', target.id, JSON.stringify(heap));
    }
  }
  console.log(`workerd: ${requests.length} Go parity/validation cases, 2 upstream goldens, 12 concurrent requests passed`);
} finally {
  await worker.dispose();
}
