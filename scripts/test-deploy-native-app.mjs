import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deployNativeApp } from './deploy-native-app.mjs';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const COMMIT = 'a'.repeat(40);
const sha = value => createHash('sha256').update(value).digest('hex');
const managed = { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main', WORKERS_CI_COMMIT_SHA: COMMIT };
const exists = path => access(path).then(() => true, () => false);
const MARKER = 'private-metadata-not-for-deployment-logs';
const rejection = code => error => {
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  return true;
};

const invoke = (f, options = {}) => deployNativeApp({ root: f.root, args: [], environment: managed, log: () => {}, ...options });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pentcloud-shipping-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'apps/control-plane');
  const output = join(app, 'dist/worker');
  const config = join(app, 'wrangler.jsonc');
  const marker = join(root, 'wrangler-ran');
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'scripts/lib'), { recursive: true });
  await mkdir(join(root, 'node_modules/wrangler/bin'), { recursive: true });
  await copyFile(join(scripts, 'deploy-native-app.mjs'), join(root, 'scripts/deploy-native-app.mjs'));
  await symlink(join(scripts, 'prepare-native-worker-source-maps.mjs'), join(root, 'scripts/prepare-native-worker-source-maps.mjs'));
  await symlink(join(scripts, 'lib/shipping-gate.mjs'), join(root, 'scripts/lib/shipping-gate.mjs'));
  await writeFile(join(root, 'node_modules/wrangler/bin/wrangler.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const configText = '{"name":"fixture-app"}';
  const worker = 'export default {fetch(){return new Response("fixture")}};';
  const map = '{"version":3,"sources":["fixture.ts"],"names":[],"mappings":"AAAA"}';
  await writeFile(config, configText);
  await writeFile(join(output, 'worker.js'), worker);
  await writeFile(join(output, 'worker.js.map'), map);
  const manifest = { schemaVersion: 1, configSha256: sha(configText), modules: [{ name: 'worker.js', sha256: sha(worker) }], map: { name: 'worker.js.map', diskSha256: sha(map) } };
  await writeFile(join(app, 'dist/worker-build.json'), JSON.stringify(manifest));
  return { root, app, output, config, marker, manifest };
}

test('managed CLI rejects another branch before invoking Wrangler', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, [join(f.root, 'scripts/deploy-native-app.mjs')], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, ...managed, WORKERS_CI_BRANCH: 'preview' },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stderr.trim(), 'PC_SHIPPING_BRANCH');
  assert.equal(await exists(f.marker), false);
});

test('managed deployment rejects missing and malformed source SHA without starting children', async t => {
  const f = await fixture(t);
  for (const commit of [undefined, '', 'main', 'A'.repeat(40), `${COMMIT}\n`, MARKER]) {
    const calls = [];
    await assert.rejects(invoke(f, {
      environment: { ...managed, WORKERS_CI_COMMIT_SHA: commit },
      run: (...args) => { calls.push(args); return { status: 0 }; },
    }), rejection('PC_SHIPPING_COMMIT'));
    assert.deepEqual(calls, []);
  }
});

test('a source SHA different from checkout HEAD cannot reach checks or Wrangler', async t => {
  const f = await fixture(t);
  const calls = [];
  await assert.rejects(invoke(f, {
    run: (...args) => { calls.push(args); return { status: 0, stdout: `${'b'.repeat(40)}\n` }; },
    shippingChecks: async () => { throw Error('Checks must not run'); },
  }), rejection('PC_SHIPPING_SOURCE'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'git');
});

test('failed and malformed git HEAD reads expose only a fixed error', async t => {
  const f = await fixture(t);
  for (const result of [{ status: 1, stderr: MARKER }, { error: Error(MARKER) }, { status: 0, stdout: MARKER }, { status: 0, stdout: '' }]) {
    await assert.rejects(invoke(f, { run: () => result }), rejection('PC_SHIPPING_HEAD'));
  }
});

test('Wrangler starts only after source verification and asynchronous same-SHA checks', { timeout: 1000 }, async t => {
  const f = await fixture(t);
  const events = [];
  const logs = [];
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let gateOptions;
  const pending = invoke(f, {
    log: line => logs.push(line),
    run: (command, args, options) => {
      if (command === 'git') {
        events.push('git');
        assert(args.includes('core.fsmonitor=false'));
        assert(args.includes('core.hooksPath=/dev/null'));
        assert(args.includes('--no-replace-objects'));
        assert.equal(args.at(-1), 'HEAD^{commit}');
        assert.equal(options.cwd, f.root);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
        assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
        return { status: 0, stdout: `${COMMIT}\n` };
      }
      events.push('wrangler');
      assert.equal(command, process.execPath);
      assert.equal(args[0], join(f.root, 'node_modules/wrangler/bin/wrangler.js'));
      assert(args.includes('--no-bundle'));
      assert(args.includes('--minify=false'));
      assert(args.includes('--upload-source-maps'));
      return { status: 0 };
    },
    shippingChecks: options => {
      events.push('checks');
      gateOptions = options;
      options.log({ code: 'PC_SHIPPING_WAITING', passed: 2, pending: 1, output: MARKER });
      started();
      return new Promise(resolve => { release = resolve; });
    },
  });
  await entered;
  assert.deepEqual(events, ['git', 'checks']);
  assert.equal(gateOptions.commit, COMMIT);
  assert.equal(gateOptions.repository, 'Memrov/PentCloud');
  assert.equal(JSON.stringify(logs).includes(MARKER), false);
  release({ commit: COMMIT, checks: [] });
  assert.equal(await pending, 0);
  assert.deepEqual(events, ['git', 'checks', 'wrangler']);
});

test('failed shipping checks never start Wrangler or expose nested API exception text', async t => {
  const f = await fixture(t);
  const commands = [];
  await assert.rejects(invoke(f, {
    run: command => { commands.push(command); return { status: 0, stdout: COMMIT }; },
    shippingChecks: async () => { throw Object.assign(Error(MARKER), { code: 'PC_SHIPPING_NETWORK', cause: Error(MARKER) }); },
  }), rejection('PC_SHIPPING_NETWORK'));
  assert.deepEqual(commands, ['git']);
});

for (const mutation of ['config', 'module', 'map', 'catalog']) {
  test(`changed ${mutation} stops before GitHub checks and deployment`, async t => {
    const f = await fixture(t);
    const path = mutation === 'config' ? f.config : join(f.output, mutation === 'map' ? 'worker.js.map' : mutation === 'catalog' ? 'unexpected.md' : 'worker.js');
    await writeFile(path, 'changed');
    const calls = [];
    await assert.rejects(invoke(f, { run: (...args) => { calls.push(args); return { status: 0 }; }, shippingChecks: async () => { calls.push('checks'); } }));
    assert.deepEqual(calls, []);
  });
}

test('customer config deployments bypass repository checks inside managed Builds', async t => {
  const f = await fixture(t);
  const config = join(f.root, 'customer.json');
  const output = join(f.root, 'customer-bundle');
  await copyFile(f.config, config);
  await mkdir(output);
  for (const file of ['worker.js', 'worker.js.map']) await copyFile(join(f.output, file), join(output, file));
  await writeFile(`${output}.worker-build.json`, JSON.stringify(f.manifest));
  const commands = [];
  const status = await invoke(f, {
    args: ['--config', config, '--output', output],
    environment: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'customer-branch' },
    run: (command, args) => { commands.push(command); assert(args.includes(config)); return { status: 0 }; },
    shippingChecks: async () => { throw Error('Customer deployment must not use repository checks'); },
  });
  assert.equal(status, 0);
  assert.deepEqual(commands, [process.execPath]);
});

test('local deployment retains dry-run arguments and Wrangler exit status', async t => {
  const f = await fixture(t);
  const status = await invoke(f, {
    args: ['--dry-run'], environment: { TEST_BUILD_METADATA: 'example' },
    run: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert(args.includes('--dry-run'));
      assert.equal(options.env.WRANGLER_SEND_METRICS, 'false');
      assert.equal(options.env.TEST_BUILD_METADATA, 'example');
      return { status: 7 };
    },
    shippingChecks: async () => { throw Error('Local deployment must not use repository checks'); },
  });
  assert.equal(status, 7);
});

test('Wrangler spawn failures use a fixed error', async t => {
  const f = await fixture(t);
  await assert.rejects(invoke(f, { environment: {}, run: () => ({ error: Error(MARKER) }) }), rejection('PC_DEPLOY_WRANGLER'));
});

test('managed CLI renders invalid SHA as a fixed error without a stack or metadata', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, [join(f.root, 'scripts/deploy-native-app.mjs')], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, ...managed, WORKERS_CI_COMMIT_SHA: MARKER },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr.trim(), 'PC_SHIPPING_COMMIT');
  assert.equal(await exists(f.marker), false);
});

test('missing managed branch metadata cannot bypass checks', async t => {
  const f = await fixture(t);
  for (const branch of [undefined, '', 'Main', 'main\n']) {
    const calls = [];
    await assert.rejects(invoke(f, {
      environment: { ...managed, WORKERS_CI_BRANCH: branch },
      run: (...args) => { calls.push(args); return { status: 0 }; },
    }), rejection('PC_SHIPPING_BRANCH'));
    assert.deepEqual(calls, []);
  }
});

test('unknown check-reader errors are replaced by a fixed deployment error', async t => {
  const f = await fixture(t);
  await assert.rejects(invoke(f, {
    run: () => ({ status: 0, stdout: COMMIT }),
    shippingChecks: async () => { throw Error(MARKER); },
  }), rejection('PC_SHIPPING_CHECKS'));
});

test('CLI prebuilt validation failure hides filesystem and manifest details', async t => {
  const f = await fixture(t);
  await writeFile(join(f.app, 'dist/worker-build.json'), `invalid-${MARKER}`);
  const child = spawnSync(process.execPath, [join(f.root, 'scripts/deploy-native-app.mjs')], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, ...managed },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr.trim(), 'PC_DEPLOY_PREBUILT');
  assert.equal(await exists(f.marker), false);
});

test('source verification uses the actual checkout despite inherited Git overrides', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const gitEnvironment = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const initialize = async root => {
    const template = join(root, 'empty-git-template');
    await mkdir(template);
    const invokeGit = args => {
      const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnvironment, timeout: 10000 });
      assert.equal(child.status, 0, 'temporary repository setup failed');
      return child.stdout.trim();
    };
    invokeGit(['init', '--quiet', `--template=${template}`]);
    invokeGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', root]);
    return invokeGit(['rev-parse', 'HEAD']);
  };
  const actualHead = await initialize(f.root);
  const otherHead = await initialize(other.root);
  assert.notEqual(actualHead, otherHead);
  let checkedCommit;
  const commands = [];
  const status = await invoke(f, {
    environment: {
      ...managed, WORKERS_CI_COMMIT_SHA: actualHead, GIT_DIR: join(other.root, '.git'), GIT_WORK_TREE: other.root,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: MARKER,
    },
    run: (command, args, options) => {
      commands.push(command);
      if (command !== 'git') return { status: 0 };
      assert.equal(options.env.GIT_DIR, undefined);
      assert.equal(options.env.GIT_WORK_TREE, undefined);
      assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
      return spawnSync(command, args, options);
    },
    shippingChecks: async options => { checkedCommit = options.commit; },
  });
  assert.equal(status, 0);
  assert.equal(checkedCommit, actualHead);
  assert.deepEqual(commands, ['git', process.execPath]);
});

test('importing the deployment function from stdin has no CLI side effects', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `await import(${JSON.stringify(join(f.root, 'scripts/deploy-native-app.mjs'))}); console.log('imported');`,
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, ...managed },
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.trim(), 'imported');
  assert.equal(await exists(f.marker), false);
});
