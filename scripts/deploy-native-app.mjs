// Used after the native build gate by Workers Builds and the manual
// ordered deployment. Always upload the verified prebuilt Worker and its map.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSourceMapSize, sha256 } from './prepare-native-worker-source-maps.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps/control-plane');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const options = args.filter((arg) => arg !== '--dry-run');
assert(options.length === 0 || (options.length === 4 && options[0] === '--config' && options[2] === '--output'),
  'Usage: deploy-native-app.mjs [--config FILE --output DIRECTORY] [--dry-run]');
const config = options.length ? resolve(options[1]) : join(app, 'wrangler.jsonc');
const output = options.length ? resolve(options[3]) : join(app, 'dist/worker');
const manifestPath = options.length ? `${output}.worker-build.json` : join(app, 'dist/worker-build.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.schemaVersion, 1, 'Rebuild the application before deployment');
assert.equal(sha256(await readFile(config)), manifest.configSha256,
  'Worker configuration changed; rerun npm run verify');
const files = (await readdir(output, { recursive: true, withFileTypes: true })).filter((file) => file.isFile())
  .map((file) => relative(output, join(file.parentPath, file.name)).replaceAll('\\', '/')).sort();
assert.deepEqual(files, [...manifest.modules.map((module) => module.name), manifest.map.name].sort(),
  'Prebuilt module catalog changed; rerun npm run verify');
for (const module of manifest.modules) {
  assert.equal(sha256(await readFile(join(output, module.name))), module.sha256,
    `Prebuilt runtime module changed: ${module.name}; rerun npm run verify`);
}
const map = await readFile(join(output, manifest.map.name));
assert.equal(sha256(map), manifest.map.diskSha256, 'Prebuilt source map changed; rerun npm run verify');
checkSourceMapSize(map);
const child = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
  'deploy', join(output, 'worker.js'), '--config', config, '--no-bundle', '--minify=false', '--upload-source-maps', ...(dryRun ? ['--dry-run'] : [])], {
  cwd: app, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
