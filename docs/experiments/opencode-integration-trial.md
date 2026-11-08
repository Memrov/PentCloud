# PentCloud integration with a full OpenCode server

Recorded 2026-11-08 UTC. Baseline: `79088df632db4f7ecf3677d61d837b710a0438c0`.

The companion [GitHub deep dive](opencode-github-deep-dive.md) compares the two supplied repositories, their original sources and deployment evidence, and other real Cloudflare implementations. It supports the simple full-server hosting pattern used by this experiment while distinguishing it from a legacy protocol emulator.

## Result

**One real PentCloud adviser can execute through the full OpenCode server, publish its result, and have the real Coordinator accept it.** A second run successfully used the existing PentCloud `computer_read` tool through standard MCP. A third run verified cancellation both in PentCloud and in the remote OpenCode session/provider request. All three local scenarios passed their asserted checks in [opencode-integration-local.json](opencode-integration-local.json), recorded at `2026-11-08T05:11:26.130Z`.

The stock CLI listed the same `ses_root` session used by PentCloud. Native history survived client disposal/reopening and a server process restart against the same retained local data directory. This establishes a bounded integration path for a newly created agent whose engine runs in the full server. Existing embedded production sessions have not been migrated.

**The stock web UI also passed on macOS:** password login, project/session selection, the running PentCloud prompt, a completed MCP read, and the final answer were visible with no captured page errors. When left running, the server also accepted an explicit follow-up prompt after the Coordinator completed the job. The user's accepted control for this trial is simple: offer one optional native inspector and stop its dedicated server when it is no longer needed. The Cloudflare Worker uploaded successfully, but an existing Access policy blocked requests before the container could boot; all isolated cloud resources were then removed. The earlier [terminal attachment trial](opencode-terminal-trial.md) records the separate failures when attaching directly to the existing embedded host.

## What changed

The only production runtime change is a protected `createOpenCode(options)` factory in [NativeAttempt](../../apps/control-plane/src/native/attempt.ts): six added lines and two removed lines. Its default implementation still creates the embedded `OpenCodeWorkerd` runtime. Production routing and UI behavior remain unchanged.

The two optional experiment fixtures have their own TypeScript check and are excluded from the application's normal typecheck. This keeps a standard root install independent of the fixture-only MCP 2.4.0 dependency. The [fixture setup instructions](../../apps/control-plane/test/native-opencode-server-probe/README.md) cover its separate install and typecheck.

The application typecheck passed with the fixture's dependency directory temporarily unavailable. After restoring that directory, the separate fixture check passed for both the local and cloud entrypoints. The [typecheck evidence](opencode-fixture-typecheck-isolation.json) records the commands, results, and restoration. The first standalone check exposed missing ambient Worker declarations; the fixture configuration now reuses the application's existing declarations.

The [server probe](../../apps/control-plane/test/native-opencode-server-probe/worker.ts) overrides that factory with the official `@opencode/client`. It supplies the existing harness's `sessions` and `events` aliases and implements client close by aborting outstanding HTTP/event requests. Closing a harness client does not terminate the server process. Its fixture-only `remoteFetch()` hook can be overridden for a private Cloudflare binding; that deployment path is not established by the local results.

The probe subclasses the existing test fixtures around the real [Coordinator](../../apps/control-plane/src/native/coordinator.ts) and NativeAttempt. Production code still claims the job, renders and checks its immutable input, creates the session, waits for generation, produces an adviser result, commits it, validates the candidate, updates the accepted head, and releases the active owner. The fixture run stays in `setup` so completing this adviser does not schedule more agents. Consequently, the successful adviser jobs are `completed` while their enclosing runs remain `running`/`setup`; this is not a complete assessment workflow.

The external model provider and artifact transport are fixtures. Git transport copies actual Git objects and candidate refs between the two real Cloudflare workspaces, leaving the Coordinator's accepted `main` unchanged until production acceptance. Result provenance, commit ancestry, and role/write checks still execute. The model endpoint returns scripted OpenAI-compatible responses, so these results establish protocol/lifecycle behavior rather than model quality or paid-provider compatibility. No target scan was run.

The tool scenario exposes exactly one existing read-only tool using `agents/mcp/server`, MCP server 2.4.0, its original JSON schema, and NativeAttempt's original `callCloudflareTool()` implementation. Active-owner, role, and workspace checks remain in that call path. The fixture restores real harness cancellation because the older probe normally stubs `abort()`.

## Versions and setup

The local run used Linux x64, Wrangler's real workerd harness, Agents 0.33.0, and the unmodified OpenCode CLI/client/SDK 2.2.6. Every server returned version `2.2.6`, and the actual CLI reported `opencode v2.2.6`. [Registry evidence](opencode-latest.json), checked at `2026-11-08T04:39:57.446Z`, records `@latest = 2.2.6` for the four scoped packages: SDK, plugin, client, and CLI.

Each scenario receives a fresh Worker store, server data/config directories, password, and model endpoint. The full server uses the exact rendered `pentcloud-adviser` prompt and main model `opencode-go/deepseek-v4-pro`; its inference base URL points to the scripted provider. Tool permission is limited to the single MCP read in that scenario. The [server helper](../../scripts/lib/opencode-trial-server.mjs) owns process startup, restart, termination, and removal of the temporary directories. The isolated [fixture package](../../apps/control-plane/test/native-opencode-server-probe/package.json) and lockfile add MCP server 2.4.0 without changing shared dependency manifests.

## Verified results

All results below come from the consolidated local JSON and the assertions in [probe-opencode-integration.mjs](../../scripts/probe-opencode-integration.mjs).

| Check | Advice | Workspace tool | Cancellation |
| --- | --- | --- | --- |
| Actual main-model request reached the scripted provider | Pass | Pass | Pass |
| NativeAttempt result | `completed` | `completed` | `interrupted` |
| Coordinator job and active owner | Completed; owner released | Completed; owner released | Interrupted; owner released |
| Real candidate accepted | Accepted head = received candidate = output commit | Accepted head = received candidate = output commit | No output candidate |
| Attempt drained; unresolved remote calls | `true`; 0 | `true`; 0 | `true`; 0 |
| Existing workspace tool result returned to the model | Not requested | `README.md` read returned `baseline` | Not requested |
| Stock CLI lists PentCloud's session | `ses_root` | `ses_root` | `ses_root` |
| Native history unchanged after client disposal/reopening | 4 entries | 5 entries | 4 entries |
| Native history unchanged after server process restart | 4 entries | 5 entries | 4 entries |
| Actual remote cancellation | Not requested | Not requested | Active-session map empty; held provider requests closed before response |
| Captured Worker errors / cleanup errors | None / none | None / none | None / none |

The two accepted output commits are `efc62cb6f21db0decdfe36d05bce192d4e39ee20` for advice and `d63ba6974b93f8ecfd659d178528870bb42f6c8d` for the tool run. Their identities match the corresponding Coordinator accepted head, received candidate, and NativeAttempt output commit in the evidence.

Cancellation is supported by more than an interrupted local status. NativeAttempt persists interruption before awaiting its remote abort, so the runner also requires OpenCode's active map to omit `ses_root` and observes provider connection closure before releasing the held model response. Both checks passed.

## Verified stock browser journey

[opencode-integration-macos-ui.json](opencode-integration-macos-ui.json), recorded at `2026-11-08T05:16:36.704Z` on macOS arm64, passed the tool scenario and both browser assertions. The [shared browser helper](../../scripts/lib/opencode-native-browser.mjs) used OpenCode's own password login, supplied the server address/password, selected `workspace`, and opened the existing trial session. The URL ended in `/session/ses_root`, and the displayed prompt contained PentCloud's actual immutable input context.

Before releasing the scripted model, the page displayed `Working`. After release, the same page showed `Used 1 pentcloud_computer_read` and `PentCloud full-server trial completed: baseline`. Both the running session and completed answer were visible; captured browser page errors were empty. The real Coordinator accepted commit `684460bd1112d412d6c01eca4e8ea9fe23204bb9`, and the run also passed client-detach and server-restart checks. Screenshots preserve the [running state](opencode-integration-ui/opencode-tool-running.png) and [completed tool/answer](opencode-integration-ui/opencode-tool-completed.png).

The earlier Linux Chromium launch failed with `socket() failed: Operation not permitted (1)`, preserved in [opencode-integration-browser-environment.json](opencode-integration-browser-environment.json). The subsequent macOS journey supplies the missing UI validation. Interactive TUI rendering and a dashboard deep link were not tested. All model responses were scripted; no paid inference or target activity was introduced.

## Observed differences and scope

### A running server continues to accept explicit follow-ups

[opencode-integration-completion-boundary.json](opencode-integration-completion-boundary.json), recorded at `2026-11-08T05:21:47.774Z`, tests an authenticated native API prompt after the adviser has completed and its result has been accepted. This probe uses `client.session.prompt()` directly; it does not claim a browser composer click was tested.

| Post-completion observation | Actual value |
| --- | --- |
| Direct prompt accepted | `true` |
| Scripted model executed | `true` |
| Coordinator job | `completed` |
| Coordinator owns execution | `false` |
| Accepted result commit unchanged | `true` |
| Native session history | 4 entries before; 7 afterward |

The extra generation followed the explicit test prompt while the full server remained running. PentCloud's accepted result stayed fixed. NativeAttempt's embedded plugin normally uses the `model.request` hook to call `conversationActive()` and check the active/settled state and selected model. That hook is absent in this remote trial. The MCP read tool still has its own active-state check. See the hook and active-state checks in [NativeAttempt](../../apps/control-plane/src/native/attempt.ts).

The user chose server shutdown as the practical control for the experiment. The intended workflow is to inspect the agent when useful, then stop the dedicated server so it cannot accept more prompts. This does not require adding an admission or recovery policy layer to the trial. The local runner already terminates its server at teardown; the deployed stop-server action is still to be exercised with the Cloudflare trial. This follow-up probe deliberately left the server up, generated only scripted text, and called no tools or targets. Its `directPromptAfterCompletion` object records that native behavior alongside the passing execution checks.

### Recorded work loses remote history

All three native histories contain entries, but PentCloud's existing `recordedWork()` returns `historyAvailable: false` and `messages: []`. Its implementation checks for the local `opencode_session_message` SQLite table before reading history. The remote engine does not populate that local table. The fixture exposes this discrepancy without changing production behavior. It affects the existing reporter path; native history and the stock inspector worked in this trial. See `finished.attempt.history` and `finished.attempt.recordedWork` in the [evidence](opencode-integration-local.json), and `recordedWork()` in [NativeAttempt](../../apps/control-plane/src/native/attempt.ts).

### Native file APIs use a separate filesystem

The full server's `file.read()` returned the deliberately different README stored in its own process workspace. The MCP read returned `baseline` from PentCloud's Durable Object workspace. This proves that the stock server's filesystem and PentCloud's existing workspace are separate. A stock file browser or shell would need a deliberate workspace arrangement; enabling HTTP session access alone does not unify those files. This trial did not exercise a new PTY or synchronize server files back into PentCloud.

### MCP does not carry PentCloud's durable effect identity

The observed MCP request had request ID `2`, metadata `{"progressToken":2,"ai.opencode/sessionID":"ses_root"}`, and arguments `{"path":"README.md"}`. The model tool-call ID, `call_pentcloud_read_trial`, appears in model traffic but is absent from that MCP metadata. The installed OpenCode 2.2.6 implementation at `node_modules/@opencode/core/dist/mcp/client.js` adds the session ID when calling MCP tools; it does not add that model call ID.

The fixture uses the actual transport request ID only for the read-only call, which passed. Scanner/effectful operations, their durable identities, deduplication, and recovery are outside this single-tool trial.

### Auxiliary model traffic occurred

Each scenario also recorded a request to `/v1/responses` with model `gpt-6-luna`, in addition to `deepseek-v4-pro` requests. The evidence labels it non-primary because it lacks the specialist-launch prompt; it does not identify the auxiliary operation's purpose. All requests stayed on the scripted endpoint. This records a difference from the embedded model configuration; no paid inference or cost behavior was tested.

### Existing in-process plugins were not transferred

The remote factory does not serialize or install the plugin objects passed to the embedded factory. The full server starts with `plugins: []`. NativeAttempt's existing plugin closes over Durable Object state, workspace, tool dispatch, Coordinator callbacks, credentials, and recovery logic. Those closures are not transported by creating an HTTP client. Its model transforms are likewise absent remotely. See the plugin/factory definitions in [NativeAttempt](../../apps/control-plane/src/native/attempt.ts) and [opencode-models.ts](../../apps/control-plane/src/native/opencode-models.ts).

The adviser succeeds because production `execute()` already converts a completed nonempty adviser answer into an `advice` result. This trial does not prove remote delegation, general specialist result tools, scanner execution, browser tools, authenticated target access, or full plugin parity. It exposes only one existing tool through standard MCP and uses the original adviser completion path.

## Cloudflare deployment attempt and remaining checks

**Cloudflare host: blocked before container boot.** The isolated `pentcloud-opencode-cloud-trial` Worker uploaded successfully, with Cloudflare reporting a 612 ms startup time. Its native Durable Object-managed container application was created, but the first boot requests were rejected before reaching the Worker. Python received HTTP 403 / error 1010; the normal Node client received a Cloudflare Access HTTP 403 page. The existing application **“Workers dev sessions — Wrangler service token only”** covers `*.vettix-drops.workers.dev` and was created on October 15. Its policy was left unchanged. The [deployment evidence](opencode-cloud-deployment-attempt.json) records the responses, resource IDs, and cleanup results.

The upload itself encountered three tooling limits: the connector could not issue an individual-Worker account token from its OAuth session, its direct input limit was 4 MiB, and its generic fetch could not access the trial workers.dev URL. The existing authorized Cloudflare SQL API allowed the generated bundle to be staged in bounded chunks within the new trial Durable Object, read internally, and uploaded through the normal Worker multipart API. No broader credential or additional service was created. This temporary upload transport did not change the product integration.

Before cleanup, the container application reported **0 active and 0 starting instances**. No cloud OpenCode server, model-provider request, paid inference, or target activity started. The staged bundle was deleted, the trial app and Worker were deleted, and all three new Durable Object namespaces were confirmed absent. Temporary credential files were removed; no temporary API token was ever issued. Cloud runtime behavior, its stock UI, and the deployed stop-server action therefore remain untested. The passing local integration and macOS UI results above remain separate evidence.

Server history survived restarting a local process against the same retained data directory; no Durable Object eviction, host replacement, container filesystem loss, concurrent restart during generation, or durable-volume recovery was tested. Idle client disposal/reopening is also distinct from those recovery scenarios.

The fixture uses one server for one attempt and `ses_root` in a fresh server database. The immediate experiment remains one optional inspector plus a stop-server control. Broader role migration and production session retention are outside this test's scope.

## Documentation used

- [OpenCode JavaScript client](https://opencode.ai/docs/build/client/): supports a network client with a server URL, headers, custom fetch, native session operations, and event subscriptions. This is the public API used by the fixture adapter.
- [OpenCode web and standalone server](https://opencode.ai/docs/cli/web/): documents the shared server behind the web UI/TUI, `serve`, `--server`, and Basic authentication with username `opencode`. The runner uses that server and authentication contract.
- [OpenCode Cloudflare SDK](https://opencode.ai/docs/build/sdk/cloudflare/): describes the embedded workerd profile, Durable Object SQLite/event persistence, and in-process plugin registration. Its outbound-fetch customization does not turn the existing embedded instance into the full server used here.
- [OpenCode server plugins](https://opencode.ai/docs/build/plugins/server/): documents setup, transforms, hooks, and tools executing in the server. The trial uses a remote client and does not transfer PentCloud's existing closure plugins.

These current primary pages were reviewed on 2026-11-08. The pass/fail results above come from the checked-in runtime evidence rather than documentation claims.

## Reproduce

With project dependencies, Node 26, and the separately installed scoped OpenCode CLI 2.2.6:

```sh
npm --prefix apps/control-plane/test/native-opencode-server-probe ci --ignore-scripts --no-audit --no-fund --workspaces=false
node scripts/probe-opencode-integration.mjs --cli /absolute/path/to/opencode-2.2.6 --output docs/experiments/opencode-integration-local.json
```

To reproduce the browser journey and the explicit follow-up observation separately:

```sh
node scripts/probe-opencode-integration.mjs --cli /absolute/path/to/opencode-2.2.6 --scenario tool --browser --screenshots docs/experiments/opencode-integration-ui --output docs/experiments/opencode-integration-macos-ui.json
node scripts/probe-opencode-integration.mjs --cli /absolute/path/to/opencode-2.2.6 --scenario advice --probe-direct-followup --output docs/experiments/opencode-integration-completion-boundary.json
```

The runner supports `--scenario advice`, `--scenario tool`, or `--scenario cancel`. Browser validation requires a working browser environment. The process exits nonzero if a scenario or required assertion fails; the optional direct-follow-up probe separately records behavior while the server remains up. Control-plane TypeScript validation passed after the factory and fixture changes. The runner stops its model/server processes and removes its temporary server directories at teardown.

## Decision supported by this trial

The full server is a workable execution engine for this adviser path, and its stock browser UI displays the agent working through a real existing tool. The small Cloudflare experiment reached deployment, then stopped at the account's existing Access policy before boot. Any resumed cloud test needs access through that policy before it can verify the optional native inspector and server shutdown. The recorded history, filesystem, model, and plugin differences describe what the local trial covers. No additional admission or recovery policy layer is proposed for it.
