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

In **Targets → Network and login settings**, enable the needed options and copy
the generated secret names. Create these on the **app Worker** as encrypted Worker
secrets, or bind existing Secrets Store secrets under the exact generated names.
Keep assessment credentials separate from OpenCode and account-administration keys.
No new secret store or credential broker is required.

Wrangler can collect a value in its private terminal prompt (replace the name
with the one copied from your target):

```sh
npm exec --workspace @pentagi-artifacts/control-plane -- wrangler secret put PENTCLOUD_TARGET_COPIED_NAME --config /private/instance-state/app.wrangler.json
```

For required headers, use a JSON object such as
`{"X-Bug-Bounty":"your-researcher-name"}`. Cookies, authorization and Cloudflare
identity headers are reserved. Optional API authentication has its own binding.
**Check** verifies that the binding is readable and has a supported format; it
does not prove login or key validity. Use the explicit read-only API check during
setup. Browser authentication is confirmed by the agent after form submission.
Never put credential values in chat, source, uploaded context or command arguments.

Secret references belong to the saved target and are pinned into each run. Browser
login is fresh for every run; its agents reuse only that run's short-lived login.
Existing application-managed API keys remain compatible. Cloudflare's limit on
Worker variables/secrets still applies; provision only the bindings you need.

## Program accounts and verification

For HackerOne, bind your researcher token as `PENTCLOUD_HACKERONE_API_TOKEN` and
set the nonsecret Worker variable `PENTCLOUD_HACKERONE_USERNAME`. For Intigriti,
bind `PENTCLOUD_INTIGRITI_API_TOKEN`. Use **Check researcher access** on the saved
target. PentCloud reads only that selected program’s current policy; platform
tokens never go to the target. These tokens do not log into target applications.
Claim program-issued credentials once in the platform’s UI, or register your own
permitted test account, then save its username/password under the target’s
Cloudflare secret names. Review the program’s rules before starting.

Under **Login verification**, choose one optional method:

- **Authenticator code:** copy the generated authenticator secret name. Save the
  test account’s Base32 seed or `otpauth://totp/` URI there, using Cloudflare’s
  private secret prompt. **Check** validates the format. PentCloud generates the
  short-lived code locally and fills it in the trusted browser helper.
- **Email code or link:** set the expected sender mailbox or domain, then save.
  Copy the target-specific forwarding address and follow the steps below. No
  mailbox API key is needed. Agents can use a fresh matching email only while
  their run has an outstanding login request. Email contents are untrusted data;
  they cannot instruct agents or change scope.

### Optional email forwarding

This requires a domain whose DNS you manage on Cloudflare; a `workers.dev`
address alone cannot receive mail. Keep the domain’s current mailbox service:
**do not replace existing MX records**. Use a dedicated mail subdomain if your
main domain already receives email elsewhere.

1. In Cloudflare Email Routing, configure an unused receiving address such as
   `verification@auth.example.com` on your routing domain. Route that **literal
   address** to the app Worker’s native email handler, and enable subaddressing
   (plus addressing). No catch-all or external inbox service is needed.
2. Set the app Worker variable `PENTCLOUD_VERIFICATION_EMAIL` to that same base
   address and deploy your private installation. Keep this nonsecret variable
   in your installation’s private Wrangler config so later deploys preserve it.
3. In Targets, select email verification, enter the expected sender and save.
   Click **Check forwarding** to open a ten-minute setup window. Add the displayed
   target-specific address in Gmail **Settings → Forwarding and POP/IMAP → Add a
   forwarding address**, or your provider’s equivalent. Click **Read confirmation**
   to get the provider’s confirmation code or supported confirmation link.
4. Create a mailbox filter that forwards only that test account’s verification
   emails from the expected sender. Keep normal mail in your own mailbox. Start
   a fresh run after setup; authentication is shared only within that run.

PentCloud accepts authenticated mail up to 256 KiB, extracts one unambiguous code
or same-target HTTPS verification link and retains pending challenges for at most
ten minutes. It stores no full inbox, message bodies or attachments. A second run
must wait if the same target already has a pending email login. Some forwarding
providers invalidate sender authentication; those deliveries fail closed. Provider
confirmation links are shown only to the authenticated operator during setup.
SMS, push approval and CAPTCHA enrollment still require the test account’s normal
setup process; PentCloud does not add a phone or identity provider.

Cloudflare’s [Email Worker handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
and [subaddressing instructions](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
describe the native routing configuration.

## Confirm setup

Open the protected app and configure models for the desired roles. Catalog
refresh does not make a model request. **Test selected models** can consume
credits or subscription allowance; review the selected route and cost first.
A successful install or doctor check does not establish inference readiness.

See [requirements](requirements.md), [deployment](deployment.md),
[authentication](operations/authentication.md) and [troubleshooting](operations/debugging.md).
