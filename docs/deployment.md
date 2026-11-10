# Install and deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Memrov/PentCloud)

## Customer installation

Before starting, enable Workers Paid, Containers and a workers.dev subdomain in
your Cloudflare account. Complete native Zero Trust setup; its free Access plan
is sufficient within its limits. Keep your OpenCode key ready. Review
[requirements and costs](requirements.md).

1. **Deploy to Cloudflare:** choose your account, repository name and Worker name.
   Use the repository root and accept the detected `npm run build` and
   `npm run deploy` commands. Turn **Enable Preview builds** off and leave
   **Protect with Cloudflare Access** off; the wizard creates the compatible
   hostname policy. Cloudflare copies the public repository into your
   GitHub/GitLab account and runs Workers Builds. No local CLI or Docker install
   is needed. The first build prepares the Computer image and all eleven
   smaller tool images.
2. **Cloudflare:** open the deployed URL. In the wizard, enter your owner email
   and create the scoped first-setup token using its Cloudflare link. Account ID
   and Worker name are prefilled when supplied by Builds; otherwise copy them
   from your Cloudflare account. Optionally enter the OpenCode key and Go/Console
   route here to save everything with the same temporary token. Click **Protect
   this installation**, then **Sign in to continue**.
3. **Workspace:** click **Prepare workspace**. The native Artifacts binding
   creates one connection-check repository only when the namespace is empty,
   revokes unused setup Git tokens, and preserves existing repositories.
4. **Models:** a key supplied in step 2 is already configured. Otherwise save one
   using a temporary Workers Scripts Edit token, or add it in Cloudflare and
   click **Check again**. Revoke setup tokens when finished. Click **Open PentCloud**.

A configured key does not prove billing or inference access. Use the existing
explicit model test when creating the first project. Setup runs no model or
assessment. Existing configured installations open the application directly;
`/setup` remains available.

## What Cloudflare manages

The root `wrangler.jsonc` is the new-customer deployment. It deploys **one Worker**
containing the app, a private tool gateway through native
[loopback bindings](https://developers.cloudflare.com/workers/runtime-apis/context/#exports),
Durable Objects, Artifacts, Browser Run, Workers AI, Worker Loader and
all eleven smaller tool Containers, plus one Computer Container per active attempt.
The Computer pilot gives each role a Linux shell with direct Internet access;
the model receives the pinned target scope and is responsible for following it.
The container backend is experimental in the pinned Cloudflare Computer release.
Shell writes through its mounted Workspace also bypass the role checks on
`computer_write` and `computer_edit`; accepted results still pass Coordinator
validation. New installs do not use Kali. Existing separate-Worker and legacy
installations retain their private configurations.

[Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
do not deploy multiple Workers together, and subdirectory templates cannot import
files outside that subdirectory. Deploying the whole repository as one Worker
avoids both restrictions. Worker names selected by Builds determine the Artifacts
namespace, keeping separate installations isolated. Coordinator validates accepted
results and uses native Agents Lifecycle to recover persisted Attempt results.
No results Workflow or Artifacts push subscription is needed. The source retains
an explicit empty event-trigger list so native Wrangler reconciliation can remove
the former result subscription; unrelated existing triggers must be preserved.

The build fetches a checksum-pinned revision of
[PentCloud-tools](https://github.com/Memrov/PentCloud-tools) and uses its existing
verified image preparation scripts in a pinned Docker build stage. Build-only
Go/Python/bsdtar tooling is excluded from the final images. Native Wrangler and
[Workers Builds](https://developers.cloudflare.com/containers/guides/deploy/#deploy-with-workers-builds)
build and publish the images into the customer's Cloudflare account. There is no
custom image registry, installer state machine or setup agent. Node and Go are
pinned; no account credentials or account logs are sent to GitHub Actions.

## Access and credentials

The first-setup token needs **Workers Scripts Edit**, **Access Apps and Policies
Edit**, and **Access Organizations Read**, scoped to the customer's account.
Before making any change, the Worker verifies that its exact current version
belongs to the selected account/script. It creates an owner-email-only
**hostname-based** Access app and atomically saves the issuer, audience and any
supplied model key using the native
[bulk-secret API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/).
The token is never persisted. Setup closes as soon as either Access setting exists.
Existing unrelated Access policies are never overwritten.

Hostname Access is deliberate: Cloudflare currently documents that
[worker-level Access does not support WebSockets](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-one-worker).
Keep protection on the hostname users will visit. Adding a custom domain later
also requires protecting that hostname in the same Access application. Keep the
existing `workers.dev` hostname protected there too. For multi-hostname apps,
Cloudflare’s native [Eager redirect cookie setting](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
can be turned off under Access application > Advanced settings > Cookie settings.
Access then sets cookies when each hostname is visited, so an unresolved new
custom domain does not interrupt sign-in through the existing hostname. Custom
Domains provision DNS and certificates natively; no DNS polling or repair code is
needed in the wizard.

Runtime services use native bindings, without a separate API token per service.
Model keys use Worker Secrets. See [authentication](operations/authentication.md),
[Artifacts capabilities](https://developers.cloudflare.com/artifacts/api/workers-binding/)
and [account-token template links](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).

## Validation and updates

Source checks: `npm ci`, `npm run verify:full`, and `npm run test:browser`, using
Node 26.12.1 and Go 1.26.5. Checks cover the complete customer Worker, native
loopback gateway, authenticated/public bootstrap boundaries, secret handling,
installation name isolation, desktop/mobile UI and verified source maps.
The build uses the pinned Cloudflare Vite plugin to emit client assets and the
Worker, then checks the compiled source maps. `npm run deploy` uses
`apps/control-plane/dist-customer/worker/wrangler.json`, including the customer bindings
and native Container definitions. For a local packaging check after `npm run build`, run:

```sh
npx wrangler deploy --config apps/control-plane/dist-customer/worker/wrangler.json --dry-run --containers-rollout=none
```

Source-only dry runs skip Container rollout; the actual deploy builds/publishes
images through Wrangler. A dry run alone does not prove image provisioning.

Earlier hosted deployment evidence is retained in the
[dated legacy migration notes](operations/legacy-migrations-2026-11-08.md#historical-deployment-validation).
It includes the retired result Workflow and does not establish that the current
source revision has passed live deployment, human login, paid inference or a
complete assessment. Validate those separately when promoting a deployment.

Use the copied repository's Workers Builds connection for updates. Preserve its
configuration and secrets. Existing installations keep using their original
build/deploy commands and private configuration; do not replace them with the new
customer template. Follow the [legacy upgrade instructions](operations/legacy-migrations-2026-11-08.md)
when changing an existing install. See [Cloudflare setup](cloudflare-setup.md) and
[operations](operations.md).
