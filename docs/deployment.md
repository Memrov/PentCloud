# Install and deployment

PentCloud now has a small browser setup wizard at `/setup`. Open the protected
application after deploying its Cloudflare resources. Existing configured
installations open the application directly; `/setup` remains available.
The custom command-line installer and privileged installation-test pipeline have
been removed.

## Customer setup

1. **Cloudflare:** sign in through Cloudflare Access. The wizard checks that the app
   has its Durable Objects, Artifacts, Workflow, Browser Run, Workers AI, Worker
   Loader, version metadata and tool gateway bindings. Missing bindings are shown
   with a link to Cloudflare. Resource and Access provisioning remain deployment
   prerequisites; a binding check does not start or test every service.
2. **Workspace:** click **Prepare workspace**. The native Artifacts binding creates
   one initial repository if the namespace is empty, then revokes the unused Git
   token. Existing repositories satisfy this check and are preserved.
3. **Models:** enter an OpenCode key and choose Go or Console. To save from the
   wizard, create a temporary account token with **Workers Scripts Edit** using
   the provided scoped link, then enter the account ID and app Worker name.
   The server verifies that this Worker owns its current version before writing
   the key to a native Worker Secret. The setup token is used only in memory for
   that request. Revoke it afterward. Alternatively, add the secret directly in
   Cloudflare and click **Check again**. Click **Open PentCloud** when ready.

Saving a key deploys a new Worker version. Use this first-run flow on the intended
installation. A configured key is not proof of valid billing or inference access:
use the existing explicit model test when creating the first project. Setup runs
no model, assessment or container scan. It needs no setup agent or agent harness.

The implementation follows current Cloudflare documentation for
[bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/),
[Artifacts repository capabilities and token revocation](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/),
[exact Worker version lookup](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/),
[Worker Secret updates](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/), and
[scoped account-token links](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).

## Managed deployment

Use the installation's Cloudflare
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) connection
to GitHub or an [Artifacts repository](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/).
Preserve its private configuration. The checked-in Wrangler files are compilation
examples with empty Access settings, not ready-to-use customer configurations.

New installations use the eleven smaller tool packages, deployed independently
through native [Containers image management](https://developers.cloudflare.com/containers/guides/image-management/).
Do not install Kali for a new installation. Existing legacy backends remain
compatible. Application updates do not require rebuilding tool images.

Give staging its own app, Durable Objects, Artifacts namespace, Workflow and Access
policy in the test account/domain. A tool gateway used in testing must also belong
to that test installation/account. Production remains separate.
[Worker Previews](https://developers.cloudflare.com/workers/previews/resources/)
do not automatically select matching peer service Workers, and Workflows need a
dedicated test deployment.

For source verification, run `npm ci`, `npm run verify:full` and `npm run test:browser`
with Node 26.12.1 or later 26.x and Go 1.26.5. The native build verifies the prebuilt
Worker, runtime modules and source map before deployment. GitHub source checks
need no Cloudflare account credentials or account logs. Browser tests cover the
wizard on desktop and mobile; Workers tests cover authentication and secret input.

## Validation

On November 6, 2026, the wizard completed a live run at the separate
`setup.heflare.app` test installation: binding status, native Artifacts creation,
Worker version verification, native Secret save and opening the application.
Desktop and mobile Chrome checks reported no script errors. The Secret check used
a dummy OpenCode key and ran no inference or assessment. The dummy secret,
temporary Access policies/service tokens and account tokens were removed;
the owner Access policy and test installation remain. No account credentials or
account logs were added to GitHub Actions.

## Limitations

This is post-deployment setup. A complete fresh-account **Deploy to Cloudflare**
button, automatic Access provisioning and automatic tool-image installation are
not shipped. Cloudflare's [deployment button](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
supports selected bindings; the full PentCloud stack still needs a configured
deployment. The wizard reports missing resources rather than becoming a second
infrastructure installer.

Human SSO sign-in, paid model inference and a complete assessment need their own
acceptance checks. Review [requirements and costs](requirements.md),
[Cloudflare credential setup](cloudflare-setup.md) and [operations](operations.md).
