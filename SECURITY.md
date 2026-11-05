# Security

PentCloud is a self-hosted preview for systems you own or are explicitly
authorized to assess. Operators admitted to one installation share its runs,
files, credentials and settings. Use separate installations when isolation is
required.

## Credentials and access

Cloudflare Access protects the app. The Worker verifies signed Access tokens,
including issuer, audience and expiry, and checks browser origins for mutations
and WebSockets. The toolbox gateway is reached through a private service binding;
its public HTTP handler returns 404. Runtime Workers have model/tool capabilities,
not Cloudflare account-administration API credentials.

The installer uses your selected account, its own Access policy and short-lived
deployment authorization. It revokes issued deployment leases on normal exit;
an interrupted process may leave one valid until expiry. Keep installation state
outside Git and reconcile interrupted operations before repeating mutations.
Checked-in Wrangler examples contain no trusted Access issuer or audience.

Store OpenCode workspace keys in Cloudflare Worker Secrets or supported Secrets
Store bindings. Optional BYOK provider keys stay in OpenCode. Target API keys
have a separate server-side, audience-bound path. Never put keys in source,
prompts, uploaded files, command arguments or public issue reports.
See [authentication](docs/operations/authentication.md).

## Network and data risks

A saved target alone is not a network firewall. Optional managed target settings
add HTTP/HTTPS restrictions described below. PentCloud does not provide universal
IP/CIDR confinement, DNS pinning, protocol isolation or program-rule enforcement.

- Every agent role can use cloud Chromium. Managed targets configure native
  Browser Run hostname guardrails and trusted interception for origin/path,
  exclusions, redirects and required headers, including popup requests. Hostname
  guardrails persist on the session; losing the trusted interception connection
  retires the managed browser and invalidates its controls. Detailed interception
  still depends on a live trusted Worker connection; this is not a promise of
  independent browser-wide path isolation after a platform failure. Browser WebSockets are disabled.
  Plain targets without managed settings retain broader browser reach.
- Coder, Maintenance and Pentester use shared Kali with direct Internet access.
  Scope is not enforced at its network layer. Browser headers and login state do
  not automatically apply to stock scanners. Operators must configure engagement
  egress and ensure agents respect program rules and rate limits.
- The Worker shell supports fetch-backed HTTP(S) curl. Its JavaScript execution
  backend has no network, but that restriction does not apply to the browser,
  curl or Kali tools.
- Managed curl, API and retrieval routes check URLs, paths and redirects. Saved API keys
  are bound to their configured audience/path. These checks do not provide
  engagement-wide host confinement or DNS/IP pinning.
- Public catalog revisions can be incomplete or stale. Program instructions,
  request rates, forbidden testing methods, data handling and authorization must
  still be reviewed by the operator. Importing scope does not enforce those rules.
- Prompts, research queries, selected files and tool content may be sent to
  OpenCode, configured model providers, research services and Cloudflare
  conversion/audit services. Review each provider's data terms before use.
- Files, source, pages and tool results are untrusted inputs that may influence
  later actions. Known-secret redaction is not comprehensive data-loss prevention.
  Secrets entered into ordinary content may be transmitted by the tools.
- Operation receipts and sampled logs are not a complete packet/network ledger.
  Cancellation does not establish that a remote process stopped immediately.

Only provide credentials and access intended for these capabilities.
Professionals must configure engagement egress, outbound routing, source IPs,
allowlisting, proxies and private-network access. PentCloud provides no dedicated
scan IP or anonymity guarantee. Cloudflare can see operator connections; sites
opened directly on the operator's device can see that device's IP.
See [hosted UI privacy](docs/operations/hosted-ui.md).

## Results, deletion and costs

AI findings and reports require review. Structural validation of evidence and
report files does not independently prove a vulnerability or complete coverage.
Evidence capture is bounded; unrecorded or expired Kali scratch is not recoverable.

Permanent run deletion removes owned PentCloud data after safe drain. It does
not reset the target or erase independent logs, backups and exports. Unknown
scanner outcomes remain fenced until reconciled. Account usage alerts are not
a hard spending cap; Cloudflare and model-provider charges are separate.

This preview has not been independently security-certified. Local fixture tests
do not establish live installation, inference, scanner or end-to-end privacy
acceptance for your account.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting when available. If it is unavailable,
open an issue asking for a private contact channel without including sensitive
details. Never publish real credentials, private targets, transcripts or exploit
evidence in an issue.
