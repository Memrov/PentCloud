# Kali files and durable evidence

Kali-capable agents (coder, maintenance and pentester) use the existing private
ToolboxGateway to move files between Computer Workspace and the unchanged stock
Container. Transfers use the private service binding; the Container is shared across agents.
The Coordinator remains the sole admission and accepted-main authority.

Selected materials are copied before inference to
`/work/pentcloud/<run>/<attempt>/inputs/`. Each import verifies exact size and
SHA-256 and creates the destination atomically. Identical retries reuse those
bytes; conflicting content fails. Additional files use `pentcloud_kali_import`.
The returned absolute path can be passed to existing stock tools. File operations
require the current generation and never silently start a replacement Container.

`pentcloud_kali_files` lists the attempt's files, or stock output correlated to a
known `scan_id`, including the stock eight-character IDs. `pentcloud_kali_export` captures a selected file. Stock outputs
must belong to a recorded operation or be explicitly identified in that
operation's result. Absolute paths outside the supported output roots, traversal,
symlinks and nonregular files are rejected. These transfer restrictions do not
confine the network access of stock tools; see the [network risk disclosure](../../SECURITY.md#network-and-data-risks).

Tool results and supported screenshots are captured automatically. Known completed
scanner output can be collected from its existing result/output files; collection
never launches another scan. Bounds are 2 MiB per file, 64 files and 16 MiB total
per attempt. Oversize, missing, deleted or generation-lost output is recorded as
incomplete. Existing tool receipts/conversations remain available. This is bounded
evidence retention, not a claim that every scanner's scratch directory is archived.
The stock live Tshark helper deletes its temporary capture after returning its
preview, so that helper cannot yield a retained pcap through this bridge.

Captured files and `manifest.json` live under the existing per-run Git path
`.pentagi/evidence/<attempt>/`. A manifest records attempt/run, immutable input,
prompt digest, tool receipt, generation, source path, size and SHA-256. Redacted
UTF-8 exports retain separate source and stored hashes when they differ. Git
credentials never enter Kali. Run evidence never enters application source or
the GitHub source mirror.

Evidence commits use the existing `attempts/<id>` branch. They are data checkpoints,
not terminal results: they cannot accept a job or advance main. The Coordinator
checks their lineage, own-only tree delta and file hashes. Terminal publication
uses the latest checkpoint as its parent and cannot alter captured bytes. Lost
push replies retry the same commit. Native OpenCode/Lifecycle recovery retains
the same prepared workspace and initial operation ID; no per-attempt Workflow
or second recovery ledger is added.

Existing authenticated Files/download routes recognize verified checkpoint refs,
including failed/interrupted jobs. Every agent can use `pentcloud_read_evidence`
for exact same-run job/path references supplied in context; binary files remain
downloadable. The file list retains its existing 128-entry limit. A checkpoint
whose bytes were already captured can finish/retry while the original owner
drains after failure or cancellation. This data-only repair never accepts main,
resumes a model/scanner or restarts the run. Drain/purge waits for the checkpoint
receipt. Until its push succeeds, a local file is not a durable remote checkpoint.

If a model stops without its original role result, the same session gets one
idempotent finalization operation to submit existing work and disclose incomplete
coverage. It cannot execute code, browse, delegate or start scanner mutations.
Unknown remote outcomes retain their existing ownership/reconciliation fence.
Durable Coordinator recovery reads the exact persisted Attempt result without
requiring an Artifacts push notification or completion acknowledgement.

Saved API credentials continue through `pentcloud_api_request`, injected by the
Worker for the selected API audience with redirects disabled. No blanket secret
forwarding to scanner headers, cookies or browser storage is added. The stock
FFUF/SQLMap knobs exist, but their end-to-end credential/redirect/session behavior
is not established by a file bridge; use a specific supported adapter when a real
workflow requires it.

Native `web_search` returns sources; the specialist synthesizes answer/research/
exploit assessments. Unsupported exploit-type and date/CVSS sorting selectors
fail explicitly. Kali-capable roles already have stock Searchsploit; no additional
provider fleet or exploit UI is needed. Original upstream schemas/prompts remain
byte-preserved, with native behavior explained by the adapter.

## HTTP and scanner troubleshooting

Worker `terminal` / `native-shell` supports Cloudflare Computer's opt-in,
fetch-backed HTTP(S) curl. It handles request methods, headers, bodies and
guarded Workspace files; it is not Linux libcurl. Check `curl --help`: `-D` /
`--dump-header` is unsupported. Use `curl --include URL > response.txt` for
headers plus body; `-o` writes the body only. Set the supplied task cwd and an
explicit request timeout. The separate JavaScript backend still has no network.

Stock Kali tools retain the original image, direct Internet access and native
inactivity lifecycle. PentCloud does not install an interception CA or network
scope firewall in Kali. Required browser headers and login cookies are not
implicitly supplied to scanners. Configure engagement egress separately and
review tool arguments and actual coverage. For WhatWeb
baselines use `aggression: stealthy`. Check `http_status`, errors and actual
coverage rather than treating a completed envelope as a successful request. For FFUF, import a small explicit
wordlist, set threads/rate within the engagement budget, and compare a known
path with a unique missing path. A SPA may return HTTP 200 for both; use the
observed catch-all size filter. Per-request timeout is not total scan duration.
Never retry an unknown scanner operation merely because the caller timed out.
