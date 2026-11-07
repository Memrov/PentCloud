# Stable SDK upgrade — 7 November 2026

## Supported application changes

This change pins Cloudflare Agents 0.33.0, OpenCode SDK/plugin 2.2.6 and Wrangler
4.158.0. The resolved OpenCode dependency graph uses 2.2.6 and Effect 4.1.0.
It accompanies the native per-agent search provider selector already in this
branch: TinyFish, Exa, Firecrawl, Parallel and Tavily, with TinyFish as the default.
Credentials remain native encrypted Worker secrets.

Native operation waiting now subscribes before admitting the operation and uses
operation events to wake the caller. `session.wait` still supplies the authoritative
result. This removes the observed polling tail without replacing operation state,
external-tool drain, cancellation, duplicate admission or publication ownership
checks. Tests cover terminal events, withdrawals, stream faults, rejected duplicate
admission, subscription failures, submission failures and abort races.

The new synchronous agent/tool transforms load current state before installing
the callbacks. Conversation promotion reloads both definitions before clearing its
fence. Model/provider configuration is written once through native configuration;
the plugin retains model activation and modality declarations.

No container image or tool-runtime source pair changes are part of this upgrade.
Production continues using its supported HTTP model transport.

## Verification and corrected failure

| Check | Result |
| --- | --- |
| Application TypeScript check | Passed |
| Focused operation, tool, model, BYOK, projection and contract tests | 51 tests after refreshing the stale contract fixtures |
| Real Workerd attempt-runtime integration | Passed, including cancellation, replay/drain, model setup, secret redaction, preparation/reload failures and recovery paths |
| Vite application build and Wrangler deployment dry run | Passed |
| Agents 0.32.0/OpenCode 2.2.5 to Agents 0.33.0/OpenCode 2.2.6 SQLite upgrade | Passed on 7 November at 22:45 UTC: completed history/result unchanged, committed effect count remained one, new turn completed |
| Production coordinator before promotion | No active run, publication, preparation, purge or owned project; existing runs were completed/cancelled |

The initial focused run passed 50 tests and failed the contract comparison because
its snapshots were still from OpenCode 2.2.5. Review identified additive
`cache.warming` configuration and narrower optional parameter nullability; adopted
request and response schemas were unchanged. The application consumers omit the
nullable query wrappers and remain compatible.

The fixtures now record the exact 2.2.6 provenance and SHA-256 checksums. The
comparator was not weakened. All seven contract tests pass, including mutations
that remove operations or change nested request, reply and error schemas. The
published configuration schema's deprecated V1 `skills` object remains the sole
expected difference from the installed V2 declarations.

The existing coordinator negative-test cast also uses `NonNullable` so the
intentional invalid value remains valid test code under exact optional property
types. This addresses the earlier pull-request TypeScript failure.

## Failed or unproven experiments

Full raw results, runnable second-pass fixtures and reproduction instructions are
kept in the private Cloudflare Artifacts repository
`pentcloud-labs/agents-opencode-lab`, under `experiments/retests`.
They are not published to GitHub.

- The default Promise-host model WebSocket transport failed under Workerd because
  its Node WebSocket constructor is unavailable. A separate native Effect-layer
  connector passed an isolated Service Binding test, but it is not an established
  drop-in replacement for the application's Promise host. HTTP remains in use.
- Tested beta packages were incompatible or failed host startup. A dev package
  passed a small isolated smoke test outside the supported peer range; it is not
  selected for production.
- Recovery may repeat an external effect. External idempotency receipts and
  reconciliation remain required; the experiments do not prove exactly-once
  external execution.
- The successful cross-version upgrade covers completed sessions. Cross-version
  migration of an in-flight operation, infrastructure/OOM recovery and live paid
  model assessments were not established by these tests.
- Duplicate admission did not repeat the user input or tool effect, but it could
  add an idle marker; transcript byte identity is not promised for that case.
- Cache warming showed no measured benefit for the tested short-lived host and
  remains disabled. Experimental CodeMode VM changes are not adopted.

The observed synthetic event-wait result (about 1,078 ms versus 61 ms) measures
completion notification overhead in that fixture; it is not a model-inference
speed claim. The OpenCode harness itself remains an experimental Cloudflare
feature even with stable npm dependency versions.

## Upstream references

- [Cloudflare Agents 0.33.0](https://github.com/cloudflare/agents/releases/tag/agents%400.33.0)
- [OpenCode 2.2.6](https://github.com/anomalyco/opencode/releases/tag/v2.2.6)
- [Wrangler 4.158.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.158.0)
- [OpenCode V2 session contract](https://github.com/anomalyco/opencode/blob/v2.2.6/specs/v2/session.md)
- [Cloudflare OpenCode harness](https://developers.cloudflare.com/agents/harnesses/opencode/)
- [Cloudflare Durable Object retries](https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/)
- [Cloudflare container rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/)

## Promotion record

The release must pass the normal pull-request checks and deploy through the
existing GitHub-to-Cloudflare Builds connection. Its source change needs only a
Worker rollout; the existing container images are unchanged. Recheck coordinator
activity immediately before promotion, then record the merged source commit,
build outcome, active deployment/version and live validation in the completion
report. This pre-promotion document does not claim the deployment has completed.
