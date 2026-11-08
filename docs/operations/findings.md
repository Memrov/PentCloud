# Dashboard and findings

Open **Dashboard** above the chat list (also visible in the phone header).
Dashboard owns Overview, Findings, Targets and Settings. Chats retain their
existing agent conversations, steering, attachments, live activity and Stop.
Overview has a compact retained/active/archived/Trash run filter and a visible
**Delete run** action on each card. The run map also exposes deletion; its Run
details contains archive, restore and Trash. Deletion removes all PentCloud
data for that run, including its Git history, after exact-ID confirmation and
safe drain. Saved targets and the target application remain unchanged.
Existing lifecycle confirmations and remote-safety fences remain in force.

Findings groups **all retained runs by saved target ID**, not by hostname or
name. Archived runs are included; Trash/purging are excluded. Each target-less
legacy run has its own labeled option. Findings from separate runs remain
separate observations with their source run shown. The table pages 20 rows and
uses the same detail view for one finding or many. Assessment report selects
which immutable reporter result to open; it never combines report versions.
**Full report** opens the indexed canonical document directly. A legacy result
without an index is labeled **Assessment files**, with an explicit file chooser
when reviewer notes do not identify one unambiguous document.

The native Kumo LayerDialog detail reader shows summary, actual evidence/PoC, a detailed Markdown
write-up and source provenance. Evidence links use the existing authenticated
same-run immutable file route. General files remain attached to their runs and
conversations. Remote images stay inert; external links retain the disclosure
confirmation. Markdown and native Print / Save as PDF remain available.

## Reporter access to recorded work

The final reporter writes the fixed-format Markdown assessment and Findings
index. It receives the run objective, all terminal results and verified evidence
references, and can inspect the accepted Git tree directly. Handoff notes guide
review; they are not proof that an action succeeded.

The reporter-only `pentcloud_run_work` tool lists every earlier same-run attempt
when called without `job_id`, including failed/interrupted work. Supply a listed
`job_id` to read its persisted OpenCode full history (including compacted
messages), tool calls/results, durable remote-operation receipts and terminal
record. Responses are JSON text fragments of at most 32,768 characters; use the
returned `nextOffset` with the same job ID to continue. This reuses native history
and existing storage, not a copied transcript ledger. Known model secrets remain
redacted. Another run, the active reporter itself, unsettled source work and
purged state are rejected. Reads do not resume inference, open a browser or boot
a scanner. Discovery/pre-inference failures without a native conversation are marked
`historyAvailable: false` rather than given a synthetic transcript.

Use existing `pentcloud_read_evidence` for captured files, including verified
checkpoints from failed jobs. Accepted Git contains the working reports, source
and request/response files. Binary evidence stays in the existing download/file
paths. Unrecorded or expired scanner scratch cannot be recovered by this reader;
missing evidence and unreviewed coverage must be disclosed. The reporter should
cross-check claims, document disagreements and distinguish confirmed findings
from hypotheses rather than copying an earlier success declaration.

The report format version is preserved through immutable initialization. Missing
or invalid report files reject before terminal intent freezes, allowing the same
reporter to correct files and submit again. A validation failure is not a reason
to repeat scans. Rejected attempts retain their original record. Validation does not automatically
accept a rejected candidate or start another paid reporting attempt.

## Structured reports

New reporter jobs pin `findingsVersion: 1`. Existing guarded filesystem tools
write `.pentagi/evidence/<job>/findings.json` and the Markdown assessment.
Original result tools, schemas and imported prompt bytes are unchanged; the
runtime adds delivery guidance. The JSON v1 object contains `coverage`
(`complete`/`partial`), `summary`, `reportPath`, and `findings`.

Each finding has `id`, `title`, `severity` (critical/high/medium/low/info/unknown),
`status` (suspected/confirmed/inconclusive), an affected HTTPS `target`, `summary`,
`evidence`, detailed Markdown `report`, and `evidencePaths`. IDs are unique within
an index. Cross-run observations are not automatically merged. Verification
status is an assessment conclusion, not proof supplied by structural validation.

The index is bounded to 2 MiB and 1000 findings; at most 2000 distinct file
references are resolved. The Markdown assessment is UTF-8, nonbinary and at most
2 MiB. Bad paths, duplicate IDs, absent files or invalid field values/versions fail
validation. Exact referenced paths bypass the general Files list's 128-entry
limit. This does not remove that older general browsing limit.

Validation occurs before terminal intent freezes and again against the candidate
commit at Coordinator acceptance. Recovery validates committed bytes once a
candidate exists. The runtime binds run/job/commit provenance. Failed reporting
can settle without an index; read-only finalization cannot restart scanning or
invent missing work. No provider or scanner work occurs when opening the dashboard.

Only reporters with the pinned v1 contract are interpreted as structured data.
Arbitrary older files named findings.json do not change legacy acceptance.
Older accepted reports without the pinned contract remain readable. They show
an explicit missing-index notice, not a synthetic zero-findings result. Failed
reads, including the all-runs inventory, are shown as incomplete data; Refresh
retries inventory as well as individual assessments; partial assessment coverage remains distinct
from complete coverage with no findings. The last accepted completed attempt
per reporter thread remains visible if a later retry fails or is still running.

## Troubleshooting and verification

For a missing row, first inspect the saved target ID, retained source runs,
reporter thread/attempt and accepted output commit. Read the exact index path
at that commit; check the reporter's `findingsVersion`, required fields and
referenced files. Do not rerun a scanner to repair presentation. Unpublished
workspace files are not accepted Git evidence. Keep incomplete reporting explicit.
See [debugging](debugging.md) and [legacy Kali evidence](kali-evidence.md).

`test/findings.test.ts` validates the schema and file references; the native
Coordinator/Attempt fixtures exercise immutable reads, legacy behavior, repairable
pre-publication errors and committed version provenance. `test/findings-browser.pw.ts`
uses controlled local target/run data on desktop and 390px phone, including zero/one/thirty findings and exact 20/21-row page boundaries, pagination, target separation, detail/report access and explicit
legacy/error/empty/partial states. Run with
`npm run test:browser -- apps/control-plane/test/findings-browser.pw.ts`.
No production inference or scan is needed for these checks.
