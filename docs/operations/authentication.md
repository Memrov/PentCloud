# Authentication and credential custody

Cloudflare Access admits operators; account authorization installs/administers
resources; private bindings connect runtime services. An app login does not
grant Cloudflare account administration. Each installation must generate its
own Access issuer/audience and allowed-email policy.

## Application and runtime

The Worker cryptographically verifies the edge-issued Access JWT signature,
issuer, audience and expiry with JOSE. Arbitrary bearer text does not replace
that check. Browser mutations and WebSocket upgrades reject foreign origins.
Admitted operators share the installation's work; this is not tenant isolation.

The gateway's default public HTTP handler returns 404 and production configs
disable workers.dev/previews. Toolbox capabilities are supplied through the
ToolboxGateway service binding, with generation and operation-ownership checks.
The app and gateway have model/tool secrets, not account-admin API credentials.

OpenCode keys belong in Cloudflare Worker Secrets (or supported Secrets Store
bindings), entered through the first-run wizard or native Dashboard/CLI prompts.
Optional BYOK provider keys stay in OpenCode. Target API credentials have a separate audience-bound
storage/use path. Do not put credentials into prompts, Git or source config.

## Setup authorization

After protection is configured, the first-run wizard requires the same verified
Access JWT as the app.
Mutation routes reject foreign browser origins. The only unauthenticated setup
status is a fixed indication that Access has not been configured; it cannot
create storage or save model secrets through the normal authenticated routes.

The initial `/v1/ui/setup/access` route works only while both Access settings are
absent. It requires a scoped Cloudflare account token and verifies the exact
current Worker version before any mutation. It reads the existing Zero Trust
organization, creates an owner-email-only hostname policy, and atomically saves
Access settings and an optional OpenCode key as Worker Secrets. The account token
is never retained. It refuses to replace unrelated Access apps/policies. This
account-admin authorization bootstraps the app login; it is not an anonymous
first-owner claim.

Artifacts preparation uses the deployment's native binding and revokes its unused
initial Git credential. Model-key saving requires an administrator-supplied,
scoped **Workers Scripts Edit** token. The wizard checks the exact current Worker
version in the selected account/script before calling the native Secret API.
It accepts only the two OpenCode secret names, never an arbitrary destination.
The account token is never stored, and both password inputs are cleared after
submission. Responses contain fixed errors, not Cloudflare response bodies.
Revoke the temporary setup token after use. The Worker retains only the encrypted
model secret, not account-administration credentials.

Prefer native bindings for runtime access. Creating further account tokens would
require separate token-management authorization; this wizard does not mint them.
App sign-in alone does not grant Cloudflare account administration.

The existing native browser-QA adapter still uses official Cloudflare clients
for its temporary test authorization. It never scrapes CLI credential caches.
Cloudflare `cf` and Wrangler have separate sign-in sessions.

## Local defaults

The repository's Wrangler examples have empty trusted Access issuer/audience
and cannot authenticate a production user. Preserve each existing installation's
own deployment configuration; do not copy another account's identity.

For browser QA, the explicit runner uses a temporary native Access service token
and exact-token policy, preserving existing policies and revoking owned access.
See [browser QA](browser-qa.md); it is a test-only workflow, not an app login
bypass or a permanent public browser-control service.

References: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
[account tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/).
