# Cloudflare Playwright harness

Implement the approved Cloudflare approach from the browser-tooling audit:
standard Node Playwright Test owns the browser suite; `createTestHarness()` owns
local Worker execution. Vite+ remains the command entry point. No deployment,
remote account changes, dependency additions or automatic merge.

## Task 1: Native fixture and representative flow

Add a regression that leaves a stream fixture behind and requires clean state
in the next test. Observe the current preview server fail that isolation check.
Replace preview middleware with a small Workers HTTP/SSE fixture using the
production UI security policy and compiled frontend assets. Build once, reuse
Wrangler's prebuilt Worker directory on resets, and use Playwright worker/test
fixtures for listen, dynamic base URL, failure diagnostics, reset and close.
Verify the isolation regression and both existing real EventSource scenarios.

Expected: fresh Worker state between tests; exact SSE framing, real disconnect
and reconnect, production CSP and frontend behavior remain covered.

## Task 2: Browser suite and native diagnostics

Move all existing browser tests to the shared fixture; preserve their scenario
assertions and external-localhost compatibility. Validate two-worker execution,
native failure traces/attachments and the missing historical-log label assertion.
Remove the replaced preview server and expose the standard focused/debug CLI
workflow in agent and testing instructions. Do not rewrite deployed Access/CDP
adapters or the production interception path in this local harness migration.

Expected: all existing cases and the isolation regression pass with two workers;
failure diagnostics and teardown work without a leaked server. No paid requests.

## Task 3: Final gate and delivery

Run native static/type checks, the complete browser suite, backend tests and the
existing transport gates appropriate to the fixture/configuration change. Measure
the browser duration, inspect desktop/mobile captures, and obtain a fresh review
of this task's complete diff. Commit and update the existing streamlining PR.

Expected: checks pass, no warning ceiling increase, clean pushed branch and clear
documentation of measured results and any limits.

## Review focus

Per-test Worker reset and changing server URLs; failure teardown and open SSE
connections; per-worker port/state isolation; production CSP/static asset parity;
stream disconnect/reconnect behavior; explicit localhost URL validation; preserved
browser assertions and no remote resource access or deployment.
