# Install and deployment

The custom command-line installer and installation-test pipeline have been removed.
The in-app setup wizard is not implemented yet. Existing installations continue
running; do not replace their bindings, secrets, migration tags or data.

## Managed deployment direction

1. Use [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
   connected to GitHub or an
   [Artifacts repository](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/).
2. Start with one persistent staging installation on the separate testing domain.
   Give it its own app, private tool gateway, Durable Objects, Artifacts namespace,
   Workflow and Access policy. Production remains separate.
3. Release the eleven smaller tool packages independently of application features.
   Use native [Containers image deployment](https://developers.cloudflare.com/containers/guides/image-management/).
   New installations must not install Kali. Existing legacy backends remain unchanged.
4. Add a first-run wizard that authorizes the owner, checks existing resources,
   creates missing resources through supported Cloudflare APIs/bindings, applies
   deployment configuration through Builds, and verifies each completed step.
   Additional credentials need explicit authorized scopes; native bindings do not
   need a separate API key for every service.

The first implementation phase is managed staging. OAuth registration, secure
first-owner setup and the wizard's exact permissions still need validation before
shipping a customer deployment button. No bootstrap endpoint is public yet.

## Existing application deployment

Keep using the installation's existing Cloudflare Builds connection and private
configuration. The repository's checked-in Wrangler files are compilation examples,
not ready-to-use customer configurations. Do not deploy them unchanged.

For source verification, use `npm ci` and `npm run verify`. Local app checks need
Node 26.12.1 or later 26.x and Go 1.26.5. The native build verifies the prebuilt
Worker and source map before the existing deployment command uploads them.
GitHub source checks need no Cloudflare deployment secrets or account logs.

Worker Previews can isolate Durable Objects and containers. Workflows require a
dedicated test deployment; service bindings do not automatically select a peer
Worker's matching Preview. See
[Preview isolation](https://developers.cloudflare.com/workers/previews/resources/).

## Limitations

The replacement customer wizard and deployment button are not available yet.
A passing source check does not prove fresh-account setup, human sign-in,
model access or a complete assessment. Keep those acceptance checks separate.

Review [requirements and costs](requirements.md),
[Cloudflare credential setup](cloudflare-setup.md), and
[operations](operations.md) before deployment.
