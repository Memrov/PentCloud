// Used after the native build gate by Workers Builds and the manual
// ordered deployment. Always upload the verified prebuilt Worker and its map.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSourceMapSize, sha256 } from './prepare-native-worker-source-maps.mjs';
import { awaitShippingChecks, shouldGateManagedDeployment } from './lib/shipping-gate.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failure = code => Object.assign(new Error(code), { code });
const shippingFailures = new Set([
  'PC_SHIPPING_BRANCH', 'PC_SHIPPING_COMMIT', 'PC_SHIPPING_SOURCE', 'PC_SHIPPING_HEAD',
  'PC_SHIPPING_REPOSITORY', 'PC_SHIPPING_OPTIONS', 'PC_SHIPPING_TIMEOUT',
  'PC_SHIPPING_NETWORK', 'PC_SHIPPING_HTTP', 'PC_SHIPPING_RATE_LIMIT',
  'PC_SHIPPING_RESPONSE', 'PC_SHIPPING_SHA_MISMATCH', 'PC_SHIPPING_CHECK_FAILED', 'PC_SHIPPING_CHECKS',
]);

export async function deployNativeApp({
  root = repositoryRoot, args = process.argv.slice(2), environment = process.env,
  run = spawnSync, shippingChecks = awaitShippingChecks, log = console.log,
} = {}) {
  const app = join(root, 'apps/control-plane');
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
  if (shouldGateManagedDeployment({ environment, customConfig: options.length > 0 })) {
    if (environment.WORKERS_CI_BRANCH !== 'main') throw failure('PC_SHIPPING_BRANCH');
    const commit = environment.WORKERS_CI_COMMIT_SHA;
    if (typeof commit !== 'string' || commit.length !== 40 || !/^[a-f0-9]{40}$/.test(commit)) throw failure('PC_SHIPPING_COMMIT');
    let source;
    try {
      source = run('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        'rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, maxBuffer: 1024,
        env: {
          PATH: environment.PATH ?? process.env.PATH, LANG: 'C', LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
        },
      });
    } catch { throw failure('PC_SHIPPING_HEAD'); }
    const head = typeof source?.stdout === 'string' ? source.stdout.trim() : '';
    if (source?.error || source?.status !== 0 || head.length !== 40 || !/^[a-f0-9]{40}$/.test(head)) throw failure('PC_SHIPPING_HEAD');
    if (head !== commit) throw failure('PC_SHIPPING_SOURCE');
    try {
      await shippingChecks({ commit, repository: 'Memrov/PentCloud', log: entry => {
        if (!['PC_SHIPPING_WAITING', 'PC_SHIPPING_READY'].includes(entry?.code)
            || ![entry.passed, entry.pending].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 3)
            || entry.passed + entry.pending !== 3) throw failure('PC_SHIPPING_RESPONSE');
        log(`${entry.code} passed=${entry.passed} pending=${entry.pending}`);
      } });
    } catch (error) {
      throw failure(shippingFailures.has(error?.code) ? error.code : 'PC_SHIPPING_CHECKS');
    }
  }
  let child;
  try {
    child = run(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy', join(output, 'worker.js'), '--config', config, '--no-bundle', '--minify=false', '--upload-source-maps', ...(dryRun ? ['--dry-run'] : [])], {
      cwd: app, stdio: 'inherit', env: { ...environment, WRANGLER_SEND_METRICS: 'false' },
    });
  } catch { throw failure('PC_DEPLOY_WRANGLER'); }
  if (child?.error) throw failure('PC_DEPLOY_WRANGLER');
  return child.status ?? 1;
}

let invokedPath;
try { if (process.argv[1]) invokedPath = realpathSync(process.argv[1]); } catch { /* An imported function may be called from stdin. */ }
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await deployNativeApp(); }
  catch (error) {
    console.error(shippingFailures.has(error?.code) || error?.code === 'PC_DEPLOY_WRANGLER' ? error.code : 'PC_DEPLOY_PREBUILT');
    process.exitCode = 1;
  }
}
