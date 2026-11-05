# Agent conversations and reports

The chat UI follows Cloudflare’s [Agents Starter](https://github.com/cloudflare/agents-starter/tree/4ea6a72cbabe2b62a66294214361ac106b4a247e)
Kumo/Streamdown presentation. Kumo owns the sidebar, input, buttons, tool and
reasoning disclosures, notices, session question fields and usage disclosure.
The native `agents/harness/opencode` integration owns execution and
conversation data.
[Attribution](../third-party-notices.md#cloudflare-agents-starter-chat-ui) records
the upstream source and license.

 Select a run, then an agent conversation
in the sidebar. Each native logical thread has one entry. Independent Searcher
tasks display Searcher 1, Searcher 2, etc.; retries remain within the same entry
and its attempt tabs. Numbers use the Coordinator's existing admission order, not
the browser's arrival order. A lone role has no suffix. Independent primary
sessions are conversations too; there is no additional Main chat or transcript store.

Sidebar conversation entries show only the agent name and any duplicate-role
number. Task descriptions and agent status stay inside the selected chat.

Conversation URLs include the run and selected attempt. Reload and Back/Forward
retain that selection. Kumo Sidebar handles mobile navigation, its close control,
keyboard dismissal and scroll behavior. Attempt history uses Kumo Tabs.
The Dashboard button above chats opens findings, targets, settings and run
management; lifecycle filtering is in the dashboard. See [dashboard and findings](findings.md). Opening a conversation does not start or resume execution.

Active conversations use OpenCodeHarness `session.events()` snapshots and live
events, including incremental text. Reconnect rebuilds the browser view from the native snapshot;
settled conversations retain finite durable-log replay. The SDK owns the host
lease and live subscription; disconnect and purge stop it. Native history/inbox
records preserve queued operator messages and tool evidence omitted from the
normalized event. No second transcript store is introduced.

OpenCode's current snapshot does not persist unfinished token prefixes or expose
a replay offset for them. For a text/reasoning span already present at attachment,
the adapter waits for its complete native end event instead of appending an
ambiguous suffix. Previously displayed safe prose stays visible on reconnect;
new spans stream normally. This also prevents overlapping snapshot events from
duplicating prose or bypassing redaction. Reconnecting in the middle of a span
can therefore pause incremental updates for that span until it completes.

Assistant model steps render as one continuous response until the next operator
message. The saved customer objective appears once; generated launch and finalization
instructions stay in Activity without changing the underlying native transcript. Streamdown's installed animation and caret apply only to current live
text. One compact **Activity** disclosure shows the current tool/working label;
expand it for tool inputs, outputs, screenshots and reasoning. Tool-only steps
show actual activity rather than invented assistant prose. Existing secret
redaction also covers values split across streaming chunks.

**Conversation details** holds model, task, connection and attempt history.
**Run details** in the dashboard holds identifiers and lifecycle management. Stop remains available
on the chat header, and setup/discovery retains a visible Stop run control.
Native questions, attachments, usage and report access retain their existing APIs.
Question choices use Kumo Select, free text uses Input/InputArea, and external
step acknowledgements use Checkbox. Required fields, conditional answers and
custom choices keep their native OpenCode schema behavior. The theme control is
available in the chat header on desktop and phone.

Status comes from native job/session state. Queued agents have not started;
waiting agents have handed work off. A waiting chat offers a link to the active
conversation where available. An ended session may be reconciling its result;
completion still requires the Coordinator's accepted state. Real errors remain
visible. Tool input/output and agent instructions/reasoning use the collapsed Kumo
Activity section, preserving the audit details without filling the chat with raw JSON.
No extra model calls, heartbeat poller or Kali status polling is involved.

OpenCode's native host closes when idle and reopens over the same SQLite tables.
Settled/cancelled chats reopen without a configured model provider or model-key
lookup. They can read retained messages/events/usage; execution and reply fences
remain in force. Reading an old chat must not require a new run or scanner boot.
The local `sdk-terminal-cold` Workers regression checks retained history after a
host close, finite event replay, zero credential/model/Kali calls and denied steering.

## Chat controls and attention

Code blocks and tables use Streamdown’s built-in copy controls. Block/table
download and fullscreen controls are explicitly disabled; the accepted report’s
Markdown download and native print/PDF actions remain in the report reader.
Code is displayed without syntax highlighting.

Unsent message text is kept in React memory per run and logical agent
conversation, including attempt switches. A successful send clears only the draft
it submitted, so a late response cannot erase a newer draft or another agent’s
text. Purge removes that run’s drafts. Reloading, closing the workspace or a full
navigation to Dashboard discards these memory-only drafts; no browser credential
or message cache is written. Attachment staging keeps its existing behavior.
The composer is labeled **Send message**; native steering and immutable revision
rules are unchanged.

OpenCode `permission_asked` / `permission_replied`, question-tool start/end,
run-end events and reconnect snapshots refresh the existing session-controls
API. Token deltas do not trigger control reads. The existing ten-second fallback
remains for missed events and form persistence races. Confirmed pending requests
show **Needs your answer** beside the observed agent conversation, in the request
area and in the page title. These signals reflect controls read in an opened
conversation; they do not subscribe to or wake every background session. Cached
attention clears on refreshed replies, terminal job state and inactive runs.

A disconnected conversation explains that cloud execution may continue. **Jump
to latest** appears when reading above the bottom. Native ResizeObserver follows
late Markdown/code layout only when the reader is already following new output;
new text must not move someone inspecting earlier messages or files.

Inline chat activity uses Kumo's small Loader so finishing a reasoning/tool step
does not change its row height. Grouped activity keys include the native message
ID as well as the part ID: reasoning ordinals restart inside each message. The
streaming browser fixture checks two such messages, independent disclosures,
stable row height and a console free of duplicate-key warnings at desktop/phone
widths. This is Chromium replay coverage, not real-device Safari certification.

An accepted completed reporter with an immutable output commit adds **Report
ready** to the existing Dashboard button. That link opens Findings for the same
saved or legacy target. Trashed/purging runs do not advertise a ready report.
The chat shows the exact terminal recap when the Coordinator accepted it for the selected attempt and commit. It is labeled **Accepted outcome**; it is not a second report store. A completed attempt without retained prose or recap shows an explicit completion notice instead of an empty-looking response. There is no additional report reader in chat.

Setup uses native Kumo Select/Checkbox/Collapsible; Dashboard/settings links,
notices and controls use Kumo. Findings uses native Pagination. Selection data
stays mounted while findings, target-delete and credential-revoke dialogs close.
Run Trash uses a controlled Kumo dialog; permanent deletion uses Kumo's native
`DeleteResource` block from Recent runs or the run map. It requires the exact
run ID and preserves server-side drain/reconciliation gates. The dialog stays
mounted outside the filtered run list so a move to Trash cannot hide errors.
Print and reduced-motion rules are retained.

## Assessment report

**Full report** in Dashboard Findings appears for a validated canonical report. Older assessments use **Assessment files** instead; **Open report** in the run dashboard remains the general entry for an accepted completed reporter. The reader uses the
existing authenticated file API at that reporter's immutable output commit. The
reporter's result is labeled **Reviewer notes**, separate from the assessment.
A validated findings index supplies its exact report descriptor, including reports
in the reporter’s evidence directory. Otherwise, only a uniquely referenced
existing Markdown output is selected automatically;
otherwise select the assessment file. Inputs, internal records, binary files and
files over 2 MiB are excluded from the reader. The existing file inventory is
bounded to 128 entries; a missing candidate does not establish no deliverable exists.
Use the run's accepted Git files for other formats or large reports.

The reader uses Kumo 2.17 LayerDialog for its sticky heading, scrollable body and mobile sheet, with controlled open state. The reader shows the source path and accepted commit and uses the existing safe
Markdown renderer. Remote images remain inert and external links retain the IP
disclosure gate. **Markdown** downloads the original accepted file. **Print / Save
as PDF** invokes the local browser's native print flow; the print stylesheet
includes the selected report and provenance, excluding other chats and reviewer
notes. Browser/platform PDF availability varies. No Cloudflare PDF runtime,
additional credential, exporter or new storage service is needed.

Reports and captured downloads may include sensitive evidence. Rendering controls
do not redact or sanitize the evidence's meaning. Review it before sharing.

## Verification and troubleshooting

Use [testing](testing.md) for normal gates. The local conversation browser fixture
covers desktop/phone navigation, repeated roles/retries, isolated steering,
Back/Forward/reload, report provenance, blocked remote content and print styles.
Run it with `PENTCLOUD_MATERIALS_BROWSER=1 npm exec --workspace
@pentagi-artifacts/control-plane -- vitest run test/conversations-browser.test.ts`.
It uses local fixtures only, not production scans or paid inference.

`test/streaming-browser.test.ts` uses a real local EventSource connection with
completion frames deliberately withheld. It checks text before completion,
continuous responses across tool steps, reconnect replacement, hidden details,
14px composer text, theme switching, Stop routing and preserved scroll on desktop
and a 390px phone. The conversation fixture additionally verifies required and
conditional OpenCode questions, custom choices, numeric bounds and exact native
permission replies with Kumo controls. Run it with the same
`PENTCLOUD_MATERIALS_BROWSER=1` command and that test filename. Native Workers
fixtures additionally cover stream cleanup, tool screenshot metadata, split
secret redaction and the settled cold-history path without model/Kali requests.

For a wrong chat, inspect the URL's run/job, logical thread and attempt before
retrying. For a missing report, inspect accepted reporter status/outputCommit,
the files at that commit and reviewer notes. Do not rerun the assessment to repair
presentation. See [debugging](debugging.md) for native runtime and Access evidence.

The usability browser fixtures additionally verify clipboard command copying,
table copy-control visibility, draft isolation and late-response protection,
event-driven permission attention, report-ready target links, jump-to-latest and
typed purge confirmation. To run the complete local UI acceptance set, enable
both `PENTCLOUD_MATERIALS_BROWSER=1` and `PENTCLOUD_ONBOARDING_BROWSER=1` and pass
`--no-file-parallelism` to Vitest so fixture Vite servers share the optimizer
cache sequentially. These fixtures never use production models or scanners.

## Layout and run identity

Run navigation and Dashboard use saved target names with the existing creation
time when available. Historical archives without that field use a short run ID;
raw source/run identifiers remain available in details. Agent labels remain
Primary, Searcher 1, Searcher 2 and their existing equivalents.

Target objectives and exclusions use Kumo InputArea label wrappers. Chat uses
native auto-resizing InputArea (two to six rows), with file guidance behind the
attachment help button and usage totals inside Usage. Applicable stop controls
appear while execution is active; the fresh revision composer remains available
under the existing admission rules.

Settings uses the same selected agent state in a mobile Select and desktop role
rail. Runtime diagnostics are disclosed below model/prompt configuration.
Unfinished discovery, setup and analysis runs keep the existing settings lock even
when no specialist is executing; the lock notice links to those runs. The UI
must never unlock settings merely because the active-attempt count is zero.
