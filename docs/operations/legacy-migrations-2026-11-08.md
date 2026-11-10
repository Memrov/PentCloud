# Legacy installation migrations — November 8, 2026

Current new-install behavior is described in [deployment](../deployment.md) and
[architecture](../architecture.md). This note applies to retained installations
and records older validation evidence; it does not change deployed resources.

## API-key vault retirement: check before upgrading

This revision removes the application API-key vault's value-management and
historical-version lookup paths, including the old save/revoke controls. It does
not migrate or erase existing stored values. Target API authentication now uses
native Worker Secrets or Secrets Store bindings. The zero-reference inventory
in the [execution record](native-consolidation-2026-11-08.md#live-migration-evidence)
covers only the known production and development installations, not copied
customer deployments. There is no automatic credential migration in this release.

Before updating an existing installation, use read-only operator access to its
Coordinator storage to inventory **counts and nonsecret references only**:

- Raw `onboarding:value:*` records, including every stored credential version.
- Every run's `apiAccess`, setup draft's `apiCredential`, and saved target
  default's `draft.apiCredential`, including retained and interrupted work.
- The credential IDs/versions, target audiences and execution status needed to
  explain those references. Never export secret values, full storage rows or
  credential-bearing logs as migration evidence.

**Do not upgrade while any raw value or legacy reference remains unresolved.**
Keep the previous deployed revision available for its existing read/revocation
and recovery behavior while completing these steps:

1. Stop creating legacy saved keys. For future work, configure each target's API
   binding, scheme, header and original allowed audience using the
   [native secret setup](../cloudflare-setup.md#target-login-and-api-secrets).
   Enter the credential through Cloudflare's private controls; do not extract
   it from Coordinator storage into a migration report.
2. Finish or explicitly stop and reconcile old executable runs on the previous
   revision. Preserve their version-pinned credentials until their supported
   use ends. Update reusable setup/default selections for future runs; do not
   rewrite immutable run snapshots or silently redirect an old credential ID
   to a new binding. If retained work must remain resumable, keep the previous
   revision until a separately reviewed migration preserves that contract.
3. Use the previous revision's credential revocation and supported lifecycle
   cleanup after the dependent work is settled. Revocation must deny every old
   version. Preserve accepted evidence and historical records; do not delete
   run history merely to make an inventory empty. Unresolved retained references
   continue to block this upgrade.
4. Start a fresh run with the new target revision and repeat the explicit
   protected-endpoint API check. Verify its audience and that authenticated
   success differs from the anonymous response. Re-inventory the old storage
   and references before promotion and record the nonsecret result.

After upgrading, historical metadata remains readable, but an old run carrying
`apiAccess` cannot resume authenticated execution through the removed vault.
The runtime fails explicitly instead of sending an unauthenticated request.
An empty export of credential values is not evidence that no live references
remain. Native bindings and preserved Cloudflare configuration must survive
the deployment.

## Shared-Kali compatibility

New installations use eleven native tool packs. Existing shared-Kali installs
retain their private gateway, stock MCP catalog, generation-fenced file custody,
credentials and migration history. Do not switch an in-progress or retained
attempt to a different backend. Retiring that deployment path requires an
installed-customer/retained-run inventory and proven tool/evidence compatibility.
See [toolbox operations](../../infra/cloudflare-kali/README.md) and
[legacy evidence operations](kali-evidence.md).

## Existing separate-Worker Builds

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

For an opt-in Computer container pilot on an existing separate Worker, run
`node scripts/enable-computer-container.mjs` after applying its private
`PENTCLOUD_DEPLOY_CONFIG` and before the Vite build. Deploy without
`--containers-rollout=none`, which skips building and updating the container.
The helper adds only the `NativeAttempt` container and the backend selection
variable; it preserves the installation's bindings and never prints its config.

## Retired result Workflow

Result acceptance and publication use Coordinator's durable native recovery wake;
new installations do not need a result Workflow. Native Builds normalize the old
`RESULTS`/`ResultValidation` binding and matching namespace push target out of
private deployment metadata. The source config retains `triggers.events: []` so
Wrangler's native trigger reconciliation removes the old subscription. Preserve
unrelated event subscriptions and installation resource identities when upgrading.

Before upgrading an existing installation, verify native trigger reconciliation
on its test Worker and inspect the resulting subscription and deployment metadata.
Omitting an event-trigger field does not clear existing subscriptions. The former
Workflow resource may still reference its old class: verify that the native
upgrade accepts the removed export before promoting it. If the platform refuses
that upgrade, remote retirement is a deployment prerequisite; resolve it through
Cloudflare's native resource controls while retaining historical instances.
`wrangler workflows delete` also deletes its instances and must not be used as an
automatic cleanup step. This source change does not delete Workflow history.

Sources: [Artifacts push events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/),
[Workflow deletion](https://developers.cloudflare.com/workflows/reference/wrangler-commands/#workflows-delete),
and [native Wrangler trigger reconciliation](https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/triggers/deploy.ts).

## Historical deployment validation

The following record is preserved from
[commit 7857915](https://github.com/Memrov/PentCloud/blob/7857915650c25de0842ee96a62f7d0d12d49747a/docs/deployment.md#L110-L128).
It describes that earlier validation, including the subsequently retired result
Workflow. It is not evidence of live validation for the current source revision.

> The real deployment button was exercised against the PR branch in the separate
> Cloudflare Test Account, using a private disposable customer repository and
> `button.heflare.app`. Native Workers Builds completed the build and deployment.
> The hosted wizard created an owner-email Access policy, saved native Secrets,
> prepared Artifacts storage and reached the fresh Coordinator SQLite database.
> All eleven tool images passed hosted startup, SDK/image-pin validation and
> shutdown checks. Desktop and mobile hosted captures showed all three setup checks
> complete with a dummy model key. Native Artifacts push events started the results
> Workflow and completed its Coordinator validation step for a synthetic unknown
> attempt, which was correctly ignored. A second Workers Build preserved the saved
> settings. Owner sign-in through Cloudflare SSO, all three wizard steps and
> **Open PentCloud** were exercised in Chrome through the existing `workers.dev`
> hostname, reaching the empty **Your targets** screen.
>
> A real model key, paid inference and a complete assessment are separate checks.
> The dummy key, setup tokens, temporary native Access service auth and runtime
> probes were removed after validation. Owner-only Access remains. A real OpenCode
> key is required before running models on the retained test installation.
> Production remains separate and this PR is not merged.
