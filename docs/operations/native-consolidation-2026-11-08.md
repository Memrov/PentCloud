# Native consolidation execution record

Date: 2026-11-08 UTC (2026-11-07 America/Los_Angeles). Baseline: `7857915650c25de0842ee96a62f7d0d12d49747a`. Branch: `codex/native-consolidation`.

The 33-decision audit was executed with a strict acceptance rule: reduce repository-owned responsibility and retain required behavior. Ten of the thirteen change candidates are implemented. Three remain intentionally unchanged because the observed migration or net-simplification gate did not pass. The other twenty audit decisions already recommended retaining application policy; they remain retained.

## Decision ledger

The linked examples are the pinned open-source implementations or tests examined during the audit. They establish the native mechanism, not proof of this application's deployment.

| Decision | Result | Change or stopping reason | Upstream code example |
| --- | --- | --- | --- |
| PL-01 | Implemented | Role Markdown describes the available backend; backend-specific tool skills remain selected from native bindings. | [anomalyco/opencode](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/test/config/agent.test.ts#L703-L721) |
| PL-02 | Implemented and integration verified | Use Wrangler test-harness service/DO bindings. Remove hand-written HTTP test dispatch and gateway-owned Miniflare setup; retain real transport cases and the existing research canary’s explicit dependency. | [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/blob/56459a561b7b133a9152b993336e1e5470b1d290/fixtures/create-test-harness-example/tests/vitest.test.ts#L11-L69) |
| PL-03 | Implemented; live CDP check blocked by local prerequisites | Ordinary read-only Browser Run QA connects from Node over CDP. Only target-access QA deploys the Worker fixture. The available Mac lacks the required native `cf` CLI/account setup; no replacement harness was added. | [microsoft/playwright](https://github.com/microsoft/playwright/blob/07c7069cdbb1f5c7331d3f4d2abd864dcfde745a/tests/library/chromium/connect-over-cdp.spec.ts#L423-L454) |
| PL-04 | Implemented and browser verified | Playwright owns webServer, browser, context and page lifecycle for all eight browser suites and native UI smoke; all 45 cases pass on the owner's Mac. | [microsoft/playwright](https://github.com/microsoft/playwright/blob/07c7069cdbb1f5c7331d3f4d2abd864dcfde745a/packages/web/playwright.config.ts#L24-L53) |
| AP-02 | Implemented | Delete unused merged-status/job helpers; active authoritative run projections remain. | [cloudflare/agents](https://github.com/cloudflare/agents/blob/5c33d89791d6a00c6ea64cf7790fa753e3e5cbfd/packages/agents/src/tests/capabilities/lifecycle.ts#L932-L981) |
| DOC-01 | Implemented | Current docs and diagrams describe the shipped backend and native lifecycle. Historical migration evidence stays explicitly dated. | [cloudflare/agents](https://github.com/cloudflare/agents/blob/5c33d89791d6a00c6ea64cf7790fa753e3e5cbfd/examples/next/lifecycle/src/index.ts#L83-L132) |
| AP-01 | Implemented | Remove the raw application API-key vault, version collection, save/revoke actions and saved-key UI. Native Cloudflare bindings and rotation/audience proofs remain. | [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/blob/56459a561b7b133a9152b993336e1e5470b1d290/fixtures/secrets-store/src/index.ts#L11-L12) |
| PL-05 | Implemented and typechecked | Generate only binding declarations and share one pinned official Workers runtime type package; no compatibility shim or compiler weakening. | [cloudflare/agents](https://github.com/cloudflare/agents/blob/5c33d89791d6a00c6ea64cf7790fa753e3e5cbfd/examples/next/harnesses/opencode/package.json#L8-L29) |
| PL-06 | Implemented | Edit native Markdown directly. Delete the Go prompt generator/tests and 39 duplicate template mirrors. Preserve canonical upstream imports, checksums and historical provenance. | [anomalyco/opencode](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/test/config/agent.test.ts#L703-L721) |
| EX-02 | Implemented and runtime verified | Use installed Computer 0.8.0 createToolBindings for exactly seven memory tools; no runtime dependency upgrade. | [cloudflare/computer](https://github.com/cloudflare/computer/blob/9f70253dad2faef23739633e6760d1ce81f9f7dd/packages/computer/src/modules/tools.test.ts#L49-L135) |
| PL-09 | Retained: migration gate not met | Production still binds the legacy toolbox. Removing its gateway would break the current installation; no automatic backend switch. | [Memrov/PentCloud-tools](https://github.com/Memrov/PentCloud-tools/blob/d62c15449911c66258ecdb32c2e4f66c66d62cbd/packages/runtime/src/worker.mjs#L27-L167) |
| AP-10 | Retained: migration gate not met | Development still has one target/run using AgentMail. Keep the provider until the address and retained-reference migration is complete. | [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/blob/56459a561b7b133a9152b993336e1e5470b1d290/packages/vite-plugin-cloudflare/playground/email-worker/src/index.ts#L35-L38) |
| EX-01 | Retained: fails simplification gate | Native OpenCode file content is model-facing. Preserving text-only model input would require a new policy adapter plus UI/evidence changes, with no demonstrated net deletion. | [anomalyco/opencode](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/server/test/media.test.ts#L39-L174) |

## Live migration evidence

Read-only native Durable Object SQL queries examined the `global` coordinator in the known production and development installations. The queries returned counts only and reported zero rows written.

| Count | Production | Development |
| --- | ---: | ---: |
| `onboarding:value:*` raw secret records | 0 | 0 |
| Run `apiAccess`, setup `apiCredential`, or saved-default API references | 0 | 0 |
| Target/run AgentMail provider references | 0 | 1 |

Worker binding inventory independently confirmed production's legacy `TOOLBOX` service and development's `TOOL_PACKS` service. These observations permit retiring the old credential execution path in the known installations; they do not justify removing the legacy toolbox or AgentMail. Unknown external installations must finish their own credential migration before adopting this release. The remaining `run.apiAccess` reader rejects a legacy active run explicitly instead of silently sending an unauthenticated request. Metadata-only historical import/export remains available.

## Native ownership and preserved behavior

Cloudflare owns secret values, Durable Object/Agent lifecycle, test-harness service bindings and Browser Run execution. OpenCode owns native role loading and session/model behavior. Playwright owns local browser fixture lifecycle. No new production service, runtime dependency upgrade, storage system or compatibility framework was introduced.

The existing admission limit, attempt authority, target audience and header policy, secret fingerprints, uncertain-remote-outcome fencing, accepted-versus-published result distinction, evidence custody, readonly history and interruption recovery remain application responsibilities. The tool-binding change keeps the same seven memory tools and reaches the same role/schema/publication-gated callback. Malformed arguments and unexported file tools are rejected by the native module in real Workerd tests.

Computer remains pinned at 0.8.0 and OpenCode at 2.2.6. Their existing experimental surfaces are not promoted to stable by this consolidation. The existing Miniflare pin moves to the root manifest because the live upstream/proxy canary still imports it; its custom egress boundary is retained. The only new development dependency is the official `@cloudflare/workers-types` 5.20261108.1 baseline. `DOM.Iterable` is a standard TypeScript library, not a custom runtime declaration. Wrangler continues generating each deployment's own bindings with `--include-runtime=false`.

The EX-01 stop is grounded in OpenCode 2.2.6: [tool file content](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/tool.ts) passes through [tool-result model conversion](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/to-llm-message.ts). It has no view-only marker. The bounded metadata carrier therefore stays.

## Validation

| Check | Observed result |
| --- | --- |
| Unit suite | Refreshed on resume: 70 files, 442 tests passed |
| Native Worker router/API suite | Refreshed on resume: 8 files, 48 tests passed |
| Complete real Workerd attempt suite | Passed, including native JavaScript bindings, malformed arguments, file-export denial, recovery, cancellation, evidence, cold history and purge fences |
| Gateway native binding suite | Nine cases passed |
| Native stream/reset replay focused checks | Passed |
| Native Markdown/settings | Original 16-test gate passed; resumed canonical-role suite passes 15 cases, including eight completion/language/methodology guards retained from the retired generator |
| Preserved Go import/contracts | Passed with official checksum-verified Go 1.26.5 |
| Prompt provenance | All 39 canonical imports, import manifest and relocated adaptation record remain byte-identical to baseline |
| QA authorization/cleanup/redaction | 11 tests passed |
| Browser discovery and fixture server | 45 cases collected; production bundle/CSP and incremental SSE/disconnect/replay verified over HTTP |
| Actual Chromium execution | All 45 tests passed on the owner's Mac in 1.8 minutes. Desktop/mobile, incremental streaming, production CSP, setup and recovery assertions passed. The earlier cloud executor socket `EPERM` was an environment limitation. |
| Shared Worker types | Binding regeneration passed; all three workspace typechecks passed again on resume |
| Coordinator/material/lifecycle integration | Full coordinator RPC suite, 8 material modes, 15 lifecycle scenarios and 6 evidence groups passed |
| Full application build and deployment package | Native Vite production build, Worker output/source-map checks and Wrangler `--dry-run --containers-rollout=none` passed; no deployment performed |
| Live Browser Run CDP | Not started: required native `cf` CLI/account setup unavailable in the known Mac tooling. No sessions, Access policies/tokens or account leases were created; nothing outstanding to clean up |
| Independent code review | No blockers found in production changes and the complete gateway/coordinator/material/evidence/lifecycle transport-test conversion. All eight browser suites compared: 351 assertion call sites before, 352 after; HTTP fixtures and incremental SSE semantics preserved |
| CI and deployment | Public GitHub upload blocked by automatic approval review on a regenerated architecture diagram. No branch publication, CI run, merge or production deployment is claimed. |

The final reviewed source diff removes **1,178 authored code/test lines net**,
**48,699 repeated generated runtime-declaration lines**, and **4,419 duplicate
template lines**. The latter two categories are repository maintenance savings,
not production runtime code reduction. Renames and the unchanged historical
provenance record are not counted as deletion. Documentation and configuration
changes are excluded from these three categories.

## Resumed review

The implementation was recovered from local commit `a6b8bec` without recreating
the earlier changes. Independent review confirmed all 39 canonical PentAGI
imports and their manifest remain byte-identical, as does the relocated
historical adaptation record. Follow-up changes explain the ordinary Node/CDP
and Worker-only target-access QA paths separately, document the API-key vault
pre-upgrade inventory and migration gate, and retain the eight roles' essential
completion/language/methodology checks in the existing Markdown test suite.
The native router fixtures now verify that obsolete credential save/revoke
requests remain authenticated, reject before forwarding, and never echo values.

All eight regenerated light/dark PNG diagrams were inspected alongside their
D2/SVG sources. Their EXIF metadata contained only the D2 renderer and version;
the SVGs contain no scripts or external references. The final continuation
removed those 57 metadata bytes from each PNG and verified that decoded pixel
bytes are unchanged. This does not replace the required publication approval:
automatic approval review denied uploading the diagrams to the public
repository because it requires explicit authorization for that public
disclosure. The branch remains unpublished. The implementation bundle was
instead copied privately to the owner's Mac for local validation, with SHA-256
and Git bundle verification before use.

## Final continuation verification

A fresh complete `npm run verify:full` finished with exit code 0 using Node
26.12.1 and Go 1.26.5. It passed 442 unit tests, 48 Worker runtime tests, two
customer tests, 74 Node checks across the scripted groups, the Go checks, and
the complete Coordinator/material/evidence/attempt/question-recovery suites.
The production Vite bundle, source-map checks, and Wrangler deployment dry runs
passed. An earlier run stopped at a stale test expecting the removed credential
save route to succeed; the corrected regression verifies authenticated
rejection before forwarding and the complete suite now passes.

The Mac's existing browser log was independently checked against its Playwright
completion state: 45 cases passed and no failed test IDs remained. Git history
places that run at `a6b8bec`; all browser source, fixtures, configuration and
dependency inputs are unchanged through `0a981a3`. Its log SHA-256 is
`21ec5c4e8a224c5e909378add43ddb4a433ae0192343bc159dd6f37ce02e1ccb`.
The redundant continuation checkout and downloads were removed without touching
the validated checkout, toolchain or evidence.

A fresh read-only production Coordinator query returned the same 210 records,
zero legacy raw secret records/references, and zero active receipts, pending
publications, input preparations, purge intents or owned projects; it wrote
zero rows. Production still serves the previously deployed runtime. The native
Workers Builds connection already uses the current app deploy command and
retains the optional legacy prompt-build step, so no connection change is
needed for this release. Recheck live migration and admission state immediately
before a future promotion.

The live Node/CDP journey remains unverified because the native `cf` CLI/account
connection is unavailable on the Mac. No live browser session or temporary
account/Access credential was created in this continuation. Public branch
publication, hosted CI, merge and deployment remain pending explicit disclosure
authorization and their applicable release gates.
