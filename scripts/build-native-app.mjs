// Keep Wrangler's native bundler, compatibility transforms and asset modules.
// Prebuild once, remove optional map text, then prove the no-bundle upload is
// byte-for-byte identical for every runtime module before marking it deployable.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSourceMapSize, compareMappingFields, compareRuntimeUploads,
  omitSourceText, readUpload, sha256, validateProductionStack,
} from './prepare-native-worker-source-maps.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps/control-plane');
const args = process.argv.slice(2);
assert(args.length === 0 || ((args.length === 2 || args.length === 4) && args[0] === '--config' && (args.length === 2 || args[2] === '--output')),
  'Usage: build-native-app.mjs [--config FILE [--output DIRECTORY]]');
const config = args.length ? resolve(args[1]) : join(app, 'wrangler.jsonc');
const output = args.length === 4 ? resolve(args[3]) : join(app, 'dist/worker');
if (args.length === 4) {
  assert(output !== dirname(output) && output !== root && !output.startsWith(root + '/') && !root.startsWith(output + '/'),
    'Custom build output must be outside the checkout and its ancestors');
  assert(config !== output && !config.startsWith(output + '/'), 'Build output must not contain its configuration');
}
const manifest = args.length === 4 ? `${output}.worker-build.json` : join(app, 'dist/worker-build.json');
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const scratch = await mkdtemp(join(tmpdir(), 'pentcloud-worker-map-'));
function dryRun(args) {
  const child = spawnSync(process.execPath, [wrangler, 'deploy', '--config', config, '--dry-run', '--containers-rollout=none', '--upload-source-maps', ...args], {
    cwd: app, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  assert.equal(child.status, 0, `Wrangler dry-run failed: ${child.error ?? child.signal ?? child.status}`);
}

await rm(manifest, { force: true });
await rm(output, { force: true, recursive: true });
try {
  const originalPath = join(scratch, 'original.multipart');
  const preparedPath = join(scratch, 'prepared.multipart');
  dryRun(['--outdir', output, '--outfile', originalPath]);
  const original = await readUpload(originalPath);
  const mapPath = join(output, 'worker.js.map');
  // Use Wrangler's own normalized upload map, which resolves the compiler's
  // absolute sourceRoot and relative source paths before removing source text.
  // The resulting map keeps repository-relative original filenames in Logs.
  const originalText = original.get('worker.js.map')?.bytes.toString();
  assert(originalText, 'Native Wrangler upload has no production source map');
  const trimmed = omitSourceText(originalText);
  await writeFile(mapPath, trimmed);
  // Wrangler emits this informational README beside modules. It is not part of
  // the compiled Worker and must not become an additional Markdown module.
  assert(!original.has('README.md') && !original.has('./README.md'), 'Cannot discard a runtime README module');
  await rm(join(output, 'README.md'));
  dryRun([join(output, 'worker.js'), '--no-bundle', '--minify=false', '--outfile', preparedPath]);
  const prepared = await readUpload(preparedPath);
  const modules = compareRuntimeUploads(original, prepared);
  const maps = [...prepared].filter(([, part]) => part.type === 'application/source-map');
  assert.equal(maps.length, 1, 'Expected one uploaded production map');
  const [name, part] = maps[0];
  assert.equal(name, 'worker.js.map');
  const preparedMap = JSON.parse(part.bytes);
  compareMappingFields(JSON.parse(originalText), preparedMap);
  const stack = validateProductionStack(prepared.get('worker.js').bytes.toString(), preparedMap,
    await readFile(join(app, 'src/native/domain.ts'), 'utf8'));
  const map = { name, diskSha256: sha256(trimmed), uploadedBytes: checkSourceMapSize(part.bytes), diskBytes: checkSourceMapSize(trimmed) };
  const proof = { schemaVersion: 1, configSha256: sha256(await readFile(config)), modules, map, stack, originalMapBytes: Buffer.byteLength(originalText), sourceCount: preparedMap.sources.length };
  await writeFile(manifest, JSON.stringify(proof, null, 2) + '\n');
  console.log(`Production map ready: ${map.uploadedBytes.raw} bytes / ${map.uploadedBytes.gzip} gzipped; ${modules.length} runtime modules unchanged.`);
  console.log(`Compiled stack worker.js:${stack.generated.line}:${stack.generated.column} -> ${stack.original.file}:${stack.original.line}:${stack.original.column}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}
