# Operations

For setup or running-system errors, start with the
[troubleshooting guide](operations/debugging.md). It maps symptoms to existing
logs, state, source and recovery controls.

## Network and scope

Targets guide the assessment but do not confine every browser, script, scanner
or research request. Review [network and data risks](../SECURITY.md#network-and-data-risks)
and configure engagement egress before providing access or credentials.

## Run, files and review

The default interface is the Access-protected hosted URL. See [hosted UI and IP
privacy](operations/hosted-ui.md) for browser assets, external navigation, target
headers and the distinction between IP containment and engagement host confinement.

Coordinator SQLite owns admission, settings locks, run state, cancellation and
accepted-head receipts. One attempt runs globally with at most two waiting.
Each fresh revision starts from the latest accepted head with pinned settings,
role, material digest and provenance. Artifacts owns immutable inputs, candidates
and accepted results; native sessions own conversations. A lost push response is
reconciled from committed evidence, not by rerunning a model.

Start with [saved targets and onboarding](operations/onboarding.md). Target
verification starts model-free discovery; OpenCode Console/Go models and API
test keys are configured independently before analysis is activated.

Stop Run/Stop Attempt fence publication and request harness cancellation.
Steering targets an active session; revision creates a fresh session. Dashboard
Overview exposes **Delete run** on Recent runs and on the run map. Kumo's native
confirmation requires the exact run ID. Confirmed deletion moves the run into
Trash, stops/drains execution, and removes its conversations, reports/findings,
attachments, evidence, local memory and dedicated Artifacts Git repository.
Archive and Trash retain data and can be restored; deletion cannot.

Permanent deletion preserves unresolved scanner-safety ownership. It waits if
another run owns execution. Attempt-owned tool runtimes must finish their existing
retirement/drain path. On legacy installations, deletion also destroys the shared
native Kali instance to discard ephemeral scratch without starting a replacement. A durable
purge intent blocks new execution until cleanup completes. Failures remain
visible for retry; select Trash to find unfinished deletion. Saved targets,
settings, saved credentials and shared source repositories are excluded. The target
application and its accounts, records and logs are unchanged.
Platform logs, backups and retention are separate; complete erasure is not
established by deleting a live application record.

Fresh installations start with no runs or imported history.

## Scanner cancellation and recovery

There is no default attempt deadline. Model/tool operation timeouts are separate.
A canceled model or interrupted object does not prove a scanner stopped. Calls
record started/completed/unknown outcomes; do not retry an uncertain mutation.
Keep its durable ownership until exact-operation evidence proves a terminal
outcome. A lost boot generation must not resend a mutation or silently boot a
replacement host. Never reset storage as a recovery shortcut.

Under authenticated `/v1` or `/v1/ui` routes:

| Operation | Route |
| --- | --- |
| Read safe receipt metadata | `GET /jobs/:id/remote-receipts` |
| Inspect a pinned read-only stock result tool | `POST /jobs/:id/remote-inspect` |
| Reconcile an observed exact operation | `POST /jobs/:id/remote-receipts/:receiptId/reconcile` |

## Installed tools and observability

New installations use eleven native tool packs through `pentcloud_tool`. Each
runner belongs to one attempt and pack; request profiles and installed image
contracts bound its capabilities. Cancellation retires the attempt-owned runtimes.
Inspect durable receipts and immutable evidence; do not repeat an uncertain
operation or infer support from an upstream tool name. See the
[execution contract](architecture.md#execution-backends-and-prompt-ownership).

On legacy shared-Kali installations, the gateway uses official MCP SDK transport and a private named service binding.
One native Cloudflare Container runs the unchanged stock Kali image; Kali-capable
specialists wait for readiness before model inference. Existing recovery renews
activity during active/unresolved work. The native 30-minute inactivity timeout
stops idle Linux scratch state; durable results remain in Artifacts. Do not poll
Kali awake. See [toolbox operations](../infra/cloudflare-kali/README.md).

Customer pilot installations use Cloudflare Computer's attempt-owned Container
backend for Linux shell commands, Node, Git, curl and direct network access.
Existing app and legacy installations keep the Worker shell/JavaScript subset
unless the Computer pilot is configured. Browser Run uses the stock persistent
Chromium integration. An explicit readonly browser-view link is ephemeral access data:
never save it into logs/model context/durable state. A connected view can incur
normal usage after its connection-link expiry.

## Routine checks and support boundaries

Use [testing](operations/testing.md) for the smallest appropriate local gate.
The default app gate reuses dependencies and builds the app; only
`verify:full` runs the complete recovery suite. Verification never deploys.
For deployment or key rotation, follow [deployment](deployment.md) and
[authentication](operations/authentication.md). Reuse installation ownership
state and preserve Worker identities, bound secrets and migration tags.

## Existing installations

Preserve installation identities and historical migration tags when upgrading.
The [legacy migration notes dated November 8, 2026](operations/legacy-migrations-2026-11-08.md)
cover separate-Worker Builds configuration, retirement of the former result
Workflow, and the remaining shared-Kali compatibility path.
