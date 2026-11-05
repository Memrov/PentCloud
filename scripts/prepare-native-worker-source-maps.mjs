// Wrangler owns compilation and mapping generation. Only embedded source text is
// optional in a v3 map; retain every mapping, source path and original name.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

export const SOURCE_MAP_LIMITS = { raw: 60 * 1024 * 1024, gzip: 15 * 1024 * 1024 };
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function checkSourceMapSize(content) {
  const raw = Buffer.byteLength(content);
  assert(raw <= SOURCE_MAP_LIMITS.raw, `Source map exceeds 60 MiB: ${raw} bytes`);
  const gzip = gzipSync(content).byteLength;
  assert(gzip <= SOURCE_MAP_LIMITS.gzip, `Source map exceeds 15 MiB gzipped: ${gzip} bytes`);
  return { raw, gzip };
}

export function omitSourceText(content) {
  const map = JSON.parse(content);
  assert.equal(map.version, 3, 'Expected a Source Map v3 map');
  assert(Array.isArray(map.sources) && Array.isArray(map.names), 'Source map is missing sources/names');
  assert.equal(typeof map.mappings, 'string', 'Source map is missing mappings');
  assert(map.mappings.length > 0, 'Source map has no mappings');
  delete map.sourcesContent;
  const output = JSON.stringify(map);
  checkSourceMapSize(output);
  return output;
}

// --outfile on a native Wrangler deploy --dry-run is the serialized upload
// multipart. Inspect that supported output instead of reconstructing an upload.
export async function readUpload(path) {
  const bytes = await readFile(path);
  const end = bytes.indexOf('\r\n');
  assert(bytes.subarray(0, 2).equals(Buffer.from('--')) && end > 2, 'Invalid Wrangler upload multipart');
  const boundary = bytes.subarray(2, end).toString();
  const form = await new Response(bytes, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  }).formData();
  const parts = new Map();
  for (const [name, value] of form) {
    assert(!parts.has(name), `Duplicate upload part: ${name}`);
    parts.set(name, typeof value === 'string'
      ? { type: 'metadata', bytes: Buffer.from(value) }
      : { type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  return parts;
}

export function compareRuntimeUploads(original, prepared) {
  if (original.has('metadata') || prepared.has('metadata')) {
    assert.deepEqual(JSON.parse(prepared.get('metadata').bytes), JSON.parse(original.get('metadata').bytes),
      'Prebuilt upload changed Worker metadata/bindings');
  }
  // Native bundling names collected modules ./name; native no-bundle scanning
  // names the same module name. Both resolve the unchanged ./name import. Compare
  // canonical module names, keeping their MIME types and bytes exact.
  const runtime = (parts) => [...parts].filter(([name, part]) => name !== 'metadata' && part.type !== 'application/source-map')
    .map(([name, part]) => [name.replace(/^\.\//, ''), part]);
  const expected = runtime(original);
  const actual = new Map(runtime(prepared));
  assert.deepEqual([...actual.keys()].sort(), expected.map(([name]) => name).sort(),
    'Prebuilt upload changed the runtime module catalog (check Wrangler Text rules, including **/*.md)');
  return expected.map(([name, part]) => {
    const module = actual.get(name);
    assert.equal(module.type, part.type, `Runtime module type changed: ${name}`);
    assert(module.bytes.equals(part.bytes), `Runtime module bytes changed: ${name}`);
    return { name, type: part.type, bytes: part.bytes.length, sha256: sha256(part.bytes) };
  });
}

export function compareMappingFields(original, prepared) {
  // Wrangler's no-bundle path normalizes leading ../ on source paths. That only
  // changes displayed path prefixes, not source indexes, coordinates or names.
  for (const key of ['version', 'file', 'sourceRoot', 'mappings', 'names']) {
    assert.deepEqual(prepared[key], original[key], `Source map changed ${key}`);
  }
  const clean = (path) => path.replace(/^(?:(?:\.\.?)[/\\])+/, '');
  assert.deepEqual(prepared.sources.map(clean), original.sources.map(clean), 'Source map changed original source paths');
  assert(!Object.hasOwn(prepared, 'sourcesContent'), 'Upload still contains embedded source text');
}

// Execute the actual compiled pure identifier validator at its original bundle
// line/column. No synthetic generated positions, runtime hooks or production
// exception endpoint are needed to prove a real Error stack maps back to TS.
export function validateProductionStack(code, map, originalSource) {
  const marker = code.indexOf('400: invalid ${');
  assert(marker >= 0, 'Production identifier validator was not found');
  const start = code.lastIndexOf('function ', marker);
  assert(start >= 0, 'Production identifier function was not found');
  const fragment = code.slice(start, start + 2048);
  const declaration = ts.createSourceFile('probe.js', fragment, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).statements[0];
  assert(ts.isFunctionDeclaration(declaration), 'Expected compiled identifier function');
  const snippet = fragment.slice(declaration.pos, declaration.end);
  assert(snippet.includes('400: invalid ${'), 'Compiled identifier extraction missed its throw');
  const preceding = code.slice(0, start).split('\n');
  const identifier = new vm.Script(`(${snippet})`, {
    filename: 'worker.js', lineOffset: preceding.length - 1, columnOffset: preceding.at(-1).length - 1,
  }).runInNewContext();
  let thrown;
  try { identifier(null); } catch (error) { thrown = error; }
  assert.equal(thrown?.message, '400: invalid id');
  const generated = thrown.stack.match(/worker\.js:(\d+):(\d+)/);
  assert(generated, 'Compiled exception has no generated stack location');
  const origin = new SourceMap(map).findOrigin(Number(generated[1]), Number(generated[2]));
  assert.match(origin.fileName ?? '', /(?:^|\/)src\/native\/domain\.ts$/);
  const expectedLine = originalSource.split('\n').findIndex((line) => line.includes('throw new Error(`400: invalid ${label}`)')) + 1;
  assert(expectedLine > 0, 'Original identifier throw was not found');
  assert.equal(origin.lineNumber, expectedLine, 'Compiled exception maps to the wrong original line');
  const sourceLine = originalSource.split('\n')[expectedLine - 1];
  assert.equal(origin.columnNumber, sourceLine.indexOf('new Error') + 1, 'Compiled exception maps to the wrong original column');
  return {
    generated: { file: 'worker.js', line: Number(generated[1]), column: Number(generated[2]) },
    original: { file: origin.fileName, line: origin.lineNumber, column: origin.columnNumber },
    error: thrown.message,
  };
}
