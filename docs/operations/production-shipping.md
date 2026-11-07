# Production shipping checks

The managed app deployment command is `node scripts/deploy-native-app.mjs`.
After verifying the prebuilt configuration, module catalog, runtime hashes and
source map, it waits for the required GitHub checks before invoking Wrangler.
This gate applies when Cloudflare Workers Builds sets `WORKERS_CI=1` and the
command uses the default configuration.

The branch must be exactly `main`. `WORKERS_CI_COMMIT_SHA` must be a complete
lowercase SHA matching the build checkout's Git `HEAD`. The Git read disables
filesystem monitoring and hooks, ignores inherited Git environment overrides,
and keeps Git output private. Cloudflare documents these
[default build variables](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables)
as overridable, so an environment value alone does not establish source identity.

For that exact commit in `Memrov/PentCloud`, all three checks must complete with
the conclusion `success`:

- `Verify`
- `Browser fixtures`
- `Customer install and upgrade`

The reader uses the public [GitHub Checks API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
without a GitHub token. It accepts only checks from the verified GitHub Actions
app, reads every result page, and selects the highest check ID for each required
name. A newer queued rerun supersedes an older result. A completed failure,
cancellation, timeout, skipped result, neutral result or action-required result
stops the build before deployment. Check summaries, annotations, logs and raw API
errors are never printed; progress contains fixed codes and check counts.

## Waiting and retrying

Builds and GitHub Actions can start concurrently after a push. Missing or pending
checks are polled every ten seconds for at most ten minutes, including API read
time. GitHub rate limiting, network errors and malformed responses stop the
build. Cloudflare's [twenty-minute build limit](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
includes compilation and this wait; the platform may terminate a longer build
before the gate's own timeout. A stopped gate does not invoke Wrangler, so it
does not promote a new production version.

After a failed or timed-out build, resolve any failing GitHub jobs and wait for
all three checks to succeed on the same commit. Then retry that commit's build
from the Cloudflare Builds dashboard. A fix on a different commit needs that
commit's own passing checks and build. A failed GitHub check is not silently
accepted while waiting for a future rerun.

| Code | Action |
| --- | --- |
| `PC_SHIPPING_BRANCH` | Verify the managed production source uses `main`. |
| `PC_SHIPPING_COMMIT`, `PC_SHIPPING_HEAD`, `PC_SHIPPING_SOURCE` | Verify the build metadata and checkout identify the same commit. |
| `PC_SHIPPING_CHECK_FAILED` | Fix or rerun the latest failing required GitHub job, then retry Builds after it passes. |
| `PC_SHIPPING_TIMEOUT` | Wait for all required jobs to finish, then retry the same commit's build. |
| `PC_SHIPPING_RATE_LIMIT` | Retry after GitHub permits public API reads again. |
| `PC_SHIPPING_HTTP`, `PC_SHIPPING_NETWORK`, `PC_SHIPPING_RESPONSE`, `PC_SHIPPING_CHECKS` | Resolve the check-reader/API problem before retrying. |
| `PC_DEPLOY_PREBUILT` | Rebuild and rerun verification; the prebuilt deployment inputs could not be validated. |

## Customer deployments

The customer CLI supplies its generated `--config FILE --output DIRECTORY`.
That path keeps its existing prebuilt integrity checks and bypasses this
repository-specific production gate, including inside a managed build. Local
deployments also retain their existing behavior. The gate neither changes
GitHub branch rules nor gives public pull requests production credentials.

Run the focused checks locally with:

```sh
node --test scripts/test-shipping-gate.mjs scripts/test-deploy-native-app.mjs scripts/test-native-worker-source-maps.mjs
```

These tests use local fixtures, temporary repositories and controlled API
responses; they do not deploy a production Worker.
