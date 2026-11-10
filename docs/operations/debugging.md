# Troubleshooting

Start with the selected Cloudflare account, deployed Worker version and native
Builds configuration. The previous CLI installer and its doctor command have
been removed; use the in-app setup wizard at `/setup` for first-run configuration.

For platform failures, check current [Cloudflare documentation](https://developers.cloudflare.com/),
[service status](https://www.cloudflarestatus.com/),
[changelog](https://developers.cloudflare.com/changelog/) and your pinned
CLI/package versions. `cf` and Wrangler have separate sign-in sessions.

| Symptom | Where to look first |
| --- | --- |
| CLI authorization or permission failure | `cf auth whoami`, granted scopes, selected account and [deployment permissions](../deployment.md). `cf` and Wrangler logins are separate; the deployment needs authorized account access. Distinguish API permission denial from missing product entitlement. |
| Setup, image preparation or resource creation fails | Native Builds deployment status, Container image-preparation state and [deployment guidance](../deployment.md). Inspect the selected account before retrying a mutation. |
| Worker deploy rejects startup (10021) | Native deployment log and `wrangler check startup` against the verified prebuilt bundle. Use a current Cloudflare CLI whose profiler supports the configured compatibility date; local profile time is not the production measurement. Embedded OpenCode engine loading is deferred to authorized session creation. Preserve package versions and behavior when reducing global initialization. |
| Build or deployment fails | Native Builds logs for the exact source commit; selected installation's app/gateway Wrangler configs, lockfile and tool versions. Check the deployed Worker version and source maps before attributing an error to current source. |
| App sign-in, blank page or loading failure | Browser console/Network, Access application domain/audience/email policy, app Worker Logs and Issues. Separate Cloudflare sign-in, application access, model access and target API authentication; [Worker routes](../../apps/control-plane/src/native/worker.ts). |
| Target verification, model/API tests or analysis gate fails | [Onboarding behavior](onboarding.md), [`target-check.ts`](../../apps/control-plane/src/native/target-check.ts), [`onboarding.ts`](../../apps/control-plane/src/native/onboarding.ts), [`opencode-models.ts`](../../apps/control-plane/src/native/opencode-models.ts). Check target/setup revisions and proof/key versions. Model tests may consume credits; request them deliberately. |
| Scope import, required headers or login fails | [Target access](onboarding.md#bounty-scope-and-target-login), catalog refresh/checksum, concrete origin/base path and applicable exclusions. Check `PENTCLOUD_TARGET_*` app bindings without reading values; verify login field selectors and same-target URLs. Native Browser Run guardrails and [`browser-interception.ts`](../../apps/control-plane/src/native/browser-interception.ts) cover different layers; Playwright route handlers alone skip redirect hops. |
| Discovery waits or scanner execution fails | Recorded queue/run/job state, app Worker Logs, native tool-pack/Container logs and [`attempt.ts`](../../apps/control-plane/src/native/attempt.ts) startup markers. On legacy installations also inspect gateway logs, [`toolbox-lifecycle.ts`](../../apps/control-plane/src/native/toolbox-lifecycle.ts) and [legacy toolbox operations](../../infra/cloudflare-kali/README.md). Do not poll legacy Kali status: it counts as activity. |
| Runtime reset, stuck work or uncertain external outcome | Settings → Runtime status, authenticated `GET /v1/runtime-diagnostics`, job receipts and [scanner recovery](../operations.md#scanner-cancellation-and-recovery). Use recorded recovery controls and exact-operation evidence, not blind retries. |
| Missing files, Git results, export or cleanup failure | The run's accepted commit and owned Artifacts repository, [`material-store.ts`](../../apps/control-plane/src/native/material-store.ts), [`coordinator.ts`](../../apps/control-plane/src/native/coordinator.ts), [operations](../operations.md) and [deployment lifecycle](../deployment.md). |
| Source attachment/import or agent source reads fail | [Source context](source-context.md), [`source-context.ts`](../../apps/control-plane/src/native/source-context.ts), frozen run pins and the import request/destination. A pending import or private GitHub connection is not proof of ready source. Never repeat an unknown import under a new identity to hide its outcome. |


## Recovery and safe diagnostics

Use the failure's stage, UTC time, HTTP/error code, run/job ID and deployed
version to locate the corresponding Worker Logs, Issues, Access log or Container
preparation record. Keep credentials, private targets and response bodies out
of public support requests. A successful Build does not establish that an
already-active Durable Object has finished its configured deferred code update.

Preserve Worker identities, secrets, migration tags and unresolved runtime
operation receipts. Recreating resources or blindly repeating an uncertain
mutation can lose data or repeat a scan. Reconcile the recorded operation first.
Never print credential files, token responses or secret values.

Runtime status and `GET /v1/runtime-diagnostics` expose recorded state without
starting work. Data Studio reads of run/job/activity metadata are passive;
credential values and internal Cloudflare tables are not needed for diagnosis.
A job marked running is not by itself evidence of progress.

For missing evidence, inspect the verified checkpoint manifest, collection notes,
original tool receipt and run/attempt ownership. For legacy file-bridge output,
also check the expected Kali generation. A missing file or push reply does not
establish that a scanner never ran. See [legacy Kali evidence](kali-evidence.md).

## Discovery, chat and model setup

**Open chat** becomes available after the displayed model/API setup passes.
During discovery, preparation chat can read files, ask questions and discuss the
project; execution tools remain unavailable until admission. Check setup
revisions, dirty/conflict state and connection proofs when the button is disabled.
New runs use parallel native HTTP probes with a shared 10-second deadline.
Incomplete discovery hands off to the agent after safe drain and remains visible
as a coverage gap. Historical scanner profiles still require explicit
acknowledgement on failure; an unknown outcome still holds execution ownership.

Catalog refresh and model testing are separate. Catalog requests are anonymous;
a connection test uses the selected Cloudflare secret binding and may consume
credits. Check the sanitized catalog error, billing route, workspace permission,
allowance and credential version before testing again. A rotated key requires a
new model test and a new run; an existing pinned run cannot adopt it silently.

## Reports and findings

A missing legacy findings index is not zero findings. Check the saved target ID,
accepted reporter attempt and exact Git file references. For provenance errors,
compare the immutable input and committed result's `findings_version` with the
run's format version before retrying publication.

The reporter reads same-run conversations and operation receipts through
`pentcloud_run_work`, and uses Git/evidence readers for files. Follow pagination
through `nextOffset`; a single fragment is not complete history. Missing or
purged history must remain visible as a limitation. See [reporting](findings.md).

Use [local testing](testing.md) for reproducible checks and
[browser QA](browser-qa.md) for deployed visual review. These diagnostics do not
require a new model request, scan or storage reset.
