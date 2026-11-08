# Development and testing

Tests use Cloudflare's [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and [Wrangler test harness](https://developers.cloudflare.com/workers/testing/).
They run local Workers and isolated state; deterministic substitutes represent
external model/scanner services.

Use Node 26.12.1 or a compatible later 26.x and Python 3.11+. The full gate also
uses Go 1.26.5 to verify preserved import hashes and contract catalogs.
The workspace uses [Vite+](https://viteplus.dev/guide/) 1.5.0 with npm pinned in
`package.json`. Install the global CLI with the official installer at
<https://viteplus.dev/guide/global-cli>, then run `vp install --frozen-lockfile`
after checkout or a lockfile change. The CLI selects Node from `.node-version`.
Without the global CLI, use `npm ci` and `npm exec -- vp <command>`; existing
npm scripts remain available. Gates reuse the installed dependencies.
Agent instructions are committed in the root `AGENTS.md`, and upstream CLI
documentation is bundled at `node_modules/vite-plus/docs`.

`vp <name>` invokes a built-in command; `vp run <name>` invokes a project script
or configured task. In particular, `vp check` runs static checks, while
`vp run check` also runs the existing app validation gate. Use `vp run build`
for the customer build and its output validation.
Native Markdown is loaded directly, without a Go prompt build or runtime renderer.

| Command | Purpose |
| --- | --- |
| `vp check` | Formatting, type-aware lint, and TypeScript checks |
| `vp run check:static` | Cached static checks with automatic input tracking |
| `vp run check` | Static checks, generated type freshness, unit, Workers and customer checks |
| `vp fmt` / `vp fmt --check` | Format code or check formatting (80 columns, Cloudflare's style) |
| `vp lint` | Type-aware lint and type checks, including `no-floating-promises` |
| `vp test` | All unit and Workers runtime projects |
| `vp run test:watch` | Watch unit tests |
| `vp run test:workers` | Router/API, question recovery and migrated attempt probes |
| `vp run test:workers:watch` | Watch native Worker tests |
| `vp run test:customer` | Customer Worker runtime checks |
| `vp run verify` | App checks, production build, compiled stack/map checks and Wrangler dry run |
| `vp run verify:gateway` | Gateway types, bundle, file-transfer and lifecycle tests |
| `vp run verify:full` | Both Worker gates, import/contract integrity, auth, lifecycle, Git publication and recovery checks |
| `vp run test:integration` | Whole-Worker Coordinator/Attempt and evidence fixtures |
| `vp run test:browser` | Playwright UI fixtures; install Chromium with `vp exec playwright install chromium` |

Every verify gate runs the shared static check task first. Formatting covers
TypeScript, JavaScript and CSS only; Markdown (including specialist prompts),
JSON, YAML and generated Worker types are excluded. Lint rules listed as
backlog in the root `vite.config.ts` warn instead of failing until fixed.
Type-aware lint and full type checking are enabled in that same config.

Only `check:static` opts into task caching. Runtime/integration/browser tests,
verification scripts and deployment run fresh by default. Do not enable
`--cache` for those commands: replayed logs are not fresh recovery evidence.
The native pre-commit hook runs `vp staged`, using the root staged-file policy.
Use `vp hooks status` or `vp env doctor` to inspect local setup.

Each Worker's `worker-configuration.d.ts` holds its bindings and the
Workers runtime types for its compatibility date and flags, as
[Cloudflare recommends](https://developers.cloudflare.com/workers/languages/typescript/)
instead of `@cloudflare/workers-types`. The files are committed and the gates
run `wrangler types --check`. After changing a Worker's Wrangler config,
compatibility date or flags, or upgrading Wrangler, regenerate with
`npm run types --workspace <workspace>` and commit the result.

Unit tests use a thread pool with file isolation retained, selected with
`vp test doctor --project unit`. For edits, use
`vp test related apps/control-plane/src/ui/components/session-controls.tsx --project unit`,
`vp test --project unit --changed`, `vp test --project unit --lastFailed`, or
`vp test watch --project unit`. Keep the full gate for dynamic imports,
filesystem fixtures and external contracts.

A focused test can be selected with, for example,
`vp test --project unit test/materials-ui.test.ts`.
Workers tests use separate `router`, `question-recovery` and `attempt` projects;
select one with `vp test --project attempt`.
The attempt project covers header redaction, legacy prompt compatibility,
native model connection and successful execution with the pinned model.
The remaining attempt scenarios still run through
`node scripts/test-native-attempt-runtime.mjs` and `check.py`. Both runners use
the same scripted HTTP services in `test/native-attempt-probe/fixture-services.ts`;
when migrating a scenario, move its assertions rather than maintaining two copies.
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
requests and `main`, without Cloudflare or model credentials. Repository policy
allows only Memrov/GitHub actions, so CI retains `actions/setup-node` and
selects npm from `packageManager`, runs `npm ci`, then invokes the pinned local
CLI with `npm exec -- vp ...`. The
official CodeQL workflow scans GitHub Actions, Go, JavaScript/TypeScript and
Python on pull requests (including Dependabot), on `main` pushes and weekly, using the
security-extended query suite. Dependency review checks new dependencies, and
Dependabot proposes updates for review. The dependency gate also runs
`npm audit --package-lock-only --audit-level=high`, which understands npm alias
identities. GitHub currently misidentifies the required Vite+ core alias as
upstream `vite@1.5.0`. Four advisory exceptions in the workflow apply alongside
an exact alias-identity/version guard and the mandatory npm audit; the installed
core bundles Vite 8.3.5, outside their affected ranges. Re-review that guard and
the advisory list when upgrading Vite+:
[GHSA-mv48-hcvh-8jj8](https://github.com/advisories/GHSA-mv48-hcvh-8jj8),
[GHSA-353f-5xf4-qw67](https://github.com/advisories/GHSA-353f-5xf4-qw67),
[GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm),
[GHSA-c27g-q93r-2cwf](https://github.com/advisories/GHSA-c27g-q93r-2cwf).
Keep production deployment in Cloudflare's native Git integration; do not give public
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
with `vp build --mode customer`; the ordinary app build selects the app source
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
