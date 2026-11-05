# Development and testing

Tests use Cloudflare's [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and [Wrangler test harness](https://developers.cloudflare.com/workers/testing/).
They run local Workers and isolated state; deterministic substitutes represent
external model/scanner services.

Use Node 26.12.1 or a compatible later 26.x, Go 1.26.5 and Python 3.11+.
Run `npm ci` after checkout or a lockfile change. The gates reuse dependencies
and the installed Go compiler, and prepare the Go/Wasm assets themselves.

| Command | Purpose |
| --- | --- |
| `npm run check` | App types, prompt preservation, unit/native API and source-map checks |
| `npm run test:watch` | Watch unit tests |
| `npm run test:workers:watch` | Watch native Worker tests |
| `npm run verify` | App checks and production bundle |
| `npm run verify:gateway` | Gateway types, bundle, file-transfer and lifecycle tests |
| `npm run verify:full` | Both Worker gates, Go/renderer, installer/auth, lifecycle, Git publication and recovery checks |
| `npm run test:integration` | Whole-Worker Coordinator/Attempt and evidence fixtures |
| `npm run test:browser` | Attachment/browser fixtures; requires installed Chrome |

A focused test can be selected with, for example,
`npm run test:unit -- test/materials-ui.test.ts`.
Environment-gated browser cases are skipped unless explicitly enabled; a passing
local gate does not establish live human login, browser appearance, paid inference
or scanner acceptance in a Cloudflare account.

## Choosing checks

Run the full gate for admission, SQLite, Git publication, cancellation, scanner
control, shared authentication/RPC, prompts, dependencies or deployment-tooling
changes. UI changes need relevant browser cases and the fast app gate.
Documentation changes need local-link and diff checks; diagram changes also need
regenerated exports and visual inspection. All local verification commands above
leave deployed resources alone and make no production model/scanner requests.

For deployed screenshots and interaction review, use the standalone
[browser QA commands](browser-qa.md). Review the desktop/phone captures yourself;
loading pages or successful bundles are not evidence of correct layout.
Remote QA uses Cloudflare resources and can incur normal platform usage.

## Native Builds

GitHub Actions runs the full local gate and isolated browser fixtures on pull
requests and `main`, without Cloudflare or model credentials. Dependency review
checks new dependencies, and Dependabot proposes updates for review. Keep
production deployment in Cloudflare's native Git integration; do not give public
pull requests deployment authorization or enable production branch previews.

Configure one source per Worker in your own account. Native Builds installs from
the root lockfile before the build command; local verification scripts do not
reinstall packages. Enable Cloudflare's
[build caching](https://developers.cloudflare.com/workers/ci-cd/builds/build-caching/)
for package downloads. A cache is not a stored test result. Use the generated
installation configs and private deployment authorization; public pull requests
must not receive production credentials.

To deploy an existing installation from shared source, save its generated
Wrangler JSON as `PENTCLOUD_DEPLOY_CONFIG`, a **secret build variable** on that
Worker's Cloudflare Builds connection. Run
`node scripts/configure-cloudflare-build.mjs app` (or `gateway`) before compiling.
The helper applies installation metadata inside the ephemeral build checkout,
checks the Worker identity and preserves the source's migrations and binding
contracts. Installer entrypoint and asset paths are rebased to the build checkout;
both shipped migration histories are accepted without rewriting migration tags.
Required secret names are declared for generated types; their values stay bound.
Keep actual API keys in bound Worker secrets; the JSON must contain
configuration metadata only. Never upload the generated config or deployment
logs as public CI artifacts. Use the existing app deploy helper to preserve the
prebuilt module catalog and source maps. Protect `main` with passing GitHub
checks; Cloudflare's push-triggered build does not wait for GitHub environment
approvals.

## Prompt sources

The original PentAGI templates and golden rendering fixtures are preserved.
Regenerate the native Markdown defaults with `go run ./scripts/native-specialists`
and check them with `go run ./scripts/native-specialists -check`.
The full gate verifies deterministic generation and original prompt hashes.
