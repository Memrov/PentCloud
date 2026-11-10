# How PentCloud works

PentCloud gives a project owner a visible, steerable investigation: save a target,
configure supported models, follow specialist conversations and review findings
with evidence. These figures explain the current design; they are not benchmark
results, screenshots or proof that any particular vulnerability was found.

## From target to assessment

![Save a target, verify its address, configure models and context during discovery, open read-only preparation chat, follow the admitted assessment, then review findings.](../media/journey.light.png)

Saving a target does not contact it. After authorization confirmation, the bounded
address check starts model-free discovery. Setup stays usable while discovery
runs. The primary can hold a read-only preparation conversation after
model setup passes; execution/delegation waits for ordinary admission. Address
verification does not prove ownership or enforce network scope.
Optional program scope, identification headers and Cloudflare credential
references belong to the saved target. Runs pin that target revision; the model
receives its relevant instructions, not the entire scope catalog. Managed
requests pass through the shared target matcher. Browser Run adds native hostname
guardrails and narrow CDP interception while Chromium handles HTTP transport.
Installed scanner profiles have their own scope limits; they do not provide
universal network confinement. The customer Computer pilot and legacy Kali have
direct Internet access. In the pilot, agents must follow the pinned scope in
their instructions when using the Linux shell.
[Capabilities and limits](operations/onboarding.md#bounty-scope-and-target-login).

[Onboarding details and failure behavior](operations/onboarding.md).

## Separate conversations, shared accepted work

![Coordinator and native Lifecycle track separate OpenCode sessions and workspaces. Agents read accepted Git work and use role-dependent installed tools. Only one mutating attempt runs at a time.](../media/agents.light.png)

The roles shown are examples, not simultaneous scanning lanes. Each revision gets
a fresh native session/workspace. Coordinator SQLite is the live run/settings and
admission authority; its durable admission order allows one mutating attempt and
at most two waiting. Role-dependent tools reach Computer capabilities, Browser Run
and the installed scanner backend. Separate sessions do not provide network confinement.

## Execution backends and prompt ownership

New installations deploy one customer Worker with eleven native tool packs and
an attempt-owned Computer Container. The container gives every specialist a
full Linux shell. It starts on first use and shares the attempt Workspace through
Cloudflare Computer. The pinned container backend is experimental.
`pentcloud_tool` exposes bounded request profiles; a runner belongs to one attempt
and pack. The runtime validates the installed image and tool contract, records
execution receipts and retires attempt-owned runtimes on cancellation. A profile
is not a promise that every stock scanner option or workflow is supported.

Existing installations can retain the separate private shared-Kali gateway and
its stock MCP catalog. Its readiness, generation and 30-minute inactivity rules
apply only to that backend. Preserve its installed bindings and migration history;
see the [dated legacy migration notes](operations/legacy-migrations-2026-11-08.md).

OpenCode loads the [canonical specialist Markdown](../apps/control-plane/src/native/specialists/README.md)
directly. Every role keeps its completion, scope, cancellation and receipt rules
always loaded. Trusted runtime bindings select backend instructions and the
matching native skill; role prose does not grant tools. The original PentAGI
imports and frozen adaptation provenance remain historical reference data.

## Evidence with a history

![Pinned inputs, captured files and hashes, an evidence checkpoint, immutable candidate, validation and Coordinator acceptance form the evidence lifecycle.](../media/evidence.light.png)

Artifacts Git holds immutable inputs, candidates, captured evidence and accepted
ancestry. A data checkpoint does not advance accepted history. Coordinator
centrally verifies provenance and ancestry before acceptance. Its durable native
wake reads the exact persisted Attempt result after a lost completion or eviction;
Artifacts push notifications and a result Workflow are not required. There is no
second Git control ledger.

Native OpenCode sessions hold conversations. Git is not the sole transcript
store or live-state authority. Evidence capture is bounded; expired/unrecorded
scanner scratch is not recoverable from Git. Structural validation is not independent
security verification. See [legacy Kali evidence](operations/kali-evidence.md).

## Recovery respects uncertainty

![After interruption, inspect durable state and receipts. Known outcomes follow supported recovery; unknown remote mutations retain ownership until reconciliation. Cancellation fences result publication.](../media/recovery.light.png)

An interrupted request does not prove that a scanner stopped. Native recovery
uses recorded state and operation receipts; unknown mutations keep their safety
ownership until reconciled. Captured evidence may finish a data-only checkpoint
while an owner drains, but this does not resume scanning/model work or accept a
result. Purge waits for safe drain. See [operations](operations.md).

Coordinator uses one native Lifecycle job, `pentcloud:recover`, to inspect that
SQLite authority. Admissions persist the wake in the same transaction as the job
record. The job returns a 15-second heartbeat while recovery work is handed to
`trackAlarmWork`; one in-memory promise prevents overlapping recovery passes.
A wake received during a pass remains durable, and a restarted object resumes
from its active receipt. Native memory backoff and the persisted recovery seal
also govern API wakes. Scheduler remains responsible for verification expiry;
startup retires its former recovery schedules through public list/cancel calls.

Run activity uses the native Streams capability with one `activity:v2:<runId>`
log. Synchronous append joins the surrounding admission/phase transaction;
writers are opened before that transaction and authority is rechecked afterward.
Legacy `native_activity` rows are imported lazily for only the requested run,
in global-ID order, with deletion and native append in one atomic transaction.
Untouched runs retain their original rows. There is no second active event store.

The authenticated workflow-events URL requires `?protocol=2`. Native SSE owns
zero-based per-run sequence IDs, replay, heartbeats, cancellation and reconnect
via `Last-Event-ID`; the previous global cursor URL returns 410 for native runs
and requires a UI reload. The timeline consumes default message frames and waits
for `up-to-date` before treating a replayed terminal event as current. Revisions
emit a new run-start boundary. Clients can close at completion; the durable
stream remains open until permanent purge, whose public writer discard/commit
atomically removes history with the run tombstone and records.

## Source is context, not the work repository

![A source repository is pinned per run and read through bounded tools. The agent writes assessment work into a separate run repository.](../media/source-context.light.png)

Attach existing Artifacts source or import public GitHub source. Per-run pins
freeze exact commits. Read tools cannot push source changes, follow symlinks or
silently switch repositories. Private GitHub requires an Artifacts copy; an
existing Workers/Pages connection alone is not a source-access grant. Imported
source is untrusted context, and attachment does not prove full source coverage.
See [source context](operations/source-context.md).

## Findings connect the investigation to the report

![Reporter reviews recorded same-run work and writes an assessment and findings index. Findings are grouped by saved target and link to status, reproduction, evidence and report exports.](../media/findings.light.png)

The reporter can inspect terminal work, native conversation history, tool results,
remote-operation receipts, accepted Git files and verified evidence. It must
reconcile contradictions and disclose gaps. Findings from retained runs are
grouped by saved target ID; cross-run observations are not automatically merged.
Archived runs are included, Trash/purging runs are excluded. Each immutable
assessment remains separately selectable. See [findings](operations/findings.md).

## Your account, with explicit external services

![Operators enter through Access. Runtime, Git, session state, secret bindings and tools are in the deployer's Cloudflare account. Model prompts/context go to OpenCode/providers; test traffic reaches the authorized target.](../media/ownership.light.png)

One installation belongs to an owner or trusted team; admitted operators share
its data. Fresh installs start empty. OpenCode workspace keys use Cloudflare
bindings; configured BYOK provider keys stay in OpenCode. Prompts/context go to
configured external services. Targets/exclusions are guidance, not universal
host confinement. Professionals must configure engagement egress; no anonymity
or dedicated source-IP guarantee is provided. See
[authentication](operations/authentication.md), [hosted UI](operations/hosted-ui.md)
and the [network and data risks](../SECURITY.md#network-and-data-risks).

## Installation

Use the native Deploy to Cloudflare button, then open the app's `/setup` wizard.
Cloudflare and model providers have their own charges. Follow [deployment](deployment.md) and
[installation limits](../README.md#know-the-boundaries).

## Diagram sources

The [visual asset guide](../media/README.md) contains rendering instructions,
editable sources, font notices and the public interactive tour.
