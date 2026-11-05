import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SourceMap } from 'node:module';
import test from 'node:test';
import {
  checkSourceMapSize, compareMappingFields, compareRuntimeUploads, omitSourceText,
} from './prepare-native-worker-source-maps.mjs';

test('omitting embedded sources preserves generated-to-original stack positions and names', () => {
  const original = { version: 3, sources: ['src/example.ts'], sourcesContent: ['throw new Error("example");'], names: ['originalName'], mappings: 'AAAAA', file: 'worker.js' };
  const prepared = JSON.parse(omitSourceText(JSON.stringify(original)));
  assert.deepEqual(new SourceMap(prepared).findOrigin(1, 1), new SourceMap(original).findOrigin(1, 1));
  compareMappingFields(original, prepared);
  assert(!Object.hasOwn(prepared, 'sourcesContent'));
  assert.throws(() => compareMappingFields(original, { ...prepared, mappings: 'ACAA' }), /changed mappings/);
});

test('runtime preservation catches an omitted Markdown module and changed executable bytes', () => {
  const original = new Map([
    ['worker.js', { type: 'application/javascript+module', bytes: Buffer.from('import "./role.md"') }],
    ['role.md', { type: 'text/plain', bytes: Buffer.from('Original specialist guidance') }],
  ]);
  assert.equal(compareRuntimeUploads(original, new Map(original)).length, 2);
  const nativeBundledNames = new Map([...original].map(([name, part]) => [name === 'worker.js' ? name : `./${name}`, part]));
  assert.equal(compareRuntimeUploads(nativeBundledNames, original).length, 2);
  assert.throws(() => compareRuntimeUploads(original, new Map([original.entries().next().value])), /module catalog/);
  const changed = new Map(original);
  changed.set('worker.js', { type: 'application/javascript+module', bytes: Buffer.from('changed') });
  assert.throws(() => compareRuntimeUploads(original, changed), /module bytes/);
});

test('source map size gate rejects both Cloudflare failure modes', () => {
  assert.throws(() => checkSourceMapSize(' '.repeat(60 * 1024 * 1024 + 1)), /exceeds 60 MiB/);
  assert.throws(() => checkSourceMapSize(randomBytes(16 * 1024 * 1024)), /exceeds 15 MiB gzipped/);
});

test('malformed or empty maps fail preparation', () => {
  assert.throws(() => omitSourceText('{"version":2}'), /v3/);
  assert.throws(() => omitSourceText('{"version":3,"sources":[],"names":[],"mappings":""}'), /no mappings/);
});
