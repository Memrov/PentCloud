# Cloudflare and OpenCode setup

Start with [requirements and costs](requirements.md). The usual solo starting
choice is Workers Paid ($5/month) and OpenCode Go ($10/month), plus metered usage.
This guide covers your self-hosted installation.

## Account setup checkpoints

1. **Cloudflare:** create/sign in, choose the account and add a billing method.
   Enable Workers Paid and its Workers subdomain. Review service entitlements,
   terms and the [cost table](requirements.md#where-usage-charges-come-from).
2. **Access:** choose Zero Trust Free when its limits fit, create the team domain
   and configure a login method. Put allowed emails in installation configuration.
   Do not purchase a paid Access tier by default.
3. **Permissions:** confirm native CLI consent and the account roles for the
   temporary deployment lease. The [authentication guide](operations/authentication.md)
   lists permission names and separates operator login from account administration.
4. **OpenCode:** sign in to [Console](https://opencode.ai/console), choose billing
   in the intended workspace and create a personal key there. For Go, use the
   single-member workspace and inspect actual model/privacy availability.
   See [key creation](https://opencode.ai/v2/docs/console/api) for the current UI.
5. **Install:** follow [deployment](deployment.md) and preserve installation state.
   A key can be added afterward; successful `doctor` does not prove inference
   readiness. Configure it below before starting analysis.

## Add the OpenCode key in Cloudflare

The installer names the app `<instance>-app` and gateway `<instance>-toolbox`.
Use the app name from your installation's output/state and select the correct
Cloudflare account.

In **Cloudflare Dashboard → Workers & Pages → app Worker → Settings → Variables
and Secrets → Add**, choose **Secret** and one of these exact names:

| Name | Billing route |
| --- | --- |
| `OPENCODE_GO_API_KEY` | Go subscription workspace |
| `OPENCODE_API_KEY` | Console pay-as-you-go workspace; usual Console BYOK path |

Enter the key directly into Cloudflare and save/deploy. Add both only if both
routes are wanted. Existing Secrets Store bindings are also supported; do not
extract/copy them or create a new store unnecessarily. A Go-associated key may
also authorize a configured BYOK connection, whose provider charges are separate.
See [model setup](operations/onboarding.md#opencode-models).

For a private interactive terminal, use the project's installed Wrangler:

```sh
# Select the real generated config. No secret value is an argument.
npm exec --workspace @pentagi-artifacts/control-plane -- wrangler secret put OPENCODE_GO_API_KEY --config /private/instance-state/app.wrangler.json
# Console alternative:
npm exec --workspace @pentagi-artifacts/control-plane -- wrangler secret put OPENCODE_API_KEY --config /private/instance-state/app.wrangler.json
```

Enter the value in the native prompt, or use Dashboard if a private terminal
is unavailable. Complete Wrangler's official browser login if
needed; `cf` login does not sign Wrangler in. Never use a literal secret in shell
arguments, `echo`, environment/config files or chat. Worker **build variables** do
not supply runtime secrets. Native `secret put` creates and deploys a Worker
version; use the documented staged-version workflow instead when an existing
installation requires staged deployment.
[Cloudflare secret instructions](https://developers.cloudflare.com/workers/configuration/secrets/).

Open the protected app, refresh its catalog, choose the bound route and configure
models by role. Use the explicit model test to confirm readiness before starting an assessment. A missing key, wrong workspace, insufficient permission, exhausted
allowance or privacy restriction needs its own correction. Do not bypass it by
switching billing routes or enabling Extra Usage. Target API credentials retain
their existing separate setup flow.

## Target login and API secrets

Create optional assessment credentials on the **app Worker**, using names that
start with `PENTCLOUD_TARGET_` followed by uppercase letters, numbers or underscores.
Keep each target's credentials separate from OpenCode and account-administration
credentials. In Dashboard, add encrypted Worker secrets such as
`PENTCLOUD_TARGET_DEMO_USERNAME`, `PENTCLOUD_TARGET_DEMO_PASSWORD` and
`PENTCLOUD_TARGET_DEMO_API_KEY`. Existing Secrets Store `.get()` bindings with
these names also work; no new store or additional service is required.

The installed Wrangler can collect each value in its private terminal prompt:

```sh
npm exec --workspace @pentagi-artifacts/control-plane -- wrangler secret put PENTCLOUD_TARGET_DEMO_USERNAME --config /private/instance-state/app.wrangler.json
npm exec --workspace @pentagi-artifacts/control-plane -- wrangler secret put PENTCLOUD_TARGET_DEMO_PASSWORD --config /private/instance-state/app.wrangler.json
npm exec --workspace @pentagi-artifacts/control-plane -- wrangler secret put PENTCLOUD_TARGET_DEMO_API_KEY --config /private/instance-state/app.wrangler.json
```

Use only the needed secrets. Enter their **names**, login URL and API header
format in **Targets → Network and login settings**. No credential values belong
in chat, researcher headers, source or uploaded context. The optional API binding
uses the existing protected read-only endpoint test before authenticated analysis;
it is not automatically forwarded to every browser/scanner request. Existing
application-managed API credentials continue to work.

Setup assistants should guide the operator through native Cloudflare secret
entry, verify binding names without reading values back, then confirm the saved
target's address and credential audience. Never request an account API token as
a target credential. Credentials on a saved target are reused by future runs;
run snapshots preserve their selected references.

## Confirm setup

Open the protected app and configure models for the desired roles. Catalog
refresh does not make a model request. **Test selected models** can consume
credits or subscription allowance; review the selected route and cost first.
A successful install or doctor check does not establish inference readiness.

See [requirements](requirements.md), [deployment](deployment.md),
[authentication](operations/authentication.md) and [troubleshooting](operations/debugging.md).
