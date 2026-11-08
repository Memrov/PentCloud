# Development and testing

Tests use Cloudflare's [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and [Wrangler test harness](https://developers.cloudflare.com/workers/testing/).
They run local Workers and isolated state; deterministic substitutes represent
external model/scanner services.

Use Node 26.12.1 or a compatible later 26.x and Python 3.11+. The full gate also
uses Go 1.26.5 to verify preserved import hashes and contract catalogs.
Run `npm ci` after checkout or a lockfile change; gates reuse those dependencies.
Native Markdown is loaded directly, without a Go prompt build or runtime renderer.

| Command | Purpose |
| --- | --- |
| `npm run check` | Formatting, lint, app types, native Markdown policy and unit/native API checks |
| `npm run format` | Format code with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (80 columns, Cloudflare's style) |
| `npm run format:check` | Fail if any code is not formatted |
| `npm run lint` | Type-aware [oxlint](https://oxc.rs/docs/guide/usage/linter), including `no-floating-promises` |
| `npm run test:watch` | Watch unit tests |
| `npm run test:workers:watch` | Watch native Worker tests |
| `npm run verify` | App checks, Vite production build, compiled stack/map checks and Wrangler dry run |
| `npm run verify:gateway` | Gateway types, bundle, file-transfer and lifecycle tests |
| `npm run verify:full` | Both Worker gates, import/contract integrity, auth, lifecycle, Git publication and recovery checks |
| `npm run test:integration` | Whole-Worker Coordinator/Attempt and evidence fixtures |
| `npm run test:browser` | Playwright UI fixtures; install Chromium with `npm exec -- playwright install chromium` |

Every verify gate runs `format:check` and `lint` first. Formatting covers
TypeScript, JavaScript and CSS only; Markdown (including specialist prompts),
JSON, YAML and generated Worker types are never reformatted. If
`format:check` still fails right after `npm run format`, run `format` once
more: oxfmt 0.74 settles a few files on its second pass. Lint rules listed
as backlog in `.oxlintrc.json` warn instead of failing until they are fixed.
To skip the one-time formatting commit in `git blame`, run
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

A focused test can be selected with, for example,
`npm run test:unit -- test/materials-ui.test.ts`.
The unit gate does not run the separate Playwright browser suite. A passing
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

New customer installs use root `npm run build` and `npm run deploy`. Existing
separate-Worker installations must retain their private configuration and
historical migration tags; use the [dated upgrade instructions](legacy-migrations-2026-11-08.md#existing-separate-worker-builds).

Protect `main` with passing GitHub checks; Cloudflare's push-triggered build does not wait for GitHub environment
approvals.

## Prompt sources

The original PentAGI templates and their import/provenance hashes are preserved.
Go template execution is retired for new settings and launches; reset historical
roles to Markdown in settings before starting new work. Historical settings and
already-rendered attempts retain their original bytes and digests.
Edit the [canonical native Markdown](../../apps/control-plane/src/native/specialists/README.md)
directly. Native launch tests cover both installed backend variants and the rules
that remain active without a loaded skill. The full gate verifies original import
hashes and contract catalogs. The [frozen adaptation record](../../upstream/pentagi/README.md)
describes the retired generator baseline; it is not regenerated to match edits.

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
