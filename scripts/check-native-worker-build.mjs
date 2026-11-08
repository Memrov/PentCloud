// Check the standard Vite output without rewriting or rebundling any module.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { SourceMap } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const output = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]) + "/")
  : new URL("../apps/control-plane/dist/worker/", import.meta.url);
const config = JSON.parse(
  await readFile(new URL("wrangler.json", output), "utf8")
);
assert.equal(config.no_bundle, true);
assert.equal(config.upload_source_maps, true);
await readFile(new URL(config.main, output));
const original = await readFile(
  new URL("../apps/control-plane/src/native/domain.ts", import.meta.url),
  "utf8"
);
const maps = (await readdir(output, { recursive: true })).filter((file) =>
  file.endsWith(".map")
);
assert(maps.length > 0, "Worker maps are missing");
let stack;
let largest = { raw: 0, gzip: 0 };
for (const file of maps) {
  const bytes = await readFile(new URL(file, output));
  const map = JSON.parse(bytes);
  assert.equal(map.version, 3);
  assert(!Object.hasOwn(map, "sourcesContent"), `${file} embeds source text`);
  const sizes = { raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
  assert(sizes.raw <= 60 * 1024 * 1024, `${file} exceeds 60 MiB`);
  assert(sizes.gzip <= 15 * 1024 * 1024, `${file} exceeds 15 MiB gzipped`);
  largest = {
    raw: Math.max(largest.raw, sizes.raw),
    gzip: Math.max(largest.gzip, sizes.gzip)
  };
  const filename = file.slice(0, -4);
  const code = await readFile(new URL(filename, output), "utf8");
  if (code.includes("400: invalid ${"))
    stack = validateProductionStack(code, map, original, filename);
}
assert(stack, "Compiled production identifier stack was not checked");
console.log(
  JSON.stringify(
    { worker: config.name, maps: maps.length, largest, stack },
    null,
    2
  )
);

// Execute the actual compiled pure identifier validator at its original bundle
// line/column. No synthetic generated positions, runtime hooks or production
// exception endpoint are needed to prove a real Error stack maps back to TS.
function validateProductionStack(code, map, originalSource, filename) {
  const marker = code.indexOf("400: invalid ${");
  assert(marker >= 0, "Production identifier validator was not found");
  const start = code.lastIndexOf("function ", marker);
  assert(start >= 0, "Production identifier function was not found");
  const fragment = code.slice(start, start + 2048);
  const declaration = ts.createSourceFile(
    "probe.js",
    fragment,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  ).statements[0];
  assert(
    ts.isFunctionDeclaration(declaration),
    "Expected compiled identifier function"
  );
  const snippet = fragment.slice(declaration.pos, declaration.end);
  assert(
    snippet.includes("400: invalid ${"),
    "Compiled identifier extraction missed its throw"
  );
  const preceding = code.slice(0, start).split("\n");
  const identifier = new vm.Script(`(${snippet})`, {
    filename,
    lineOffset: preceding.length - 1,
    columnOffset: preceding.at(-1).length - 1
  }).runInNewContext();
  let thrown;
  try {
    identifier(null);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.message, "400: invalid id");
  const generated = thrown.stack.match(/:(\d+):(\d+)\)?(?:\n|$)/);
  assert(generated, "Compiled exception has no generated stack location");
  const origin = new SourceMap(map).findOrigin(
    Number(generated[1]),
    Number(generated[2])
  );
  assert.match(origin.fileName ?? "", /(?:^|\/)src\/native\/domain\.ts$/);
  const expectedLine =
    originalSource
      .split("\n")
      .findIndex((line) =>
        line.includes("throw new Error(`400: invalid ${label}`)")
      ) + 1;
  assert(expectedLine > 0, "Original identifier throw was not found");
  assert.equal(
    origin.lineNumber,
    expectedLine,
    "Compiled exception maps to the wrong original line"
  );
  const sourceLine = originalSource.split("\n")[expectedLine - 1];
  assert(
    [
      sourceLine.indexOf("new Error") + 1,
      sourceLine.indexOf("Error") + 1
    ].includes(origin.columnNumber),
    "Compiled exception maps outside its original error expression"
  );
  return {
    generated: {
      file: filename,
      line: Number(generated[1]),
      column: Number(generated[2])
    },
    original: {
      file: origin.fileName,
      line: origin.lineNumber,
      column: origin.columnNumber
    },
    error: thrown.message
  };
}
