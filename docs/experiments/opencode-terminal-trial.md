# OpenCode terminal attachment trial

Recorded 2026-11-08 UTC. Branch: codex/opencode-terminal-trial.

## Result

The stock OpenCode terminal cannot attach to PentCloud's current embedded agent runtime through a simple HTTP forwarding route. The actual CLI exits at its initial server handshake, before drawing the terminal interface.

After the user supplied the Cloudflare SDK and server-plugin documentation, the experiment also installed the exact documented health handler on the same agent. That handler passes the health handshake, but does not return the session/location data required by stock clients. The real CLI then exits while reading project.id. This confirms the documentation's supported embedded SDK use without establishing a complete terminal attachment.

This was a local compatibility experiment against the production NativeAttempt implementation. It did not deploy a change, replace the dashboard/chat, install a second agent runtime, or build a custom OpenCode protocol adapter. Changes are limited to a test fixture, an opt-in runner, and evidence.

A subsequent standalone-server control did start a separate temporary local OpenCode process, as described below. That control passed and was then stopped; it was not connected to PentCloud's production agents.

## Setup

- PentCloud baseline: b20bc58360621e01a2e6630f6dc83e2e14ee4a05.
- Baseline tree: 3a1a351b87995ef6f3bcd00829d770ee31b5eb21, identical to GitHub main 541ee18ae944e65abae4fd2584663954e23c8978 when checked.
- Agents SDK 0.33.0; OpenCode SDK/client 2.2.6; actual CLI @opencode/cli 2.2.6, verified using its own --version.
- Node 26.12.1 and Wrangler's real local workerd harness.
- Native probes ran on Linux and macOS. The CLI ran on macOS.

Fresh npm registry checks confirmed that @opencode/sdk, @opencode/plugin, @opencode/client, and @opencode/cli ALL resolve @latest to 2.2.6. The experiment therefore uses the latest scoped V2 packages. See opencode-latest.json for timestamp, tags, and integrity values. The older opencode-ai package is a separate version line and was not used for attachment.

The existing ProbeAttempt subclasses PentCloud's real NativeAttempt. The fixture creates a settled attempt and its persisted ses_root session, with one native agent-switched metadata event. No model prompt is submitted. This proves a native session exists for attachment; it is not a production conversation or an agent actively executing work.

The test-only /opencode-attach/terminal-trial/* route selects the SAME Durable Object, removes the prefix, and forwards to its unchanged inherited fetch method. It does not fabricate the HTTP failure or expose a substitute host.

## Observed results

| Check | Actual result | Meaning |
| --- | --- | --- |
| Internal native server.info() | Success | Embedded SDK host starts correctly. |
| Root session and history | ses_root; one agent-switched item; native/harness histories match | A persisted session exists. |
| Public inbound handler | fetch, handler, and server.fetch are undefined | Existing SDK host offers no HTTP passthrough. |
| Stock client GET /api/info | 404, text/plain, Not implemented | Required CLI handshake endpoint is absent. |
| Stock client GET /api/session/ses_root | 404, text/plain, Not implemented | Existing session is unavailable through stock HTTP protocol. |
| Actual OpenCode CLI 2.2.6 | Exit 1, no timeout | Connection fails before TUI initialization. |
| Native PTY list | Success, empty list | No native terminal is present. |
| Native PTY creation | ClientError: UnexpectedStatus: 500 | Requested terminal cannot be created. |
| Native OpenCode file listing | ClientError: UnexpectedStatus: 500 | Stock file browser has no backing filesystem. |
| Native capability declaration | persistentPty: false | Host advertises no persistent PTY. |
| Exact documentation handler: GET /api/info | 200 with correct server information | Documented health example works. |
| Exact documentation handler: session/location requests | 200 with server information instead of session/location | HTTP success does not supply the native endpoint contract. |
| Latest CLI against documentation handler | Exit 1: undefined is not an object (evaluating 'f.project.id') | Passes health, then fails to retrieve project/session context. |

The baseline CLI error was: “did not provide a compatible V2 health response: UnexpectedStatus: 404”. After installing the exact documented health handler, the stock headless command `session list --format json` instead failed with “undefined is not an object (evaluating 'f.project.id')”. Both full outputs are recorded in opencode-terminal-macos.json. The headless command avoids TTY rendering as a possible cause of this second failure.

The embedded health response reports version unknown. Package versions and the CLI's own version are therefore recorded separately; that field is host metadata, not evidence of a version mismatch.

## Documentation and source findings

### HTTP attachment

OpenCode builds an internal host.fetch handler, passes it into its own typed client, and omits it from the returned SDK interface. PentCloud can call session methods in process, but cannot proxy arbitrary stock-client HTTP requests to that hidden handler.

Both upstream requests remain open:

- [OpenCode #54803: expose the embedded server fetch handler](https://github.com/anomalyco/opencode/issues/54803).
- [Cloudflare Agents #2567: OpenCodeHarness HTTP passthrough](https://github.com/cloudflare/agents/issues/2567).

[The pinned SDK source](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/sdk/src/promise.ts) confirms the missing return field. Cloudflare's issue explains why it rejected intercepting OpenCode.make: the workaround depends on the app and SDK resolving the same client module.

The fetch configuration option in [OpenCode's Cloudflare documentation](https://opencode.ai/docs/build/sdk/cloudflare/) controls OUTBOUND model, web, configuration, and MCP requests. It is not an incoming HTTP handler.

The page's example HTTP method serializes server.info() without inspecting the incoming path. Our second test implements that exact behavior through the existing harness, using /opencode-docs-attach/terminal-trial/*. Health works, but requests for sessions and locations receive the same health JSON. The generated client accepts successful JSON without validating each endpoint's full schema; the experiment therefore checks response shape and the expected session identity, not merely HTTP status.

### Server plugins

The user-supplied [server-plugin documentation](https://opencode.ai/docs/build/plugins/server) describes a client context with transforms, hooks, tools, commands, and registrations. PentCloud already follows this API through Plugin.define, setup, agent/tool transforms, session hooks, and the plugins option on OpenCodeWorkerd.create.

The documented HTTP hooks modify outgoing provider traffic. The shell hook edits execution parameters. Neither exposes an incoming request router or supplies a terminal execution backend. Plugin RPC extends an already reachable OpenCode connection. The installed context likewise has no fetch/handler entry point. These APIs do not solve the missing host HTTP passthrough.

### Shell and file browser

[The pinned workerd source](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/server/src/workerd.ts) explicitly replaces native terminal and filesystem services. PTY listing returns an empty array; PTY creation and file listing are unavailable. The observed client-visible 500s agree with those implementations. Internal defect text was not captured in runtime logs.

A remote TUI can render a conversation on the client's own terminal without a server-side PTY. Its first blocker here is HTTP passthrough. A browser shell terminal additionally needs a backed PTY; the native file browser additionally needs filesystem integration.

PentCloud's own workspace read succeeded before and after the native probes. Its workspace/tools do not automatically implement OpenCode's stock filesystem and PTY endpoints.

### Fit with the GitHub implementation

[hexamh/opencode-agent's pinned Worker](https://github.com/hexamh/opencode-agent/blob/685aabc7a016fbeded220b355b72176e8c351579/src/index.ts) starts a full OpenCode server in Cloudflare Sandbox and proxies HTTP/WebSockets to it. PentCloud's existing sessions are owned by OpenCodeWorkerd in Durable Objects. Starting that example alongside PentCloud would create another runtime with different sessions.

The lower-level ServerWorkerd.create() API also builds a new host. It does not wrap the existing SDK host or accept its SDK plugin/instance options. Rebuilding PentCloud around that factory would be an integration change.

## Integrity and scope

During the internal native probes, session metadata, both history representations, workspace contents, and attempt state remained identical. Model-credential reads, provider requests, scanner calls, toolbox initialization, and toolbox readiness calls were all zero.

Those measurements precede the later stock-client/CLI GET requests. The internal host is disposed before those requests, while its session remains in SQLite. The absent HTTP implementation is independent of whether the internal host is open. This experiment did not watch an active production agent.

The CLI uses piped I/O and TERM=dumb. Its explicit health failure occurs before interactive rendering and proves the current connection failure. If a future SDK passes the handshake, a real TTY/browser check is needed; this runner's timeout would not establish future incompatibility.

The documentation handler test reopens the retained host through the existing harness. It neither creates another application graph nor moves the session. Its headless CLI failure occurs after health and before any terminal rendering. No browser UI was served or validated in this experiment.

## Validation

- Control-plane TypeScript check passed.
- Runner JavaScript syntax check and git diff --check passed.
- Real workerd native probes completed on Linux and macOS.
- Matching real CLI attempted attachment, with version, exit status, and error recorded.
- The exact supplied documentation handler was exercised with stock client health/session/location calls and the latest CLI's headless session listing.
- Latest package tags were checked directly against npm, and both supplied documentation pages were reviewed against installed source.
- Independent review confirmed object identity, routing, genuine SDK calls, and evidence scope.

The experiment runner exits successfully when it records results. That does not mean terminal attachment succeeded: inspect operation ok fields and cli.exitCode.

## Reproduce

With the pinned project dependencies and Node 26.12.1:

```sh
node scripts/probe-opencode-terminal.mjs --cli /absolute/path/to/opencode-2.2.6 --output docs/experiments/opencode-terminal-macos.json
```

Omit --cli for native/stock-client probes only. The runner closes its Worker harness and removes temporary CLI configuration directories. The CLI was installed in a separate trial toolchain; project dependency manifests and the existing system OpenCode installation were not changed.

Evidence and code:

- opencode-terminal-local.json: Linux native/stock-client results.
- opencode-terminal-macos.json: macOS results and actual CLI output.
- opencode-latest.json: registry evidence that all four scoped OpenCode packages match latest.
- ../../scripts/probe-opencode-terminal.mjs: opt-in runner.
- ../../apps/control-plane/test/native-attempt-probe/worker.ts: test fixture and forwarding route.

## Decision

The stock terminal is not a working replacement for PentCloud's current UI. For viewing existing agent sessions, the next useful integration point is a supported inbound handler on the existing SDK host, preserving authorization and session ownership. Shell/file-browser support is a separate decision.

The trial does not establish that conversation viewing requires migrating agents to containers. It establishes that the installed released versions cannot provide this drop-in attachment through their public APIs.

## Follow-up: full OpenCode server control

The user supplied [the server documentation](https://docs.opencode.ai/docs/server/). Its API table describes the older endpoint family, while the same serve command is supported by latest V2. The current equivalent is [OpenCode's V2 web documentation](https://opencode.ai/docs/cli/web/), which documents the bundled web UI and standalone server.

Rechecked @opencode/cli@latest against npm: 2.2.6. Started the actual 2.2.6 binary with `serve --hostname 127.0.0.1 --port 0`, temporary configuration/data directories, a temporary password, and no model prompt. The process was stopped and its trial directories removed afterward.

| Standalone control | Observed result |
| --- | --- |
| API health | 200, version 2.2.6, persistentPty true |
| Project/location | 200 with real project metadata |
| Create and read own session | Passed; IDs matched |
| Stock CLI session list | Exit 0; listed the newly created session |
| Native file listing | 200; returned the fixture README.md |
| Native PTY creation | 200; started a harmless printf command |
| PTY cleanup | DELETE returned 204 |
| Bundled web UI root | 200 text/html, 9,162 bytes |
| Read the embedded trial's ses_root | 404 SessionNotFoundError |

This is positive evidence that latest OpenCode's complete server, native APIs, and stock CLI work together. The web-shell check only fetched HTML; no interactive browser journey or model execution was performed. This was a local macOS control, not a Cloudflare container deployment.

The result isolates the architectural difference: the standalone server owns its own application graph and local session database. It does not automatically expose the OpenCodeWorkerd host or sessions held in PentCloud Durable Objects. The [latest CLI startup source](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/cli/src/server-process.ts) confirms that it creates the server process and supplies a database path. No supported serve option accepts the existing embedded host.

The full server is therefore a viable candidate for a deliberate agent-runtime integration experiment. It is not yet a viewer attached to the current production agents. A future trial would need to preserve PentCloud's plugins, tools, model configuration, lifecycle, and session ownership while connecting the dashboard to a full server. None of those integration requirements was claimed as completed here.

Reproduce the independent control with `node scripts/probe-opencode-server.mjs --cli /absolute/path/to/opencode-2.2.6 --output docs/experiments/opencode-server-control.json`. Complete observed output is in opencode-server-control.json.
