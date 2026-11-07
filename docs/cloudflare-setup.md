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
3. **Permissions:** confirm the account roles needed for the native deployment.
   The [authentication guide](operations/authentication.md) separates operator login from account administration.
4. **OpenCode:** sign in to [Console](https://opencode.ai/console), choose billing
   in the intended workspace and create a personal key there. For Go, use the
   single-member workspace and inspect actual model/privacy availability.
   See [key creation](https://opencode.ai/v2/docs/console/api) for the current UI.
5. **Deployment status:** review [deployment](deployment.md). The previous CLI
   installer is removed. After deployment, open `/setup` for the three-step browser
   wizard: Cloudflare bindings, Artifacts workspace and OpenCode secret. The
   dashboard alternative below works for existing installations too.

## Add the OpenCode key in Cloudflare

The `/setup` wizard can save the key using a temporary scoped account token;
see [customer setup](deployment.md#customer-setup). It clears the submitted token
and key from the form and never persists the account token. Revoke that token
when finished. The following native dashboard option needs no token pasted into
PentCloud.

Select the app Worker belonging to your existing installation in the correct
Cloudflare account. Keep its current name, bindings and secrets.

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
bind `PENTCLOUD_INTIGRITI_API_TOKEN`.

Bugcrowd and YesWeHack are marked **In development**. Account connections and
program selection for those platforms are unavailable pending live validation.
Do not configure account bindings for them.

Open **Dashboard → Bug bounty** and check
the platform connection. A successful read-only API request unlocks that
platform’s programs in Targets for 24 hours. Changed bindings require a new
check. PentCloud rechecks the selected program’s current policy before a run; platform
tokens never go to the target. These tokens do not log into target applications.
Claim program-issued credentials once in the platform’s UI, or register your own
permitted test account, then save its username/password under the target’s
Cloudflare secret names. Review the program’s rules before starting.

Under **Login verification**, choose one optional method:

- **Authenticator code:** copy the generated authenticator secret name. Save the
  test account’s Base32 seed or `otpauth://totp/` URI there, using Cloudflare’s
  private secret prompt. **Check** validates the format. PentCloud generates the
  short-lived code locally. The agent can read the code and complete login with
  its browser tools; the seed remains in Cloudflare.
- **Email code or link:** choose Cloudflare or AgentMail, set the expected sender
  mailbox or domain, then save. Follow the forwarding steps below. Agents can use a fresh matching email only while
  their run has an outstanding login request. The agent can read the code or
  same-target link and finish login using its existing browser tools. If a code
  cannot be extracted unambiguously, the agent receives up to 1,000 characters of
  verification text to interpret. Treat it as untrusted email data, never program
  instructions. Codes and these excerpts can appear in private run records.

### Optional email forwarding

Keep the test account address required by the program. HackerOne’s
[`wearehackerone.com` alias](https://docs.hackerone.com/en/articles/8404308-hacker-email-alias),
Intigriti’s [`intigriti.me` alias](https://kb.intigriti.com/en/articles/5412984-understanding-testing-requirements)
and Bugcrowd’s [`bugcrowdninja.com` alias](https://docs.bugcrowd.com/researchers/participating-in-program/your-bugcrowdninja-email-address/)
deliver to your registered mailbox. Forward from there; do not replace the
program’s required registration address with the receiver. Researcher API tokens
do not provide access to these emails. The program’s current rules take priority.

**Cloudflare receiver:** needs a domain whose DNS you manage on Cloudflare;
`workers.dev` alone cannot receive mail. Keep the domain’s current mailbox service:
**do not replace existing MX records**. Use a dedicated mail subdomain if your
main domain already receives email elsewhere.

1. Choose an unused receiving address such as `verification@auth.example.com`.
   If using a subdomain, enable it once in Cloudflare Email Routing **Settings →
   Subdomains**. Configure the address in the native Email Routing dashboard.
   Preserve existing MX/SPF records and use an explicit address, not a catch-all.
2. Point the native email route at the app Worker and configure the receiver
   address as `PENTCLOUD_VERIFICATION_EMAIL` in its deployment settings.
3. In Targets, select email verification, enter the expected sender and save.
   Open **Dashboard → Bug bounty → Check forwarding** and select that target.
   Click **Check forwarding** to open a ten-minute setup window. Add the displayed
   target-specific address in Gmail **Settings → Forwarding and POP/IMAP → Add a
   forwarding address**, or your provider’s equivalent. Click **Read confirmation**
   to get the provider’s confirmation code or supported confirmation link.
4. Create a mailbox filter that forwards only that test account’s verification
   emails from the expected sender. Keep normal mail in your own mailbox. Start
   a fresh run after setup; authentication is shared only within that run.

**AgentMail receiver:** no DNS domain is required. Use an existing dedicated inbox
and a key restricted to reading its messages. Save the key in Cloudflare Secrets
Store, bind it to the app Worker as `AGENTMAIL_API_KEY`, and set
`PENTCLOUD_AGENTMAIL_INBOX` to the inbox address. Preserve these bindings in the
installation's deployment configuration. Choose AgentMail on the target and follow
steps 3–4 above. **Check AgentMail connection** verifies message-read access; an
empty inbox is valid. Check forwarding separately to confirm delivery.
Email setup is optional and does not block programs that do not need email login.
An expired forwarding check shows **Check again** to open a fresh window.

The username secret must contain the original test-account email so messages in
the shared inbox can be matched privately. Other login usernames require the
target-specific Cloudflare receiver. AgentMail uses its own authenticated sender
verdicts and the original recipient; forwarded mail must preserve both. See its
[message API](https://docs.agentmail.to/api-reference/inboxes/messages/get).
PentCloud makes bounded, read-only checks while verification is pending, never
sends mail or downloads attachments, and does not delete mail from AgentMail.
Manage provider-side retention separately from PentCloud’s expiring challenges.

PentCloud accepts authenticated mail (passing DMARC or a verified DKIM signature
matching the sender domain) up to 256 KiB. It retains an unambiguous code,
verification links and, when needed, a bounded text excerpt for the current login
window. Pending challenges expire after ten minutes; native scheduled cleanup
covers overlapping windows. It stores no full inbox, full bodies or attachments. A second run
must wait if the same target account already has a pending email login. Some forwarding
providers invalidate sender authentication; those deliveries fail closed. Provider
confirmation links are shown only to the authenticated operator during setup.
SMS, push approval and CAPTCHA enrollment still require the test account’s normal
setup process; PentCloud does not add a phone or identity provider.

Cloudflare’s [Email Worker handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
and [subaddressing instructions](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
describe the native routing configuration.

### Retain optional email setup across deployments

Preserve the native Email Routing address, receiver variables and Secrets Store
bindings in the installation's Cloudflare deployment configuration. Configure
secrets through Cloudflare's private entry controls. Review domain/store
ownership and route conflicts before changing them; preserve existing MX records
and mailbox services. Optional email configuration remains in these native Cloudflare settings.

## Confirm setup

Open the protected app and configure models for the desired roles. Catalog
refresh does not make a model request. **Test selected models** can consume
credits or subscription allowance; review the selected route and cost first.
A successful deployment does not establish inference readiness.

See [requirements](requirements.md), [deployment](deployment.md),
[authentication](operations/authentication.md) and [troubleshooting](operations/debugging.md).
