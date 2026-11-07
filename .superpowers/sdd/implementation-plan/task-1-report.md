# Task 1 — retire executable Go/Wasm prompt compatibility

Base: `f32217f925917d633cb077dc30780209355d37e4`; branch: `codex/native-collapse`.
Scope: approved first reduction row only. No deployment, dependency/version changes, tool aliases, auth changes or changes to serial admission, remote outcome receipts, cancellation/drain or accepted-evidence publication.

## Upstream evidence consulted before implementation

Read current official OpenCode embedded SDK, Workerd and agents documentation on November 6, 2026:

- https://dev.opencode.ai/v2/docs/build/sdk/ (redirects to https://dev.opencode.ai/docs/build/sdk/): embedded host and ordinary native user prompts.
- https://dev.opencode.ai/v2/docs/build/sdk/cloudflare/ (redirects to https://dev.opencode.ai/docs/build/sdk/cloudflare/): injected Durable Object SQLite and Workerd host lifecycle.
- https://dev.opencode.ai/v2/docs/agents/ (redirects to https://dev.opencode.ai/docs/agents/): agent system instructions, Markdown formats and named profiles.
- https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/README.md and its raw source https://raw.githubusercontent.com/cloudflare/agents/main/examples/next/harnesses/opencode/README.md: current Cloudflare example explicitly marks the harness/provider entrypoints experimental.
- Actual example implementation https://raw.githubusercontent.com/cloudflare/agents/main/examples/next/harnesses/opencode/src/server.ts: `OpenCodeWorkerd.create`, DO-owned host, injected plugins and `default_agent`; no executable prompt-template runtime is required.
- Actual installed-version upstream source https://raw.githubusercontent.com/anomalyco/opencode/v2.2.5/packages/sdk/src/workerd.ts: native host and session API, same interface as ordinary embedded OpenCode.
- Installed `node_modules/@opencode/sdk/package.json` confirms 2.2.5; `node_modules/@opencode/schema/dist/agent.d.ts:86` declares optional agent `system`. The existing application already sets native `agents[profile].system = state.prompt`.

Decision: keep the shipped native Markdown/system-string path and pinned source digest, rather than adding an experimental harness or upgrading dependencies. Runtime replacement claims are tied to installed 2.2.5 APIs, not assumed later APIs.

## Changed boundary and retained history

- New settings accept only explicit `promptFormat: "markdown"`. Missing or `pentagi-template` formats produce a role-specific migration error classified by Coordinator as HTTP-client validation, without writing settings or advancing settings CAS.
- `renderLaunch` remains the application entry point. It requires explicit Markdown and delegates to the existing Markdown launcher. Task JSON, source-only SHA-256, role contract, context, enabled tools, escaping and literal `{{...}}` Markdown remain unchanged.
- Fresh/promoted model attempts validate the format before `blockConcurrencyWhile`. Workerd testing exposed that rejecting inside the gate resets the DO despite a caller catch; moving this ordinary validation outside the gate avoids resetting an existing host.
- Matching already-stored attempts take the existing immutable replay path and retain their exact stored input, prompt text, prompt digest and fingerprint. The compatibility probe verifies both missing-format and explicit-template historical states byte-for-byte at the JSON storage boundary. It then verifies the same input cannot create a fresh attempt and issues no model request.
- Read APIs and UI parsers still accept and preserve historical missing/legacy formats, revision IDs, saved bytes and upstream digests. No historical settings migration/rewrite was added. New run creation rejects legacy current defaults before creating project/creation state.
- Settings UI removes the executable format selector. It shows the saved legacy source and a migration notice; the existing explicit role-reset action installs managed Markdown. Reset remains available even if old source text happens to match default text but its format does not. Browser fixture expectations were updated for this explicit migration flow.
- Existing legacy attempts can replay their stored rendered prompt. A future role/job that would require fresh legacy rendering fails clearly. This change is not a claim that an active multi-job legacy run can complete all future dispatches after rollout; drain such runs before any future production deployment. No deployment was performed or authorized.

## Removed and retained artifacts

Removed the private prompt Worker, loader purpose/budget kind/tail support, Go/Wasm bridge, renderer binaries on disk, matching Go runtime copies/checksums/type declarations/license, Go launch package, production Go renderer, renderer fixture/oracle/goldens, obsolete `render-golden` import step/helper, renderer build/test scripts and build/verify hooks. Removed redundant Coordinator template-render validation and raw-template catalog imports/helper that otherwise left seven `.tmpl` runtime modules in the dry-run upload.

Kept original `upstream/pentagi` templates/manifest, `internal/prompts/assets` source copies consumed by the specialist generator and provenance tests, imported tool contracts and specialist generation. Generator tests now independently parse/execute each pinned original with nine lines of standard Go `text/template` in the existing paragraph-accounting test; there is no new runtime renderer package/helper. The generator's README explains build-time provenance and explicit Markdown execution. No dependency was unique to the retired renderer, so no dependency was removed.

## Actual verification

All shell commands used this PATH prefix:

```
/Users/darian/.npm/_npx/5027c226c637930f/node_modules/node/bin:/Users/darian/Documents/Codex/2026-11-06/check-to-see-if-the-last/.task-tools/go1.26.5/go/bin:$PATH
```

1. **Expected red observed before production edits:** `npm exec --workspace @pentagi-artifacts/control-plane -- vitest run test/managed-specialist-settings.test.ts` — exit 1, 2 expected failures: absent and `pentagi-template` settings resolved instead of rejecting; other 2 tests passed.
2. **Final focused settings/launch/history/preparation/UI/model checks:** `npm exec --workspace @pentagi-artifacts/control-plane -- vitest run test/managed-specialist-settings.test.ts test/native-markdown-launch.test.ts test/ui-api.test.ts test/settings-ui-model.test.ts test/settings-components.test.ts test/preparation.test.ts test/native-history.test.ts test/native-runtime-limits.test.ts` — exit 0, **8 files / 38 tests passed**. Earlier invocation also named nonexistent `native-roles.test.ts`; no test was collected from it. The final invocation above omits it.
3. **Role/authority/digest/admission checks:** `npm exec --workspace @pentagi-artifacts/control-plane -- vitest run test/native-domain.test.ts test/native-attempt-tools.test.ts test/material-input.test.ts test/native-contract-drift.test.ts` — exit 0, **4 files / 23 tests passed**.
4. `npm run typecheck --workspace @pentagi-artifacts/control-plane` — exit 0. First run found an `exactOptionalPropertyTypes` error in the new test's explicit `undefined` property; corrected the test to omit the optional property, then re-ran successfully twice.
5. `go run ./scripts/native-specialists` and `go run ./scripts/native-specialists -check` — exit 0, **8 roles / 350 source paragraphs verified**. Only generated README changed; role Markdown/provenance content did not change.
6. `go test ./scripts/native-specialists ./internal/contracts -count=1` — exit 0, both packages passed; final rerun passed.
7. **Real Workerd focused probes:** executed `node --input-type=module` with `withNativeTestHarness` from `scripts/lib/native-test-harness.mjs`, first with `test/native-attempt-probe/wrangler.jsonc`, then `test/native-coordinator-probe/wrangler.jsonc`. Requested `/prompt-compatibility` and `/sdk-startup` on the attempt fixture; requested `/invalid-settings?kind=template`, `/invalid-settings?kind=missing-format` and `/snapshot` on Coordinator. All assertions passed: immutable legacy state replay for both formats; fresh rejection before persistence/inference; native Markdown startup reaches `model.request.ready`, creates two history messages and stores no model binding secret; both Coordinator errors carry `400: primary prompt template ... retired ... Markdown`, and stored CAS remains 0 with only the default current/history records. The initial Workerd run exposed the gate-reset issue described above; the final run passed after that correction. The permanent assertions are in the existing attempt `check.py` and Coordinator `run.mjs` fixtures.
8. `npm run build` — exit 0 **twice**, including customer pinned-source preparation, Vite build, both native Wrangler dry-run uploads, byte-for-byte runtime upload comparison and production source-map proof. Final build has **11 runtime modules**, no `.tmpl`, Go/Wasm renderer or Go runtime module; map proof: 16,346,510 raw / 4,243,422 gzip bytes. Existing Vite >500 kB chunk warning and Wrangler update notice remain. Customer build's generated `wrangler.jsonc` vars/formatting were restored to HEAD after verification; no deployment config changes are included.
9. `bash -n scripts/import-pentagi.sh scripts/native-cloudflare-verify.sh`, `node --check scripts/test-native-ui.mjs`, `node --check scripts/build-customer.mjs`, `git diff --check` — exit 0.

### Browser limitation recorded exactly

`node scripts/test-native-ui.mjs` could not launch because pinned Playwright Chromium headless shell is absent at `/Users/darian/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`.

Re-ran the unchanged runner using a process-local `chromium.launch` override to installed `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (no committed wrapper, dependency or runner change). Browser started but broad smoke failed **before settings** at `scripts/test-native-ui.mjs:179`: expected `Native session transcript is ready.`; actual page was onboarding with `Unexpected token 'u', "unhandled fixture" is not valid JSON`. Therefore the updated settings browser migration assertions were **not reached**. Root owns final browser/integration diagnosis and whole-branch suite. No claim is made that this smoke passed.

## Self-review

Only Task 1 files are changed. No full suite or production calls were run. Historic parsing and source identities remain intact; executable legacy inputs are blocked deliberately rather than rendered as Markdown. Original-template runtime imports, renderer references/build commands and artifact modules have been removed. Whole-branch verification and independent review remain with the root agent.
