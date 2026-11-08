# Requirements and costs

Prices checked November 4, 2026, in USD before tax. These are provider prices,
not a PentCloud subscription or a quote for an assessment. Check the linked
pricing pages and the selected account before enabling billing; allowances are
shared with other workloads in that account.

## Recommended starting setup

| Requirement | Starting choice | Subscription cost |
| --- | --- | --- |
| Cloudflare compute | **Workers Paid, Standard usage model** | **$5/month minimum** plus metered usage |
| Operator login | **Cloudflare Zero Trust Free / Access**, within its seat limit | $0 for up to 50 users |
| Model service | **OpenCode Go** for a solo owner who wants its supported models | **$10/month**, with usage limits |
| Model key | Personal OpenCode workspace API key with **Models → Request** | Covered by the chosen model billing route |
| Hostname | Installation's Access-protected `workers.dev` address | No purchased domain required |

The starting subscription subtotal is **$15/month: $5 Cloudflare + $10 Go**.
Container/browser/runtime/storage overages, optional services and model usage
outside the subscription are additional. This is not an all-inclusive price.
Existing Workers Paid customers do not buy a second plan just for PentCloud.
See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Access free seats](https://blog.cloudflare.com/adaptive-access-user-risk-scoring/)
and [Go plans](https://opencode.ai/console/go).

## Cloudflare services and account setup

Workers Paid is an **account-level developer subscription**. A website's
Cloudflare Pro/Business zone plan does not replace it, and buying one is not
required for this installation. Create a Cloudflare account, add a billing method
and enable Workers Paid in the chosen account. Complete billing and service terms directly in Cloudflare after reviewing the
resources and costs.

| Capability | Needed for | What to check |
| --- | --- | --- |
| Workers + a Workers subdomain | App and private gateway | Workers Paid; generated `workers.dev` address available |
| SQLite-backed Durable Objects and Worker Loader | Coordinator, native sessions/workspaces and dynamic tools | Account deployment access; billed with native product meters |
| Containers + Cloudflare Registry | Eleven smaller tool packages | Product access/terms and capacity for the selected package profiles; existing legacy installations retain their backend |
| Artifacts | Per-install work/evidence repositories | Workers Paid; namespace/repository access and current terms |
| Browser Run | Agent browser tools | Account access; browser-hour/concurrency allowance |
| Workers AI binding | Supported document-to-Markdown conversion | Service availability/terms; model-backed conversions may incur charges |
| Zero Trust / Access | Protect operators' UI/API access | Free plan is sufficient within its limits; team domain, login provider and allowed operator emails |

These are service entitlements to verify, not a list of separate fixed-price
subscriptions to purchase. Access setup is separate from enabling Workers Paid.
Email one-time PIN is a simple login option; a paid identity-provider subscription
is not required. See [setup walkthrough](cloudflare-setup.md).

**Not required by the runtime itself:** a paid DNS/zone plan, custom domain,
public Tunnel, dedicated egress product, paid Access tier, Secrets Store add-on,
Docker daemon or a customer-managed object-storage bucket. The app uses native Worker secrets. Existing Secrets Store
bindings are supported and should be preserved.

The runtime's `agents/queue` is hosted in its Durable Object, not a separate
Cloudflare Queues deployment. Do not buy/configure a Queues subscription or add
an R2 bucket merely because those words appear in an architecture discussion.
The image registry has Cloudflare-managed storage backed by R2; inspect any
registry/R2 activation prompt and bill in that account, without creating S3 keys
or assuming all storage usage is Artifacts. See
[image management](https://developers.cloudflare.com/containers/guides/image-management/)
and [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Where usage charges come from

| Meter | Included allowance on Workers Paid | Published rate after allowance |
| --- | --- | --- |
| Workers requests / CPU | 10 million requests and 30 million CPU-ms/month | $0.30/million requests; $0.02/million CPU-ms |
| Dynamic Workers / Worker Loader creations | 1,000 unique daily creations/month | $0.002/additional Dynamic Worker per day; requests/CPU share Workers meters |
| Durable Object compute | 1 million requests; 400,000 GB-s/month | $0.15/million requests; $12.50/million GB-s |
| Durable Object SQLite | 25 billion rows read; 50 million written; 5 GB-month | $0.001/million reads; $1/million writes; $0.20/GB-month |
| Container memory / active CPU / disk | 25 GiB-hours; 375 vCPU-minutes; 200 GB-hours/month | $0.0000025/GiB-second; $0.000020/active vCPU-second; $0.00000007/GB-second |
| Browser Run | 10 browser-hours/month; 10 average concurrent Browser Sessions | $0.09/additional hour; $2/additional average concurrent browser for Sessions; Quick Actions has no concurrency charge |
| Artifacts, billing starts **November 12, 2026** | 10,000 operations/month; 1 GB-month | $0.15/additional 1,000 operations; $0.50/additional GB-month |
| Native Builds, when configured | 6,000 build minutes/month | $0.005/additional minute |

Sources: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Containers](https://developers.cloudflare.com/containers/platform/pricing/),
[Browser Run](https://developers.cloudflare.com/browser-run/pricing/),
[Artifacts](https://developers.cloudflare.com/artifacts/platform/pricing/),
[Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/).
Do not count shared Workers allowances twice. Worker Loader execution
and native service calls can contribute to runtime meters. Dynamic Worker daily
creation counting depends on ID and code; new IDs/code versions or loads without
stable IDs can count repeatedly. See
[Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/).

Container internet egress is another meter: included monthly regional allowances
are 1 TB for North America/Europe and 500 GB for other listed regions; published
overage is $0.025–$0.05/GB by region. Workers and Durable Objects supporting a
Container still have their own meters.

### Legacy shared-Kali usage while awake

This example applies only to existing shared-Kali installations. New installs use
eleven smaller tool-pack profiles with their own resource settings; apply the
Container meters above to the profiles actually running.

The legacy gateway requests **2 vCPU, 6 GiB RAM and 20 GB disk**. Memory and disk
are charged for provisioned resources while awake; CPU is charged for actual use.
At published rates, before included allowances and other meters:

- One awake hour contributes about **$0.059** of memory/disk usage.
- A full hour using both vCPUs adds up to **$0.144**, about **$0.203 combined**.

These calculations are not an assessment price. Browser time, storage, orchestration,
egress and inference are separate. The native inactivity window is **30 minutes**;
waiting between tools/models can still be awake time. Stopping a run is not a
promise of immediate Container shutdown. Do not poll Kali status to estimate a
bill, because those requests can keep it active.

### Logs, conversion and optional audit tools

- Workers Logs currently include 20 million events/month, then $0.60/million,
  with seven-day retention. **From December 1, 2026**, shared Observability Paid
  allowances become 50 GB ingestion and 10 GB-month storage per billing cycle,
  then $0.25/GB ingested and $0.10/GB-month stored. Container logs also move to
  that model. Keep the current sampling; queries/dashboards do not imply free
  unlimited ingestion. [Workers logs](https://developers.cloudflare.com/workers/platform/pricing/#workers-logs),
  [new Observability pricing](https://developers.cloudflare.com/observability/pricing/),
  [Container logs](https://developers.cloudflare.com/containers/faq/).
- `AI.toMarkdown` is free for most formats; model-backed operations such as image
  conversion can consume Workers AI allocation. Workers AI includes 10,000 neurons
  daily, with $0.011/1,000 neurons above that on Paid. These are Cloudflare charges,
  not Go usage. [Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/),
  [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- Optional `clef_audit` needs the AI binding and an explicitly configured
  `AI_GATEWAY_ID`. The gateway is optional and must be configured separately. Core
  Gateway features have no extra subscription; inference/logging can still cost.
  Clef Flash lists $0.038/million input tokens and Clef $0.24/million; output tokens
  are not charged by those models. Configure and verify this separately if wanted;
  do not mark it ready solely because installation succeeds.
  [Gateway](https://developers.cloudflare.com/ai-gateway/reference/pricing/),
  [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/),
  [Clef](https://developers.cloudflare.com/workers-ai/models/clef/).

## Choose OpenCode billing and create the key

**Recommended for a solo first install: Go**, if its live model catalog and privacy
settings fit the work. Go is $10/month; Go Plus is an optional $40/month upgrade.
Go Teams is $20/member/month. Go/Go Plus require a single-member OpenCode workspace;
Teams service accounts are not covered by Go Teams. These are OpenCode workspace
rules, not a count of people allowed into PentCloud. Confirm current terms before
choosing a shared/team setup. [Go details](https://opencode.ai/v2/docs/console/go).

Go has model-specific five-hour, weekly and monthly allowances shared by the
installation's agent requests. It is not unlimited and does not include every
Console/BYOK model. Extra Usage can consume paid Console balance after limits;
review that switch and the workspace budget rather than enabling it silently.
Catalog availability, regions and data-use settings can change; do not hardcode
a model recommendation or broaden privacy settings just to make a model appear.

Alternatively use Console pay-as-you-go with funded balance and a budget. BYOK
is optional: vendor keys are configured in OpenCode and billed separately by that
provider, not paid from Go's allowance. A vendor's chat subscription is not proof
of API entitlement. No direct OpenAI/Anthropic/Meta key is required for the Go path.
Console credit purchases currently add a processing fee of 4.6% + $0.31; for
example, a $10 credit purchase costs $10.77. Auto-recharge can buy more credits,
so review it separately from Go's Extra Usage switch.

For Go, create a **personal API key in the workspace with the subscription**:
OpenCode Console → account menu → **Account → Personal API keys → Add API key**.
Name it for this installation; select **Restricted → Models → Request** when
permission controls are offered. Ordinary members may instead see a statement
that the key can list/call models. Read-only model access cannot run inference.
Choose an expiry you can maintain. The full key is displayed once; enter it
directly into Cloudflare as described below, without sending it to an AI chat.
Console service-account keys are an alternative for separately budgeted automation;
do not assume a service-account key inherits a personal Go subscription.
[Key creation and permissions](https://opencode.ai/v2/docs/console/api),
[Console billing](https://opencode.ai/v2/docs/console/billing).

## Where each credential belongs

| Credential | Required? | Custody |
| --- | --- | --- |
| Cloudflare account authorization | Yes, during setup/deployment | Cloudflare-authorized account access with the required service scopes; never paste tokens into chat |
| `OPENCODE_GO_API_KEY` | For Go | Native encrypted secret on the **app Worker**, or an existing Secrets Store binding |
| `OPENCODE_API_KEY` | For Console | Same app Worker; optional alongside Go when both routes are wanted |
| Provider/BYOK key | Optional | OpenCode Providers, not a new vendor-key field in PentCloud |
| Legacy Kali MCP secret | Existing legacy installations only | Preserve the existing gateway Worker secret; new installations use the smaller tool packages |
| Target login / bound API credentials | Optional, engagement-specific | App Worker secrets or Secrets Store bindings named `PENTCLOUD_TARGET_*`; only names are saved on the target. Authenticator verification adds one seed binding. |
| Bounty researcher API token | Optional, for imported HackerOne/Intigriti programs | Native app Worker secret binding; separate from target test-account credentials |
| Verification email | Optional | Cloudflare Email Routing on an owned unused domain/subdomain, or an existing AgentMail inbox with a message-read key bound through Cloudflare Secrets Store. Preserve existing MX/mail services and the program’s registration alias. AgentMail charges/retention are separate. |

Use [Cloudflare setup](cloudflare-setup.md#add-the-opencode-key-in-cloudflare)
for exact Dashboard and terminal steps. One bound workspace key can serve all
supported roles; users do not need a separate vendor key for each agent.
Public bounty scope search needs no platform API key, GitHub token or additional
subscription. It reads a bounded, cached public catalog; private programs are not
included. [Target setup and network limitations](operations/onboarding.md#bounty-scope-and-target-login).

## Source verification and setup status

Local application checks need Node **26.12.1 or compatible later 26.x**, npm, Git
and Bash. Full source checks also need Go **1.26.5** for the CLI and preserved
import/contract checks. Python **3.11+** is used by integration assertions.
Cloudflare Workers Builds owns application build and deployment execution.
The previous CLI installer is removed; the browser setup wizard is available at `/setup`.
See [deployment status](deployment.md) before attempting a new installation.

New installations use the eleven smaller tool packages and do not import Kali.
Existing legacy installations retain their backend and credentials.

Catalog refresh is not paid inference. PentCloud's explicit **Test selected
models** action makes a model request and can use allowance/credit. Obtain
approval before model tests, target discovery or assessments. A budget alert is
not a Cloudflare spending cap.

Review [installation limits](../README.md#know-the-boundaries) before deployment.
Each account needs its own entitlement, human-login and model/scanner checks.
