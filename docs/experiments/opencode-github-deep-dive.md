# OpenCode on Cloudflare: GitHub findings and the PentCloud trial

Reviewed 2026-11-08 UTC. The latest scoped OpenCode CLI, client, SDK, and plugin verified for this trial are **2.2.6**. See [registry evidence](opencode-latest.json) and the [fresh CLI compatibility check](opencode-do-compatibility.json).

## Decision

**Use a real OpenCode server in a Cloudflare container, expose its stock web UI as an optional agent inspector, and stop that dedicated server when finished.** The repositories support this simple hosting approach. PentCloud does not need to implement an OpenCode protocol emulator or maintain a browser terminal just to inspect the agent's prompt, tool calls, and answer.

Of the two supplied repositories, **`elithrar/opencode-cloudflare-containers` is the useful hosting template**. Its handwritten Worker is 54 lines and forwards requests to the real server. **`jarvisAI-droid/opencode-do` takes a different approach:** it copies an older proof of concept that handwrites the OpenCode protocol around one Workers AI call. The original demo still responds, but the actual latest 2.2.6 client fails its health handshake. That implementation would add protocol maintenance to PentCloud.

Our own bounded integration now demonstrates more than an unrelated OpenCode process: a real PentCloud `NativeAttempt` executes an adviser through the full server, calls the existing workspace read tool over MCP, and publishes a candidate accepted by the real Coordinator. The stock browser UI displays that same session. The cloud Worker uploaded, but the account's existing wildcard Cloudflare Access policy stopped requests before its container booted. All temporary cloud resources were removed. The [integration report](opencode-integration-trial.md) records both the successes and limits.

This is a tested direction for **new attempts using the full server**. It is not a deployed dashboard integration, a migration of existing embedded sessions, or proof that every PentCloud specialist/plugin can move unchanged.

## What was examined

The review followed executable source, manifests and lockfiles, image launch commands, configuration, Git history, and available public deployment records. Read-only HTTP checks and the current CLI were used against the original DO demo. Source availability, a successful deploy workflow, and a working end-to-end agent are reported as separate evidence.

Detailed audits:

- [Elithrar container audit](opencode-containers-audit.md): complete application, dependency implementation, stop/autostart behavior, history, and deployment evidence.
- [OpenCode DO audit](opencode-do-audit.md): original/copy lineage, HTTP/SSE implementation, model loop, SQLite, cancellation, comparison proxy, live compatibility, and static archive inventory.
- [Additional repository findings](opencode-additional-repositories.md): other native web hosts and the current versus historical official Sandbox examples.
- [PentCloud integration results](opencode-integration-trial.md): real Coordinator execution, MCP, cancellation, native browser, follow-up behavior, and cloud attempt.

## 1. Elithrar: a small host for the real server

Reviewed HEAD: [`66980dc776c0f021d6977d96b21a57ff8fc872c3`](https://github.com/elithrar/opencode-cloudflare-containers/tree/66980dc776c0f021d6977d96b21a57ff8fc872c3), September 17, 2025. Four commits, all from that day.

The [Worker](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/src/index.ts) creates a `Container` subclass listening on port 4096, sets a one-hour idle timeout, logs lifecycle events, and forwards every incoming request to a stable singleton. The [Dockerfile](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/Dockerfile) runs the actual `opencode serve --port 4096 --hostname 0.0.0.0` process. There is no handwritten session API, chat frontend, xterm integration, or agent engine in its application.

That is the part to reuse: Cloudflare manages a container and forwards traffic; OpenCode supplies the agent server and clients. The example's README describes the historical TUI attachment flow. Our 2.2.6 browser experiment, rather than that 2025 README, establishes current native web compatibility with the PentCloud trial.

### Details that affect reuse

| Area | Verified implementation | PentCloud implication |
| --- | --- | --- |
| OpenCode version | Globally installs unpinned `opencode-ai` during image build | No recorded original binary version; use our verified scoped 2.2.6 package |
| Container library | Lockfile resolves `@cloudflare/containers` 0.0.19 | Reuse the hosting pattern without adopting its old dependency tree |
| Instance routing | Stable singleton; `max_instances: 1` | Suitable shape for one dedicated trial server |
| Authentication | Bearer middleware is defined but registration is commented out | Retain our server authentication |
| Shutdown | Library has `stop()` and `destroy()`; app exposes neither | One explicit Stop server action is enough for this experiment |
| Automatic restart | Proxy `fetch()` starts a stopped/unhealthy container | Keep the trial's stopped-state response so a refresh does not undo Stop |
| Storage | No volume, R2 mount, backup, or session export | Container shutdown/replacement is not a proven durable-history strategy |
| Agent integration | No Agents SDK, MCP, plugins, or Coordinator wiring | Keep the PentCloud bridge already exercised locally |

The SQLite migration in Wrangler belongs to the container-owning Durable Object. Nothing in this application's source stores OpenCode's session database or Linux files in that SQLite database. The [lockfile](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/package-lock.json), [Wrangler configuration](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/wrangler.jsonc), and committed Containers library substantiate these distinctions; the detailed audit links the lifecycle methods.

The public evidence contains no live URL, Actions run, release, deployment record, or application test. This does not rule out a manual deployment. It establishes a complete minimal hosting example, while independent live deployment remains unverified.

## 2. Jarvis and the original DO project: protocol emulation

Reviewed Jarvis HEAD: [`a5be25daa9c3c0e2146654054618f498c1fcb9c6`](https://github.com/jarvisAI-droid/opencode-do/tree/a5be25daa9c3c0e2146654054618f498c1fcb9c6), October 13, 2026. The underlying application is unchanged from [`southpolesteve/opencode-do` at `8e6dd548c0b39be5be8a9da475bc26aa921b1291`](https://github.com/southpolesteve/opencode-do/tree/8e6dd548c0b39be5be8a9da475bc26aa921b1291), March 13, 2026. The only changes across those commits are a replaced README and an added ZIP.

The [package manifest](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/package.json) has only Hono as a runtime dependency. There is no OpenCode CLI, client, SDK, plugin, agent loop, or container dependency in the Worker. The roughly 1,075-line [application](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts) implements old OpenCode-shaped routes and manually emits events around `env.AI.run("@cf/meta/llama-3.2-3b-instruct", ...)`.

The original [README](https://github.com/southpolesteve/opencode-do/blob/8e6dd548c0b39be5be8a9da475bc26aa921b1291/README.md) describes its proof-of-concept scope clearly: no tools or filesystem, one model, and no response streaming. The browser root is a landing page with attach instructions. A separately installed historical CLI supplies the TUI.

### What the source actually preserves

| Capability | Finding |
| --- | --- |
| Message persistence | Real SQLite rows containing custom message JSON |
| Conversation context | Model request receives a fixed system instruction and current user text; stored prior messages are not passed to it |
| Session listing | Always returns an empty array |
| Session metadata | Synthesized by handlers; create/delete broadcast events without maintaining a durable session catalog |
| Session deletion | Does not delete the saved message rows |
| Events | In-memory SSE writers and manually constructed legacy events; model text arrives after non-streaming inference |
| Tools, files, shell, PTY | No implementation |
| Cancellation | No abort route or model cancellation signal |
| Authentication | No credential validation; wildcard CORS and a 20-requests/hour/IP rate limit |
| Isolation | All sessions share the single DO named `main` |

The source has useful historical examples of matching a terminal client's protocol. Reusing it for latest OpenCode would require maintaining an alternative server implementation and rebuilding behavior PentCloud already has.

### The latest client fails against the original live demo

The read-only check at **2026-11-08 05:52:56 UTC** verified both npm `@opencode/cli@latest` and the executable as **2.2.6**:

| Request/check | Observed result |
| --- | --- |
| `GET /global/health` | HTTP 200; handwritten health version `0.0.4` |
| `GET /api/info` | HTTP 404 |
| `opencode --server <original-demo> session list --format json` | Exit 1: incompatible V2 health response, `UnexpectedStatus: 404` |

The exact origin, command, response bodies, timestamp, and stderr are saved in [opencode-do-compatibility.json](opencode-do-compatibility.json). No model request or session mutation was sent. A successful legacy health response establishes that the endpoint is deployed, not a particular deployed commit or historical TUI compatibility.

The repository's [comparison proxy](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/proxy.ts) also deserves attention: ordinary requests go to local and remote servers for comparison, but the client receives the **local** response. SSE connects only to the local server. A working TUI through that diagnostic proxy does not demonstrate remote compatibility.

### Untrusted archive in the Jarvis copy

The newer Jarvis commits replace the README with Windows installation directions and add `src/do-opencode-1.4.zip`. Static inspection found `Launcher.cmd`, `lua51.exe`, and an approximately 300 KB obfuscated Lua script. The launcher invokes the Lua executable on that script. This is unrelated to the Worker build reviewed above. No archive program was executed, and no claim about its ultimate behavior is made. Use the original project as the historical reference and do not run this archive for the PentCloud experiment. The detailed audit contains hashes and exact commit links.

## 3. Other implementations confirm the full-server approach

The [additional repository audit](opencode-additional-repositories.md) records precise versions, history, and deployment evidence for these examples:

- **`hexamh/opencode-agent`:** real Sandbox-hosted OpenCode with native web and WebSocket forwarding through `createOpencodeServer` and `proxyToOpencode`. Its current reviewed commit has a [successful deployment workflow](https://github.com/hexamh/opencode-agent/actions/runs/23735398760). That establishes a completed deploy job, not a new independent browser or inference test. It uses the older 0.8.0 Sandbox/OpenCode integration.
- **`miantiao-me/cloud-code`:** runs stock `opencode web`, forwards requests to a singleton container, and optionally mounts S3-compatible storage for its workspace and OpenCode directories. It demonstrates a fuller storage arrangement, but we did not verify its durability or a live deployed instance. Its installer is unpinned.
- **Official `cloudflare/sandbox-sdk`:** the historical OpenCode example transparently proxied the native web application. Current source and current documentation have moved toward a headless coding-agent runner; a cached search result showing the old `examples/opencode` path should not be treated as the current example. Neither historical helpers nor the current maintenance-family binary pin establish scoped V2 2.2.6 compatibility.

These projects make the hosting recommendation stronger. They do not require importing Telegram handlers, general cloud-control tools, S3 mounts, a generic shell UI, or a replacement session API into PentCloud's narrow trial.

## 4. Why the current embedded agent remains a different attachment problem

PentCloud currently creates `OpenCodeWorkerd` inside its Durable Object. The full-server projects execute a Linux OpenCode process with a reachable HTTP listener. Hosting that listener is straightforward; exposing the same existing embedded engine requires an exported handler.

The [current official Agents example](https://github.com/cloudflare/agents/blob/5c33d89791d6a00c6ea64cf7790fa753e3e5cbfd/examples/next/harnesses/opencode/README.md) explicitly documents that the CLI cannot attach yet. Two issues were still open when checked:

- [OpenCode #54803](https://github.com/anomalyco/opencode/issues/54803): expose the already-created embedded host's `fetch` handler on the public interface.
- [Cloudflare Agents #2567](https://github.com/cloudflare/agents/issues/2567): add `OpenCodeHarness.fetch` once the upstream field exists.

The SDK's configurable fetch for outbound requests does not publish its inbound application. The Jarvis project does not solve this because it does not instantiate that SDK. The Elithrar project avoids the missing export by running the complete server.

A tiny explicit SDK export patch is technically plausible and would retain the in-process plugins and DO database, but it is not a verified supported solution in this trial. The native UI, authenticated routing, and event-stream lifetime would still need exercising. The recommendation here does not depend on that patch.

### UI choices relevant to the dashboard

| Choice | What it provides | Fit for this request |
| --- | --- | --- |
| Stock OpenCode web UI | Sessions, live activity, tools, and answers from a full server | Preferred optional inspector; already exercised locally |
| Stock OpenCode CLI/TUI | A terminal client connected with current `--server` syntax | Optional operator access; session listing tested, interactive rendering not tested |
| Browser shell terminal | xterm + WebSocket + PTY/tmux in a container | Available Cloudflare building blocks, additional UI plumbing if a real shell is desired |
| Existing Agents chat UI | Application-owned view of embedded session events | Current path; removing it is a separate product change |
| Handwritten legacy OpenCode API | Custom compatibility server, as in `opencode-do` | Adds ongoing protocol and agent-behavior maintenance |

[Current OpenCode documentation](https://opencode.ai/docs/cli/web/) describes its stock web/TUI server and password authentication. [Current Cloudflare terminal documentation](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/) describes an application using xterm, WebSockets, and tmux. Those are distinct interfaces. The native OpenCode web view directly addresses the requested ability to click into an agent and observe its work.

## 5. What worked with PentCloud, and what still differs

The [integration report](opencode-integration-trial.md) and associated raw evidence are the authority for these results:

| Check | Result |
| --- | --- |
| Latest native server used by real adviser execution | Passed on 2.2.6 |
| Real Coordinator acceptance and active-owner release | Passed for advice and workspace-read scenarios |
| Existing `computer_read` over standard MCP | Passed; actual DO workspace content reached the model |
| Cancellation | Passed; Coordinator settled, remote session became inactive, held model connection closed |
| Native browser | Passed on macOS; same session showed prompt, `Working`, tool call, and final answer |
| Client detach/reopen | History preserved |
| Server process restart with retained local directory | History preserved |
| Explicit prompt after Coordinator completion | Accepted while the server remained running; accepted PentCloud result stayed unchanged |
| Cloudflare upload | Succeeded; reported Worker startup 612 ms |
| Cloudflare runtime/UI/Stop | Not reached: existing Access policy rejected requests before container boot |

All inference was scripted. These checks establish protocol, real PentCloud execution/acceptance, and UI behavior; they do not measure paid-model quality or prove a complete assessment workflow. No target scan ran.

Four boundaries matter before broadening this to every agent:

1. **Existing plugins:** in-process plugins close over DO state and tool implementations. A remote HTTP client does not transfer those closures. The successful adviser used its existing plain-text completion path and one exposed read tool.
2. **Recorded work:** the existing reporter checks for the embedded local OpenCode SQLite table, so it currently reports no history for the remote attempt even though native history exists and the inspector displays it.
3. **Workspace:** native file/shell APIs see the full server's Linux workspace. The MCP tool sees PentCloud's actual DO workspace. The experiment deliberately verified that distinction.
4. **Persistence and effectful tools:** retaining a local process's data directory does not test container replacement. Only the read tool was bridged; scanner execution, durable effect identities, recovery, and general specialist results remain outside this trial.

These boundaries should not become extra architecture for the optional-inspector experiment. They identify what has actually been proven and what would need a focused check before a wider migration.

## 6. Smallest product step

Keep the dashboard and make the full-server inspector available for one supported trial agent. Give that agent an **Open agent** action and its dedicated server a **Stop server** action. Use the current official OpenCode client/protocol and the already-tested bridge. Avoid automatically waking a server after an explicit stop.

Cloudflare now recommends its native Durable Object Container API for new applications; the cloud fixture already uses `ctx.container`. That retains the useful Elithrar structure while using current lifecycle controls. See [Cloudflare's current API documentation](https://developers.cloudflare.com/containers/api/durable-object-container/).

The current branch contains the integration fixtures and evidence. Its only production runtime change is a small overridable factory whose default still creates the existing embedded engine. The optional fixtures have separate dependency installation and typechecking, so normal application builds do not require their MCP dependency. No dashboard button or chat removal has been shipped. The temporary cloud deployment was completely removed after the Access failure; no trial server is left running.

The one remaining hosting check is to exercise the same prepared trial through the account's intended authenticated route so requests reach the Worker. There is no need to invent another agent protocol, a new terminal frontend, or a follow-up admission system to establish that result.
