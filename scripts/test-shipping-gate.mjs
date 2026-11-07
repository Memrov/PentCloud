import assert from 'node:assert/strict';
import test from 'node:test';

import * as gate from './lib/shipping-gate.mjs';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const NAMES = ['Verify', 'Browser fixtures', 'Customer install and upgrade'];
const MARKER = 'private-api-body-or-check-output';

function check(name, id, patch = {}) {
  return {
    id, name, head_sha: COMMIT, status: 'completed', conclusion: 'success',
    started_at: '2026-11-06T00:00:00Z', completed_at: '2026-11-06T00:01:00Z',
    app: { id: 15368, slug: 'github-actions', owner: { login: 'github', id: 9919 }, html_url: 'https://github.com/apps/github-actions' },
    output: { title: MARKER, summary: MARKER, text: MARKER },
    ...patch,
  };
}

const green = () => NAMES.map((name, index) => check(name, index + 1));
const response = (runs, total = runs.length, headers = {}) => new Response(JSON.stringify({ total_count: total, check_runs: runs }), { headers });

function harness(fetcher, options = {}) {
  let time = 1000;
  const sleeps = [];
  const logs = [];
  return {
    logs, sleeps,
    run: settings => {
      assert.equal(typeof gate.awaitShippingChecks, 'function');
      return gate.awaitShippingChecks({
        commit: COMMIT, fetcher, now: () => time,
        sleep: async delay => { sleeps.push(delay); time += delay; },
        log: entry => logs.push(entry), timeoutMs: 30, pollMs: 10,
        ...options, ...settings,
      });
    },
    advance: delay => { time += delay; },
  };
}

function fixedError(code) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(MARKER), false);
    return true;
  };
}

test('three successful exact-commit GitHub Actions checks yield only a minimal receipt', async () => {
  const requests = [];
  const h = harness(async (url, options) => { requests.push({ url, options }); return response(green()); });
  const receipt = await h.run();
  assert.deepEqual(receipt, { commit: COMMIT, checks: [
    { name: 'Verify', id: 1, conclusion: 'success' },
    { name: 'Browser fixtures', id: 2, conclusion: 'success' },
    { name: 'Customer install and upgrade', id: 3, conclusion: 'success' },
  ] });
  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  const target = new URL(url);
  assert.equal(target.origin, 'https://api.github.com');
  assert.equal(target.pathname, `/repos/Memrov/PentCloud/commits/${COMMIT}/check-runs`);
  assert.equal(target.searchParams.get('per_page'), '100');
  assert.equal(target.searchParams.get('filter'), 'all');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(new Headers(options.headers).has('authorization'), false);
  assert.equal(options.credentials, 'omit');
  assert.equal(h.sleeps.length, 0);
  assert.equal(JSON.stringify([receipt, h.logs]).includes(MARKER), false);
});

test('invalid commit and repository inputs never reach the public API', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return response(green()); });
  for (const commit of [undefined, '', 'main', COMMIT.toUpperCase(), `${COMMIT}\n`, `${COMMIT}/../main`, 'a'.repeat(39), 'g'.repeat(40), 123]) {
    await assert.rejects(h.run({ commit }), fixedError('PC_SHIPPING_COMMIT'));
  }
  for (const repository of ['', 'Memrov', '../PentCloud', 'Memrov/PentCloud/../private', 'Memrov/PentCloud?token=private', 'Memrov/PentCloud#private', 'Memrov/PentCloud\n', 'Memrov%2fprivate/PentCloud', 'Memrov/.', 'Memrov/..', 'https://api.github.com/repos/Memrov/PentCloud']) {
    await assert.rejects(h.run({ repository }), fixedError('PC_SHIPPING_REPOSITORY'));
  }
  assert.equal(calls, 0);
});

test('public repository override stays within the GitHub repository URL', async () => {
  let target;
  const h = harness(async url => { target = new URL(url); return response(green()); });
  await h.run({ repository: 'example-owner/example.repo_2' });
  assert.equal(target.pathname, `/repos/example-owner/example.repo_2/commits/${COMMIT}/check-runs`);
});

test('pagination collects all pages before deciding a newer rerun failed', async () => {
  const pages = [];
  const h = harness(async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    return page === 1 ? response(green(), 101) : response([check('Verify', 101, { conclusion: 'failure' })], 101);
  });
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_CHECK_FAILED'));
  assert.deepEqual(pages, [1, 2]);
});

test('newest check ID wins over API order and misleading dates', async () => {
  const h = harness(async () => response([
    check('Verify', 1, { completed_at: '2099-01-01T00:00:00Z' }),
    ...green().slice(1),
    check('Verify', 10, { conclusion: 'failure', started_at: null, completed_at: '1900-01-01T00:00:00Z' }),
  ]));
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_CHECK_FAILED'));
});

for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral', 'stale']) {
  test(`completed ${conclusion} is never accepted as a shipping success`, async () => {
    const h = harness(async () => response([check('Verify', 4, { conclusion }), ...green().slice(1)]));
    await assert.rejects(h.run(), fixedError('PC_SHIPPING_CHECK_FAILED'));
    assert.deepEqual(h.sleeps, []);
  });
}

test('mismatched SHA in required check metadata fails closed', async () => {
  const h = harness(async () => response([check('Verify', 1, { head_sha: OTHER_COMMIT }), ...green().slice(1)]));
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_SHA_MISMATCH'));
});

for (const app of [null, {}, { id: 15368, slug: 'forged-actions', owner: { login: 'github', id: 9919 } }, { id: 123, slug: 'github-actions', owner: { login: 'github', id: 9919 } }, { id: 15368, slug: 'github-actions', owner: { login: 'forged', id: 9919 } }, { id: 15368, slug: 'github-actions', owner: { login: 'github', id: 123 } }]) {
  test(`untrusted app cannot satisfy a required check (${JSON.stringify(app)})`, async () => {
    const h = harness(async () => response([check('Verify', 1, { app }), ...green().slice(1)]));
    await assert.rejects(h.run(), fixedError('PC_SHIPPING_TIMEOUT'));
  });
}

test('a newer queued rerun supersedes an old failure and can later pass', async () => {
  let attempt = 0;
  const h = harness(async () => response([
    check('Verify', 1, { conclusion: 'failure' }), ...green().slice(1),
    check('Verify', 10, ++attempt === 1 ? { status: 'queued', conclusion: null } : {}),
  ]));
  const receipt = await h.run();
  assert.equal(receipt.checks[0].id, 10);
  assert.deepEqual(h.sleeps, [10]);
});

test('a previously seen newer pending rerun cannot regress to an older success', async () => {
  let attempt = 0;
  const h = harness(async () => response(++attempt === 1 ? [...green(), check('Verify', 10, { status: 'queued', conclusion: null })] : green()));
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_TIMEOUT'));
});

for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
  test(`${status} is polled until the exact check completes successfully`, async () => {
    let attempt = 0;
    const h = harness(async () => response([check('Verify', 1, ++attempt === 1 ? { status, conclusion: null } : {}), ...green().slice(1)]));
    await h.run();
    assert.deepEqual(h.sleeps, [10]);
    assert.deepEqual(h.logs[0], { code: 'PC_SHIPPING_WAITING', passed: 2, pending: 1 });
  });
}

test('missing checks time out within the configured budget without success logs', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return response([]); });
  await assert.rejects(h.run({ timeoutMs: 25 }), fixedError('PC_SHIPPING_TIMEOUT'));
  assert.deepEqual(h.sleeps, [10, 10, 5]);
  assert.equal(calls, 3);
  assert.equal(h.logs.some(log => log.code === 'PC_SHIPPING_READY'), false);
});

test('network time spent fetching checks counts against the gate deadline', async () => {
  const h = harness(async () => { h.advance(31); return response(green()); });
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_TIMEOUT'));
});

test('malformed response and check metadata fail with controlled errors', async () => {
  for (const data of [{}, { check_runs: [] }, { total_count: -1, check_runs: [] }, { total_count: 1.5, check_runs: [] }, { total_count: 0, check_runs: {} }, { total_count: 10001, check_runs: [] }]) {
    const h = harness(async () => new Response(JSON.stringify(data)));
    await assert.rejects(h.run(), fixedError('PC_SHIPPING_RESPONSE'));
  }
  for (const patch of [{ id: 0 }, { id: '1' }, { id: Number.MAX_SAFE_INTEGER + 1 }, { status: 'unknown' }, { status: 'completed', conclusion: null }, { status: 'completed', conclusion: MARKER }]) {
    const h = harness(async () => response([check('Verify', 1, patch), ...green().slice(1)]));
    await assert.rejects(h.run(), fixedError('PC_SHIPPING_RESPONSE'));
  }
});

test('malformed JSON never exposes API body contents', async () => {
  const h = harness(async () => new Response(`invalid-${MARKER}`));
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_RESPONSE'));
});

test('HTTP failures do not read or expose response bodies', async () => {
  for (const [status, code] of [[301, 'PC_SHIPPING_HTTP'], [401, 'PC_SHIPPING_HTTP'], [403, 'PC_SHIPPING_RATE_LIMIT'], [404, 'PC_SHIPPING_HTTP'], [429, 'PC_SHIPPING_RATE_LIMIT'], [500, 'PC_SHIPPING_HTTP']]) {
    let bodyReads = 0;
    const h = harness(async () => ({ status, ok: false, json: () => { bodyReads++; throw Error(MARKER); }, text: () => { bodyReads++; throw Error(MARKER); } }));
    await assert.rejects(h.run(), fixedError(code));
    assert.equal(bodyReads, 0);
    assert.deepEqual(h.logs, []);
  }
});

test('network errors never expose fetch exception details', async () => {
  const h = harness(async () => { throw Error(MARKER); });
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_NETWORK'));
});

test('redirected successful responses are rejected before reading metadata', async () => {
  const h = harness(async () => ({ ok: true, status: 200, redirected: true, json: () => { throw Error(MARKER); } }));
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_HTTP'));
});

test('pagination never follows API link headers to another origin or path', async () => {
  const urls = [];
  const h = harness(async url => {
    urls.push(url);
    return Number(new URL(url).searchParams.get('page')) === 1
      ? response(green().slice(0, 2), 101, { link: '<https://private.invalid/secrets?token=private>; rel="next"' })
      : response([green()[2]], 101);
  });
  await h.run();
  assert.equal(urls.length, 2);
  assert.equal(urls.every(url => new URL(url).origin === 'https://api.github.com'), true);
  assert.equal(urls.every(url => new URL(url).pathname === `/repos/Memrov/PentCloud/commits/${COMMIT}/check-runs`), true);
});

test('invalid polling budgets are rejected before network access', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return response(green()); });
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Infinity }, { timeoutMs: 600001 }, { pollMs: 0 }, { pollMs: -1 }, { pollMs: NaN }]) {
    await assert.rejects(h.run(options), fixedError('PC_SHIPPING_OPTIONS'));
  }
  assert.equal(calls, 0);
});

test('a stalled network request is aborted at the gate deadline', async () => {
  let signal;
  const h = harness(async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  await assert.rejects(h.run({ timeoutMs: 5 }), fixedError('PC_SHIPPING_TIMEOUT'));
  assert.equal(signal.aborted, true);
});

test('a stalled JSON response is bounded by the same request deadline', async () => {
  const h = harness(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  await assert.rejects(h.run({ timeoutMs: 5 }), fixedError('PC_SHIPPING_TIMEOUT'));
});

test('latest successful rerun wins even when an older failure is last in the API array', async () => {
  const h = harness(async () => response([
    check('Verify', 100), ...green().slice(1), check('Verify', 1, { conclusion: 'failure' }),
  ]));
  const receipt = await h.run();
  assert.equal(receipt.checks[0].id, 100);
});

test('similarly named checks and unrelated failures cannot satisfy or veto required checks', async () => {
  const h = harness(async () => response([
    ...green().slice(1), check('Verify (pull request)', 100), check('Unrelated job', 101, { conclusion: 'failure' }),
  ]));
  await assert.rejects(h.run(), fixedError('PC_SHIPPING_TIMEOUT'));
});

test('an untrusted same-name failure does not override the trusted Actions result', async () => {
  const h = harness(async () => response([
    ...green(), check('Verify', 100, { conclusion: 'failure', app: { id: 123, slug: 'another-app' } }),
  ]));
  const receipt = await h.run();
  assert.equal(receipt.checks[0].id, 1);
});

test('managed default-config deployments cannot bypass the gate through missing branch metadata', () => {
  assert.equal(typeof gate.shouldGateManagedDeployment, 'function');
  assert.equal(gate.shouldGateManagedDeployment({ environment: { WORKERS_CI: '1' } }), true);
  assert.equal(gate.shouldGateManagedDeployment({ environment: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' } }), true);
  assert.equal(gate.shouldGateManagedDeployment({ environment: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'preview' } }), true);
});

test('local and customer-config deployments do not use the repository shipping gate', () => {
  assert.equal(typeof gate.shouldGateManagedDeployment, 'function');
  for (const environment of [{}, { CI: 'true' }, { WORKERS_CI: 'true' }, { WORKERS_CI: '0' }]) {
    assert.equal(gate.shouldGateManagedDeployment({ environment }), false);
  }
  assert.equal(gate.shouldGateManagedDeployment({ environment: { WORKERS_CI: '1' }, customConfig: '/customer/app.json' }), false);
  assert.equal(gate.shouldGateManagedDeployment({ environment: { WORKERS_CI: '1' }, customConfig: true }), false);
});
