# Targets and assessment setup

Start at **Your targets**, or open **Dashboard → Targets** from chat. Add a Website or API, give it a name and save its
base address. Saving does not contact the target. A target is reusable and
independent of its runs; editing it affects future runs, and deleting a run
does not remove the target. Archive hides a target; delete removes its reusable
defaults while retained run snapshots and Git evidence remain.

## Bounty scope and target login

**Dashboard → Bug bounty** contains the supported HackerOne and Intigriti
researcher connections and optional email receivers. Configure native Cloudflare
bindings and click the platform’s connection check. A successful read-only check
unlocks that platform for 24 hours; changed bindings require a new check. See
[platform secret setup](../cloudflare-setup.md#program-accounts-and-verification). A
platform connection is separate from the test account used on a target.
Bugcrowd and YesWeHack are marked **In development**; their account connections
and program selection are disabled until they can be validated live.

In Targets, **Find a bounty program** opens a searchable, scrollable list from the public
[PentCloud scope catalog](https://github.com/Memrov/PentCloud-scopes). Choose a
website/API asset from a connected platform, or enter a concrete hostname for a wildcard. Import saves a
checksummed catalog revision, applicable rules and exclusions on the target.
Only the selected origin and base path are granted; other program assets are not
automatically reachable. Non-web assets and ambiguous network exclusions can
require manual review. Catalog data is not authorization: check the program's
official rules, permitted methods, rate limits and account requirements yourself.
Refresh its saved scope before subsequent hunts; existing runs keep their snapshot.

Under **Network and login settings**, enable optional headers, browser login or
API authentication. Copy the generated names into Cloudflare Worker secrets or
Secrets Store bindings; no credential values are entered in PentCloud. See the
[secret setup walkthrough](../cloudflare-setup.md#target-login-and-api-secrets).
**Check** verifies availability and supported format only, not authentication.
Generic passwords and API keys have no universal validity test. The API setup
provides an explicit read-only authenticated check; the browser agent confirms
login by inspecting the resulting page. Header secrets are a JSON object of
header names and values and overwrite agent-provided values on managed requests.

The agent inspects the form, calls `pentcloud_browser_login` with its selectors,
then submits using its existing browser tool. Login must remain inside the saved
target. Email codes/links and authenticator TOTP codes are supported; external
identity providers, push approval, security keys and CAPTCHA need separate support.
The agent reads a fresh code or bounded verification excerpt and completes the
form with its existing browser tool. Receiver setup and forwarding confirmation
are under Bug bounty; the expected sender and login bindings remain on the target.
Each run starts fresh. Cookies and local storage are shared only among that run's
agents, stored privately for up to 30 minutes since their last update, and cleared
on completion, stop or deletion. They are not Git artifacts or settings exports.
Cleanup does not revoke the target's server-side sessions. Operators on one
installation share these capabilities. Target pages/scripts can see supplied
credentials; use disposable assessment accounts.

Managed browsers use native hostname guardrails and trusted CDP interception for
paths, exclusions, redirect hops and headers. Chromium retains response streaming,
uploads, cookies and TLS; responses are not buffered through an application proxy.
Computer curl, the API adapter and retrieval use the same URL matcher. Browser
WebSockets are disabled. **Kali retains direct Internet access: scope is not
network-enforced for Kali.** Required browser headers and login are not silently
injected into every Kali tool. Program rules, rate limits and permitted testing
remain operator and agent responsibilities. Review the
[network risks](../../SECURITY.md#network-and-data-risks).

Below the saved address, **Source context (optional)** can attach up to five
existing Artifacts repositories or import public GitHub source through the native
Artifacts binding. Each run freezes the selected repository identities and exact
commits. Source stays separate from run work; later refresh/removal affects future
runs. Private GitHub requires an existing Artifacts copy. Workers & Pages login
alone is not a verified import path. See [source context](source-context.md) for
import progress, read limits, refresh, retention and restore behavior.

Confirm authorization and the network-reach disclosure, then choose
**Verify address & start discovery**. The Worker performs a bounded address
check without a model. Redirects require review instead of silently adopting a
different address. Authentication-required responses can still prove reachability.
This check does not prove ownership, scanner connectivity or host confinement.

New discovery uses the existing stock WhatWeb tool with the verified stealthy
profile (`whatweb-stealthy-v2`) and a 60-second tool timeout. An observed HTTP
status is required for successful discovery; a completed envelope with no HTTP
response records a coverage warning. Historical `whatweb-polite-v1` attempts
retain their recorded arguments when retried. The shared scanner can take time to start.
Discovery and assessment execution use the same one-active/two-waiting queue.
A queued primary can hold a read-only conversation alongside that execution. Recorded
remote uncertainty keeps its existing safety ownership until reconciliation;
refreshing progress never starts an additional scan or polls Kali status.
The setup page shows a Kumo loading card for queued discovery, scanner startup
and discovery, then recorded completion or a coverage warning. Model and API
setup remain usable during the wait. Progress follows stored job state; the UI
does not add container health polling or keep an idle scanner awake. In chat,
a compact loading/status row opens those same details, leaving room for the
conversation on mobile.

Choose **Open chat** once the displayed model/API setup passes its checks.
The primary can discuss the project, ask native questions and read supplied files
while Kali is starting or discovery is running. Opening chat uses OpenCode credits;
loading a page or testing a connection never starts this conversation. Discovery
itself has no model chat.

Preparation exposes only file/source reads, recorded progress and native questions.
It cannot execute code, write source, browse, call the API, delegate, publish a
result or start a scanner. It uses a separately fingerprinted source/material
snapshot, leaving discovery's scanner and Git ownership unchanged. At ordinary
assessment admission, the same OpenCode session continues with accepted discovery
context and the latest accepted source/material input, pinned once. Native tools
are reloaded; subsequent execution retries remain immutable. A durable
`promotionPending` marker retries an interrupted workspace/tool reload before
any assessment model turn. New steering waits
for that transition, while pending native forms remain answerable.

If discovery fails after chat opens, the conversation stays available. Assessment
work waits for safe execution drain and **Accept incomplete discovery & continue
assessment**. An unknown remote outcome cannot be acknowledged away. Stop,
archive, trash and permanent deletion include queued preparation conversations,
even if material admission already marked their jobs terminal. Input rejection
aborts preparation without hiding its existing native transcript. Discovery
rejected before any launch receipt is safely drained without contacting Kali;
its missing coverage still needs acknowledgement. Initial files remain selected
for primary admission if discovery could not admit them.
A terminal receipt with a different execution mode/model is retained
as a rejected result, without accepting its Git candidate or retrying work.
The run then shows **Discovery needs attention**; continuing requires explicit
acknowledgement of incomplete discovery. Never relabel rejected output as a
successful scanner result or automatically retry an uncertain scan.

## OpenCode models

See [requirements and billing choices](../requirements.md#choose-opencode-billing-and-create-the-key)
and the [Cloudflare key walkthrough](../cloudflare-setup.md#add-the-opencode-key-in-cloudflare)
before configuring models. Go is the suggested solo starting option when its
actual model/privacy availability fits; its allowance does not pay BYOK charges.

Use an OpenCode Console (pay as you go) or Go key with Models Request permission.
These are the only model services supported by setup. The current installation's
bound Go key remains available without being extracted or replaced. OpenCode key
entry is handled in Cloudflare, through encrypted Worker secrets or Secrets
Store bindings named `OPENCODE_GO_API_KEY` (Go) and `OPENCODE_API_KEY` (Console).
The app selects configured binding references; it rejects model-key writes.

OpenCode Console BYOK connections can also be declared in the nonsecret
`OPENCODE_BYOK_PROVIDERS` Worker variable, as JSON:

```json
[{"connectionId":"conn_YOUR_CONNECTION","name":"Meta","models":["muse-spark-1.3","muse-wonder-1.0"]}]
```

Copy the connection ID from its Console API URL under OpenCode Providers. Only
model IDs with vetted tool-capable Console catalog metadata are supported here;
enable them on that connection in OpenCode. Each gets a distinct **Meta BYOK**
choice in the existing model selectors. Its native adapter calls only
`https://opencode.ai/inference/custom/<connectionId>` and never falls back to
ordinary Console credit billing. The Meta credential stays in OpenCode; the
OpenCode workspace key stays in its Cloudflare binding. An existing Go-associated
workspace key can be tested with BYOK if it has Models Request permission in
that workspace. Go allowances do not pay BYOK usage; the provider bills it.
No new key is inherently required. A dedicated service-account key is optional
for isolating server usage and budgets.

Provider configuration changes invalidate cached future choices and their
readiness. Existing pinned jobs keep their original model/connection. Fresh
installations require their own BYOK connection metadata; configure it explicitly
after installation. Unsupported
models or malformed connection IDs fail closed. Provider settings remain managed
in OpenCode; this variable is an explicit allowlist, not automatic synchronization.
See [Providers API](https://opencode.ai/v2/docs/console/api/providers/) and
[key permissions](https://opencode.ai/v2/docs/console/api).

Choose one default model and optionally override primary, adviser, coder,
maintenance, memorist, pentester, searcher and reporter. Model choices come from
OpenCode's live catalog. A catalog listing does not prove a key is valid or a
model is included in a plan. Test selected models explicitly; this performs a
small native OpenCode session generation and may use OpenCode credits, with no
target or scanner access. Tool support comes from the live catalog; the test
does not execute tools. Identical configurations share a proof for 24 hours.
Catalog data caches for 15 minutes with an honest fetch time; a selected model's
changed metadata requires another test. Testing refreshes the catalog first;
**Refresh catalog** forces a new upstream fetch. Catalogs use OpenCode’s documented public endpoints without an API key. Native
fetch uses `redirect: "manual"` and rejects redirect statuses. Workers rejects
`redirect: "error"` before sending a request; it must not be used here.
Uncached catalog failures show a safe
HTTP status or network/response category; upstream bodies and keys are excluded.

The selected model is registered through OpenCode's native provider plugin API.
Tests and actual attempts share that provider/compatibility configuration, with
`models.fetch` and `models.snapshot` disabled to avoid loading the global catalog.
A disposable `OpenCodeConnectionTest` Durable Object owns each explicit test's
SDK host and clears its temporary storage afterward. It has no run workspace or
Kali integration. The current Worker and fresh-install template both bind it as
`MODEL_TESTS`; upgrades append the class migration without changing run storage.

PentCloud does not switch between Go and Console billing or alter OpenCode
privacy, region, budget or Extra Usage settings. A refusal links back to
OpenCode for repair. Models without advertised tool support or a successful
native connection test cannot activate analysis.
The native OpenCode Responses adapter already requests encrypted reasoning
replay. BYOK uses that same adapter without a custom streaming/history layer.

## API test access and files

API test credentials are separate from model keys. Select public/unauthenticated
coverage, or save a Bearer token/API-key header and test a known protected
read-only endpoint. The test compares anonymous and authenticated GET responses;
a public 200 is not proof the key works. Cookie login, OAuth refresh, website
login and mTLS are outside this first setup.

Saved API credentials are injected server-side by pentcloud_api_request only
within the selected API origin/base path. Redirects do not receive the key.
The credential's audience is immutable: changing a target address requires a
new key reference. Ambiguous encoded path separators/nested encodings are
rejected before a credential is attached.
Most stock scanners do not accept arbitrary headers; storing a key does not
make every scanner authenticated. Findings must identify the actual coverage.
This credential-custody rule does not constrain other browsers or scanner
egress; the [network and data risks](../../SECURITY.md#network-and-data-risks) remains
the product's disclosure.

A JSON/YAML API definition of at most 2 MiB can be saved for reuse. Each analysis
receives a fresh run-owned, hash-verified material receipt; no prior run upload
ID is reused. Definitions do not automatically execute operations or external
references. Remove secrets from examples before upload. General chat files
retain the existing eight-file/8 MiB total limits. Files become immutable Git
evidence; deleting a current attachment does not erase old commits or exports.

## Analysis, credentials and lifecycle

**Stop run** is available in the run header during discovery and setup, before
chat opens. It uses the existing Coordinator cancellation path and preserves
history. Already-submitted tool operations retain their normal drain/reconciliation
rules. The shared Kali Container has a separate native inactivity lifetime;
stopping a run does not change its 30-minute idle policy.

Finish connection tests and choose **Open chat** during or after discovery.
This action pins target, model/adapter, credential versions and selected definition;
changed defaults cannot alter the conversation. Selected staged files are read
through a run-scoped, hash-verified RPC before their ordinary Git admission.
Discovery still publishes its result normally. Assessment tools wait for safe
discovery drain and any required coverage acknowledgement; opening a conversation
does not grant scanner or publication ownership. The actual immutable execution
input is pinned from accepted Git when that primary is admitted.

OpenCode key values remain in Cloudflare secret bindings. Coordinator stores
only references and a SHA-256 connection-proof fingerprint; native OpenCode
receives the key in memory for its provider. Rotation requires another explicit
model test. A pinned run cannot silently adopt a different key; use a new run
after testing a rotated binding. No account administration credential is needed
in the runtime. Target API credentials retain their existing server-only
Coordinator storage and write-only save/replace/revoke controls.
Values do not enter Git, ordinary exports or live State. Privileged account
administration and platform backups are inside the trusted deployment boundary;
this is not application column encryption or immediate cryptographic erasure.
Revocation fences new use; it cannot retract a request already sent.

Old targetless chats remain readable. New external steering/revision requests
on them require a new target-backed run. Previously admitted work and its
internal continuation/reconciliation keep their pinned legacy configuration.

Setup revisions protect concurrent tabs. A clean form loads newer saved values;
a dirty form requires an explicit reload before it can overwrite or activate
them. A pending creation URL retains its nonsecret run identity across reloads;
the server retains the validated creation intent so a lost response can be
reconciled without starting another discovery job. No keys enter that URL.

CLI export includes target/profile metadata, reusable definition files and
verified Git bundles. import-targets restores the library and definitions into
an empty library, requiring credential re-entry; it does not restore execution
authority or native conversations. Retain live resources for session recovery.
Destructive uninstall inventories and explicitly removes onboarding data only
after all runs and remote/publication ownership are safely settled.
