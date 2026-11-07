// Workers Builds injects WORKERS_CI=1. Branch and commit validation belongs to
// the managed deployment wrapper, so absent branch metadata cannot bypass this.
export function shouldGateManagedDeployment({ environment = {}, customConfig } = {}) {
  return environment.WORKERS_CI === '1' && !customConfig;
}

const REQUIRED_CHECKS = ['Verify', 'Browser fixtures', 'Customer install and upgrade'];
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral', 'stale']);
const MAX_CHECKS = 10000;
const MAX_TIMEOUT_MS = 600000;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function validRepository(repository) {
  if (typeof repository !== 'string') return false;
  const [owner, repo, extra] = repository.split('/');
  return extra === undefined && owner?.length > 0 && owner.length <= 39
    && !/[^a-zA-Z0-9-]/.test(owner) && !owner.startsWith('-') && !owner.endsWith('-')
    && repo?.length > 0 && repo.length <= 100 && !/[^a-zA-Z0-9_.-]/.test(repo)
    && repo !== '.' && repo !== '..';
}

// Verified from public Memrov/PentCloud check-run metadata. Pin the immutable
// app and owner IDs as well as their slugs; a same-name third-party check is not
// evidence that the repository's GitHub Actions workflow passed.
function trustedActionsApp(app) {
  return app?.id === 15368 && app.slug === 'github-actions'
    && app.owner?.id === 9919 && app.owner.login === 'github';
}

/**
 * Read public GitHub Checks metadata for one immutable commit without a token.
 * Never surfaces check output or requests annotations or logs. Terminal checks
 * with a non-success conclusion fail
 * immediately. Retry the managed Build after a newer GitHub rerun succeeds.
 * https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
 */
export async function awaitShippingChecks({
  commit, repository = 'Memrov/PentCloud', fetcher = fetch,
  now = Date.now, sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  timeoutMs = MAX_TIMEOUT_MS, pollMs = 10000, log = () => {},
} = {}) {
  if (typeof commit !== 'string' || commit.length !== 40 || !/^[a-f0-9]{40}$/.test(commit)) throw failure('PC_SHIPPING_COMMIT');
  if (!validRepository(repository)) throw failure('PC_SHIPPING_REPOSITORY');
  if (![fetcher, now, sleep, log].every(value => typeof value === 'function')
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
      || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw failure('PC_SHIPPING_OPTIONS');

  const deadline = now() + timeoutMs;
  const remaining = () => {
    const budget = deadline - now();
    if (!Number.isFinite(budget) || budget <= 0) throw failure('PC_SHIPPING_TIMEOUT');
    return budget;
  };
  const endpoint = `https://api.github.com/repos/${repository}/commits/${commit}/check-runs`;
  const latest = new Map();

  async function readPage(page) {
    const controller = new AbortController();
    let timer;
    let expired = false;
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(failure('PC_SHIPPING_TIMEOUT'));
      }, remaining());
    });
    const read = async () => {
      let result;
      try {
        result = await fetcher(`${endpoint}?per_page=100&filter=all&page=${page}`, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
        });
      } catch {
        throw failure(expired ? 'PC_SHIPPING_TIMEOUT' : 'PC_SHIPPING_NETWORK');
      }
      remaining();
      if (!result?.ok || result.status !== 200 || result.redirected) {
        throw failure(result?.status === 403 || result?.status === 429 ? 'PC_SHIPPING_RATE_LIMIT' : 'PC_SHIPPING_HTTP');
      }
      let data;
      try { data = await result.json(); } catch { throw failure('PC_SHIPPING_RESPONSE'); }
      remaining();
      if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.total_count > MAX_CHECKS
          || !Array.isArray(data.check_runs) || data.check_runs.length > 100
          || data.check_runs.length > data.total_count) throw failure('PC_SHIPPING_RESPONSE');
      return data;
    };
    try { return await Promise.race([read(), expiry]); } finally { clearTimeout(timer); }
  }

  // Reconstruct page URLs from validated inputs and total_count rather than
  // following API-provided Link URLs, so pagination cannot redirect the reader.
  for (;;) {
    remaining();
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const data = await readPage(page);
      pages = Math.max(pages, Math.ceil(data.total_count / 100));
      for (const run of data.check_runs) {
        if (!REQUIRED_CHECKS.includes(run?.name) || !trustedActionsApp(run.app)) continue;
        if (run.head_sha !== commit) throw failure('PC_SHIPPING_SHA_MISMATCH');
        if (!Number.isSafeInteger(run.id) || run.id <= 0
            || !(PENDING_STATUSES.has(run.status) || run.status === 'completed')
            || (run.status === 'completed' && !CONCLUSIONS.has(run.conclusion))) throw failure('PC_SHIPPING_RESPONSE');
        // IDs establish rerun order. Timestamps and API array order do not.
        // Keep the highest ID across polls to avoid a stale snapshot reverting
        // a newly observed pending rerun back to an older successful check.
        if (!latest.has(run.name) || run.id >= latest.get(run.name).id) {
          latest.set(run.name, { id: run.id, status: run.status, conclusion: run.conclusion });
        }
      }
    }
    remaining();
    const runs = REQUIRED_CHECKS.map(name => latest.get(name));
    if (runs.some(run => run?.status === 'completed' && run.conclusion !== 'success')) throw failure('PC_SHIPPING_CHECK_FAILED');
    const passed = runs.filter(run => run?.status === 'completed' && run.conclusion === 'success').length;
    if (passed === REQUIRED_CHECKS.length) {
      log({ code: 'PC_SHIPPING_READY', passed, pending: 0 });
      return { commit, checks: REQUIRED_CHECKS.map(name => ({ name, id: latest.get(name).id, conclusion: 'success' })) };
    }
    log({ code: 'PC_SHIPPING_WAITING', passed, pending: REQUIRED_CHECKS.length - passed });
    await sleep(Math.min(pollMs, remaining()));
  }
}
