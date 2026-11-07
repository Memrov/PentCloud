# Installation CI

The Installation test workflow invokes the public customer CLI in the separate
testing account. It uses a per-run fresh hostname and retained customer.heflare.app
installation. The prior install.heflare.app fixture remains separate. It does not install a Kali image, Kali gateway or Kali MCP secret. Production installations are not adopted.

## What runs

A trusted push to main/the validation branch, or a manual workflow dispatch, imports the exact source commit into native Cloudflare Artifacts and checks it out there. All application installation commands then execute from that exact imported commit. This is an integration test driven by GitHub Actions; it does not claim to test a Workers Builds connection.

The public CLI builds or reuses the eleven package images from the pinned PentCloud-tools source revision. Each complete tool lock must match the installed npm SDK. Upstream archive/binary checksums and base-image pins are retained. The resulting immutable image digest and recipe identity are checkpointed in the private Artifacts ledger and verified before reuse. The identity includes source commit, pack, complete lock, platform, Go and regctl versions. A changed digest under the same recorded build identity requires investigation.

The job deploys the private ToolPackGateway and the app with its own Durable Objects, Loader, Browser Run, Workers AI, Artifacts namespace, results Workflow and event filter. The custom domain stays behind the installation's native Access application. Legacy Kali installations retain their pinned backend; this dedicated profile works with TOOL_PACKS and no TOOLBOX binding.

The service checks cover protected API access, Durable Objects, Artifacts Git write/native binding read, an event reaching the results Workflow, Dynamic Worker execution, document conversion, Browser Run, and readiness/retirement of all eleven packages. A bounded HTTP package request uses only the testing hostname. No assessment or OpenCode inference starts automatically. This does not establish every scanner profile's coverage or acceptance of a real assessment result.

Optional Email Service onboarding/delivery and the owner's interactive sign-in flow need separate verification; they are not configured by this CI profile.

## Secrets and privacy

The GitHub environment installation-test contains:

- CLOUDFLARE_API_TOKEN: dedicated account/zone-scoped deployment authority, without token-management permissions.
- PENTCLOUD_INSTALL_CONFIG: private account/zone/team/owner settings.

Only explicitly allowed trusted branches can receive these environment secrets. Ordinary pull-request CI has no deployment credentials. API authority is supplied headlessly; no Cloudflare CLI login/session cache is copied to GitHub.

Account logs, authentication sessions, provider response bodies, traces, private state and credential files are not uploaded as Actions artifacts. Deployment subprocess output is captured privately. Failure summaries contain controlled stages/codes rather than arbitrary exception/provider bodies. Account IDs, team and configured emails are additionally masked. The action emits bounded test results, public source/image identities and test-step status.

Ownership manifests and image provenance remain in a private native Artifacts state repository, separate from application source and runtime evidence. State is checkpointed before mutations and after receipts, so a runner failure cannot silently discard a resource claim. Do not delete the state repository or manually adopt conflicting resource names.

Temporary exact-token Access policies/service tokens and the disposable service probe have task-specific ownership and cleanup. The probe uses a unique hostname under heflare.app, so an existing workers.dev Access wildcard cannot intercept it. It accepts only a random bearer capability and expires after one hour. Its custom domain is removed before its Worker. An always cleanup step also reconciles interrupted jobs from a local nonsecret ownership journal. A hard runner loss still requires inspection of the recorded task-owned resources; never sweep unrelated policies, Workers or Containers.

The fresh install is verified and then deleted through the public CLI only after
its empty-data and ownership checks. Its setup audit receipts and immutable images
remain. The retained installation holds a synthetic saved target and evidence
repository. Before and after upgrade, CI compares their exact records, repository
ID/commit/bytes, provider IDs and DO namespaces, plus runtime commit/version IDs
against the private release receipt. The first baseline honestly records a
same-source upgrade; later commits prove baseline-to-candidate shipping. Runtime
checks retire their owned package instances.

The **Customer install and upgrade** job is one of the exact-commit checks required
by the managed production deployment gate. Cloudflare Builds remains the production
deployer; see [production shipping](operations/production-shipping.md).

## C3 / create-cloudflare

Reviewed create-cloudflare 2.74.9 and its help/source. C3 accepts remote templates pinned to a branch, tag or commit and runs a template's deployment script. It can therefore become a user-facing entry point to a prepared PentCloud installation template.

C3 is a scaffolding/deployment wrapper. Its current deployment code explicitly leaves placeholder resource bindings for the template author to prepare. It does not establish upstream GitHub-to-Artifacts synchronization or automatically configure this complete installation from the existing monorepo. No additional C3 scaffold or second definition of the stack is added to this integration test.

References: [C3 options](https://developers.cloudflare.com/pages/get-started/c3/#cli-arguments), [C3 deployment source](https://github.com/cloudflare/workers-sdk/blob/main/packages/create-cloudflare/src/deploy.ts).

## Official Wrangler Action

Cloudflare documents `cloudflare/wrangler-action` for GitHub deployments. The
reviewed v4.1.3 action captures raw stdout/stderr as action outputs even in quiet
mode, and failure paths can print provider stderr. This installer instead invokes
the same pinned Wrangler CLI through its private subprocess adapter. No action
output contains account logs, and no second production deployer is added. The
repository continues to require SHA-pinned, explicitly allowed actions.

References: [Cloudflare GitHub Actions guidance](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
[pinned action source](https://github.com/cloudflare/wrangler-action/tree/953926a2e2182532811c01a25e53647d93bf07c0).

## Cloudflare CI and self-healing

Cloudflare's @cloudflare/ci package and its self-healing example are useful native pipeline references. The example catches check failures, invokes an application-owned Healing Agent, reruns verification and pushes a ci-autofix branch; the original failing run remains failed. The Healing Agent is example/application code with an AI binding, not an automatically enabled feature of installing the core package.

The example includes failed command output in the repair prompt. It must be adapted to this project's privacy rule before activation. Only sanitized source-check diagnostics should be eligible; account authorization, billing, domain ownership and provider bodies should not go to a repair model. Keep deployment authority out of the repair sandbox, protect workflows/security settings from repair edits, and require review before promotion.

Self-healing is not enabled by this change. It needs an explicit repair/publishing integration for our source provider and review flow, plus bounded model use. Artifacts fix branches and GitHub pull requests are separate publication surfaces.

References: [Cloudflare CI](https://github.com/cloudflare/ci), [self-healing example](https://github.com/cloudflare/ci/tree/main/examples/self-healing).

