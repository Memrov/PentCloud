# Vite+ streamlining — 2026-11-08

This implements all six tasks in the [accepted plan](../plans/2026-11-08-vite-plus-streamlining.md).
Vite+ now owns test collection, focused feedback, lint policy and verification
dependencies. Custom code remains where it implements PentCloud behavior or
tests a real platform boundary. No dependencies or storage schemas changed.

## What changed

- Unit tests use isolated threads. Seven Python-backed schema checks have their
  own `contracts` project and remain in every complete app gate. Three rendering
  tests were removed after confirming their behavior in Playwright; unique
  disabled-control, privacy, filtering and state assertions remain.
- Coordinator, materials, evidence and lifecycle scenarios run in a native
  Workers project. Attempt scenarios and assertions moved from the Python
  drivers into Workers Vitest. The old duplicate drivers were removed.
  The projects retain real crashes, persisted storage, exact provenance,
  failing HTTP statuses, and cross-object Git/SQLite checks.
- Real HTTP/model/Explorer and Agent WebSocket smoke tests still run through
  Wrangler. They exercise transport boundaries that direct runtime RPC cannot.
- Native tasks declare the verification graph. Runtime, transport, browser,
  build and deploy gates explicitly disable caching. The small Bash adapter
  only preserves existing entry points; small Node adapters check the required
  environment and Go toolchain. Repeated workspace `tsc` runs were removed
  after a deliberate type error was rejected in all three workspace roots.
- Native Vitest lint rules reject focused tests, duplicate titles and invalid
  assertions. Throw-message and complexity rules expose further backlog.
  `check:static` enforces a ceiling of 311 warnings; lower it as findings are
  fixed. This is a ratchet, not a claim that the backlog is resolved.
- Router handlers, onboarding actions, attempt state/history transport,
  conversation sections/actions/scrolling and session projection responsibilities
  now have separate typed modules. Durable Object state, transactions,
  admission fences and cleanup ownership remain with their original owners.

The onboarding extraction also fixed an existing error boundary: a rejected
asynchronous bounty check could bypass RPC secret redaction. A regression test
first reproduced the leak, then passed with the awaited action registry.

## Measured changes

Line counts describe smaller ownership boundaries, not equivalent deletion of
domain logic. Extracted responsibilities still exist in their own modules.

| Entry point | Before lines | After lines |
| --- | ---: | ---: |
| Native router | 837 | 257 |
| Coordinator | 4,573 | 4,293 |
| Attempt | 4,903 | 4,721 |
| Specialist chat | 680 | 382 |
| Session projection facade | 930 | 198 |
| Attempt fixture Worker | 4,007 | 1,215 |

Native complexity measurements fell from 235 to 46 for router dispatch, 105 to
18 for onboarding dispatch, 56 to 36 for the attempt execution snapshot, 96 to
51 for specialist chat, and 269 to 21 for the attempt probe dispatcher. Chat
still exceeds the warning threshold of 50; it is not exempted.

One local comparison measured the materials driver at 6.74 seconds and the
native project at 3.30 seconds. Isolated unit threads measured 2.88 seconds
against 3.53 seconds for forks. These are single-machine observations, not
stable benchmark guarantees. File isolation remains enabled.

## Verification

Targeted runs passed 435 unit tests, 68 attempt cases, 62 coordinator cases,
48 router cases and all 47 Playwright cases. Desktop and mobile captures were
also inspected. Customer deployment contract tests pass all six cases.

Mutation checks rejected corrupted material bytes, provider HTTP 500 responses,
focused/duplicate tests and type errors in each workspace. Mutations were
restored before final verification. Exact evidence provenance and the purge
failure's HTTP 500 status remain asserted.

The final `vp run verify:full` passed all 23 tasks, including 622 tests across
82 files, two separate customer runtime tests, Node and Go checks, HTTP/WS smoke
tests, generated types, app/gateway/tool-pack builds and the app dry run.
`vp run build` and `vp run deploy --dry-run --containers-rollout=none` also passed
for the separate customer output. Local fixtures do not establish production
login or paid service acceptance. See [testing commands](testing.md) for the
current CLI workflow.

## Decisions and remaining boundaries

1. Used a feature branch in the existing clean checkout, preserving installed
   tools and paths. Concurrent edits share that checkout and require care.
2. Used existing behavioral suites and targeted mutations for configuration
   and behavior-preserving refactors, following the repository's test policy.
   New tests cover discovered defects. A missing behavioral assertion could
   still leave a regression undetected.
3. Each coordinator/attempt project has one runtime entry importing focused
   case modules. The installed Cloudflare pool exits before a second sequential
   file. Select cases by name; list them with native
   `vp test list --project attempt --no-static-parse`. This limits file-level
   selection until the upstream pool issue is resolved.
4. Build/deploy/browser package scripts retain direct CLI commands because
   nested task wrappers dropped forwarded filters. Native gates derive those
   commands and enforce `cache: false`; callers of legacy script aliases must
   still follow the documented policy against forcing runtime caching.

The coordinator and attempt remain large state owners. Further decomposition
should follow a concrete feature or defect and preserve their durable fences;
Vite+ cannot replace those application contracts.
