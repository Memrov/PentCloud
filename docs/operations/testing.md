# Development and testing

Tests use Cloudflare's [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and [Wrangler test harness](https://developers.cloudflare.com/workers/testing/).
They run local Workers and isolated state; deterministic substitutes represent
external model/scanner services.

Use Node 26.12.1 or a compatible later 26.x, Go 1.26.5 and Python 3.11+.
Run `npm ci` after checkout or a lockfile change. The gates reuse dependencies
and the installed Go compiler. Go checks the preserved prompt sources and generated
Markdown defaults; it is not part of the deployed prompt renderer.

| Command | Purpose |
| --- | --- |
| `npm run check` | App types, prompt preservation and unit/native API checks |
| `npm run test:watch` | Watch unit tests |
| `npm run test:workers:watch` | Watch native Worker tests |
| `npm run verify` | App checks, Vite production build, compiled stack/map checks and Wrangler dry run |
| `npm run verify:gateway` | Gateway types, bundle, file-transfer and lifecycle tests |
| `npm run verify:full` | Both Worker gates, Go specialist generation, auth, lifecycle, Git publication and recovery checks |
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
requests and `main`, without Cloudflare or model credentials. The official CodeQL
workflow scans GitHub Actions, Go, JavaScript/TypeScript and Python on pull
requests (including Dependabot), on `main` pushes and weekly, using the
security-extended query suite. Dependency review checks new dependencies, and
Dependabot proposes updates for review. Keep
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
logs as public CI artifacts. Vite builds the client and Worker together; deploy
with `npm run deploy --workspace @pentagi-artifacts/control-plane`. That command
builds and uses `dist/worker/wrangler.json`, the native generated config. Existing
private build metadata with Wrangler minify/Text rules is normalized to the Vite
source configuration without changing installation identity or migration history.
If an existing native Builds connection still uses
`node scripts/deploy-native-app.mjs`, change its deploy command to
`npm run deploy --workspace @pentagi-artifacts/control-plane` before selecting
this source revision. That npm command also works with the previous source
revision. The customer/root connection continues to use `npm run build` and
`npm run deploy`. These are configuration instructions; no existing connection
is changed by the repository update.

Protect `main` with passing GitHub checks; Cloudflare's push-triggered build does not wait for GitHub environment
approvals.

## Prompt sources

The original PentAGI templates and their import/provenance hashes are preserved.
Go template execution is retired for new settings and launches; reset historical
roles to Markdown in settings before starting new work. Historical settings and
already-rendered attempts retain their original bytes and digests.
Regenerate the native Markdown defaults with `go run ./scripts/native-specialists`
and check them with `go run ./scripts/native-specialists -check`.
The full gate verifies deterministic generation and original prompt hashes.

## Worker build output

The pinned [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
uses one `worker` environment. The app build emits assets and generated config
under `apps/control-plane/dist/`; the customer build uses the separate sibling
`apps/control-plane/dist-customer/`. Customer mode selects the root source config
with `vite build --mode customer`; the ordinary app build selects the app source
config and retains its gateway binding. Root `npm run deploy` explicitly uses
`apps/control-plane/dist-customer/worker/wrangler.json`; app deployment uses
`dist/worker/wrangler.json` from the app workspace. Building either target leaves
the other's output intact. A missing target config fails deployment instead of
falling back to the other Worker. Build the intended target before deploying it.

Worker maps omit `sourcesContent` through Rolldown's `sourcemapExcludeSources`.
`upload_source_maps: true` makes Wrangler reject missing maps. The build checks
every emitted Worker map against the 60 MiB raw/15 MiB gzip limits and executes
the real compiled identifier validator to map its exception back to TypeScript.
There is no second bundling or map-rewriting pass. Browser-only fixtures select
`--mode browser-fixture`; normal Vite development and preview use the Workers
runtime. Vitest's `test` mode disables the build plugins.
