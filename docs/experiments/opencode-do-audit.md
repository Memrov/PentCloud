# OpenCode DO repository audit

Audit date: 2026-11-08. This is a read-only source and compatibility investigation for PentCloud's OpenCode UI trial. No PentCloud production code, configuration, dependency, or deployment was changed for this audit.

## Result

`jarvisAI-droid/opencode-do` does not embed the OpenCode SDK or run the full OpenCode server. It implements an older OpenCode-shaped HTTP/SSE API in Hono around a direct Workers AI call. It has no SDK `host.fetch` export or workaround, SDK plugin integration, tool execution loop, filesystem, shell, or PTY to transplant into PentCloud.

The original public demo still responds to its legacy health route, but the actual latest scoped OpenCode CLI rejects it. The fresh registry check, binary version, HTTP responses, exact CLI command, exit code, stdout, and stderr are preserved in [opencode-do-compatibility.json](./opencode-do-compatibility.json). Only read requests were made; no prompt, inference request, or session mutation was sent.

The inspected clone is `/workspace/scratch/1806b56d5949/research-opencode-do`. The entire tracked tree and Git history were inspected, including both handwritten application TypeScript files, package files, Wrangler configuration, and the ZIP's inventory and bytes. No archive program was executed.

## 1. Pinned repositories and lineage

| Item | Verified result |
| --- | --- |
| User-supplied repository | `jarvisAI-droid/opencode-do` |
| Default branch | `main` |
| Latest Jarvis commit at inspection | `a5be25daa9c3c0e2146654054618f498c1fcb9c6` |
| Latest Jarvis commit time | 2026-10-13T07:00:22Z |
| Latest commit's actual change | Adds `src/do-opencode-1.4.zip`; no application source change |
| Preceding Jarvis commit | `0ed92d653637b14c2015996204d07eca4a836ed2` |
| Preceding commit's actual change | Replaces the README with Windows download/install instructions |
| Original repository | `southpolesteve/opencode-do` |
| Original default branch | `main` |
| Original latest commit at inspection | `8e6dd548c0b39be5be8a9da475bc26aa921b1291` |
| Original latest commit time | 2026-03-13T17:45:47Z |
| Original attribution | Package author is Steve Faulkner; the application's homepage links `southpolesteve/opencode-do` |

Running this source comparison produced only a modified README and an added ZIP:

```sh
git diff --name-status \
  8e6dd548c0b39be5be8a9da475bc26aa921b1291 \
  a5be25daa9c3c0e2146654054618f498c1fcb9c6
```

```text
M  README.md
A  src/do-opencode-1.4.zip
```

The deployed application's `src/index.ts`, the comparison `proxy.ts`, `package.json`, `package-lock.json`, and `wrangler.jsonc` are therefore unchanged from the original March commit. GitHub does not mark the Jarvis repository as a fork, but the shared Git history and unchanged source establish this lineage.

Primary sources:

- [Jarvis pinned tree](https://github.com/jarvisAI-droid/opencode-do/tree/a5be25daa9c3c0e2146654054618f498c1fcb9c6)
- [Jarvis ZIP-adding commit](https://github.com/jarvisAI-droid/opencode-do/commit/a5be25daa9c3c0e2146654054618f498c1fcb9c6)
- [Jarvis README replacement](https://github.com/jarvisAI-droid/opencode-do/commit/0ed92d653637b14c2015996204d07eca4a836ed2)
- [Original pinned tree](https://github.com/southpolesteve/opencode-do/tree/8e6dd548c0b39be5be8a9da475bc26aa921b1291)
- [Original README](https://github.com/southpolesteve/opencode-do/blob/8e6dd548c0b39be5be8a9da475bc26aa921b1291/README.md)
- [Homepage's original-repository link](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L796-L805)

## 2. Dependency versions and runtime identity

The only runtime dependency is Hono. The lockfile resolves:

| Package | Declared range | Resolved version |
| --- | --- | --- |
| `hono` | `^4.7.10` | `4.12.7` |
| `typescript` | `^5.8.2` | `5.9.3` |
| `wrangler` | `^4.73.0` | `4.73.0` |
| Cloudflare workerd platform packages | Transitive | `1.20260312.1` |
| `@cloudflare/workers-types` | Transitive | `4.20260313.1` |

There is no `@opencode/sdk`, `@opencode/client`, `@opencode/plugin`, `@opencode/cli`, maintenance-family `opencode-ai`, or Cloudflare `agents` dependency. There is no Dockerfile, container image, or OpenCode server binary in the Worker project. The optional developer comparison proxy requires Bun but does not pin an OpenCode client/server version.

The application returns `version: "0.0.4"` from its health handler and `version: "1.0.0"` in synthetic session metadata. Those are handwritten strings, not resolved OpenCode package versions. The repository therefore does not establish a specific historical CLI version with which its implementation was tested.

Sources: [package manifest](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/package.json), [lockfile](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/package-lock.json), [health string](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L817-L820), [session strings](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L936-L977).

Wrangler binds Workers AI as `AI` and creates one SQLite Durable Object class, `SessionDO`, using `new_sqlite_classes`. The configured compatibility date is `2025-03-13`, with `nodejs_compat`. No Agents SDK or OpenCode SDK initialization occurs. [Wrangler configuration](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/wrangler.jsonc)

## 3. HTTP, UI, model, and terminal behavior

The approximately 1,075-line `src/index.ts` contains the complete handwritten Worker/DO implementation.

| Area | Source behavior | Implication for PentCloud |
| --- | --- | --- |
| TUI | An externally installed legacy OpenCode CLI uses `opencode attach <url>` | No reusable terminal widget or hosted terminal process |
| Browser | `/` returns a themed HTML landing page with attach instructions | No bundled native OpenCode browser app |
| Health | `GET /global/health` returns a fixed JSON object | Does not implement V2 `/api/info` |
| Bootstrap | `/config`, `/provider`, `/agent`, `/command`, and related routes return handwritten data | This is protocol emulation, not native API passthrough |
| Events | `/event` emits manually assembled legacy SSE messages | Not the SDK's actual event log or subscription handler |
| Prompt | `/session/:id/prompt_async` is rewritten to the same `/message` handler | The nominal asynchronous route still awaits the handler's model call |
| Inference | Calls `env.AI.run("@cf/meta/llama-3.2-3b-instruct", ...)` | No OpenCode agent engine |
| Model context | Includes a fixed system instruction plus the current user text | Persisted prior messages are not supplied as conversational context |
| Tools | No execution loop, plugin registration, or tool dispatch | Existing PentCloud tools would have to be integrated separately |
| Files/shell/PTY | No implementations | No managed shell terminal or existing workspace access |
| Workspace/VCS | Hardcoded paths, branch name, and empty lists | Does not expose a real repository or workspace |

The model response is obtained non-streaming, after which the code emits message and step events. It does not stream generated tokens. Although the provider capability object claims `toolcall: true`, the inference call does not provide tools, and there is no tool-call execution loop. The original README explicitly identifies no tools, no filesystem, one model, and no streaming as proof-of-concept limitations.

Sources:

- [Imports and model/provider stubs](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L1-L129)
- [Direct Workers AI call, with current-message-only context](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L516-L529)
- [Response events emitted after inference](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L531-L654)
- [HTML homepage](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L726-L805)
- [Bootstrap and placeholder routes](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L817-L925)
- [Prompt route rewriting](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L1029-L1048)

## 4. SQLite persistence and session semantics

There is real SQLite persistence, but it is a custom message store rather than OpenCode's database. The schema contains `messages` and `rate_limits`; the message table stores serialized message objects. A user message and an empty assistant placeholder are inserted before inference; the assistant row is updated when inference returns.

All requests use `env.SESSION.idFromName("main")`. Sessions are not isolated into separate DO instances. The public handlers have these limitations:

- `GET /session` always returns `[]`.
- `GET /session/:id` synthesizes metadata, including current timestamps, without a stored-session lookup.
- `POST /session` returns and broadcasts metadata but does not persist it or call `SessionDO.createSession()`.
- `DELETE /session/:id` broadcasts a deletion event and returns success without deleting message rows.
- `POST /session/:id/fork` returns a generated ID and metadata without copying message history.
- `SessionDO` has an in-memory sessions map and helper methods, but the public session routes do not use them.
- `GET /session/:id/message` retrieves message rows by session ID. Its default limit is 100, ordered oldest first.

SQLite provides a basis for persistent message rows, but no eviction/recovery test was run here. The code contains no durable execution claim, interrupted model-call recovery, alarm-based resume mechanism, or native OpenCode session recovery. A partially completed assistant placeholder can be written before inference; no source path was found that resumes such a placeholder after a host loss.

Sources: [schema and reads](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L168-L250), [pre-inference inserts](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L390-L499), [completed response update](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L579-L624), [in-memory session helpers](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L688-L709), [single named DO](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L807-L811), [public session handlers](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L931-L1023).

## 5. Events, cancellation, and authentication

The SSE implementation keeps response writers in an in-memory `Set` and sends a keep-alive every 15 seconds. Events are broadcast to every current writer in the shared DO. There is no authenticated subscriber identity, per-session subscription filter, replay cursor, or persisted event log. Disconnection cleanup is driven by failed stream writes/pings; this is not a hibernating WebSocket implementation. The original README's broader hibernation wording was not independently verified by an eviction experiment.

There is no model cancellation/abort route or model-call `AbortSignal`. The permission and question reply endpoints unconditionally return success. There is no authentication middleware or credential validation. CORS permits `*`; listing `Authorization` as an allowed header does not authenticate it. The concrete admission control is a persistent IP rate counter allowing 20 model requests per hour.

These findings describe this demo's scope. They do not require adding a control system to PentCloud's simple UI experiment. They mean that this implementation does not preserve PentCloud's existing tool callbacks, ownership checks, or abort behavior by itself.

Sources: [SSE and broadcasting](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L252-L310), [rate limiting](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L313-L376), [CORS](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L717-L724), [permission/question placeholders](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/index.ts#L1051-L1072).

## 6. Why the comparison proxy does not prove remote compatibility

`proxy.ts` is a Bun development comparison tool. It forwards ordinary requests to both a local OpenCode server and the remote Worker and logs differences. It always returns the local server's response. Its SSE path connects only to the local server.

A working TUI when attached to this proxy therefore does not prove that the remote Worker is providing the working behavior. The proxy also duplicates non-read requests to both targets, so it was not used for this read-only audit.

Sources: [proxy purpose and targets](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/proxy.ts#L1-L25), [local-only SSE](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/proxy.ts#L119-L139), [parallel requests](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/proxy.ts#L142-L196), [returning the local response](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/proxy.ts#L244-L252).

## 7. Deployment evidence and latest 2.2.6 compatibility

Public GitHub records checked during this audit:

| Repository | Public Actions runs | Releases / issues / PRs |
| --- | --- | --- |
| `jarvisAI-droid/opencode-do` | 0 | Releases empty; PR list empty; issues disabled |
| `southpolesteve/opencode-do` | 0 | Issue list empty |

No Actions workflow is present in the inspected tracked tree. These observations do not prove that deployment never occurred. The GitHub deployments endpoint was not available through the connector used, so no conclusion is drawn about deployment records.

The original README names `https://opencode-do.southpolesteve.workers.dev` as its demo. The following live results were reproduced and saved in the adjacent JSON artifact:

| Check | Actual result |
| --- | --- |
| npm `@opencode/cli@latest` | `2.2.6` |
| Installed CLI `--version` | `opencode v2.2.6`, exit 0 |
| `GET /global/health` | HTTP 200, `{"healthy":true,"version":"0.0.4"}` |
| `GET /api/info` | HTTP 404, `404 Not Found` |
| Latest CLI remote session list | Exit 1, incompatible V2 health response |

Exact read-only command:

```sh
opencode --server https://opencode-do.southpolesteve.workers.dev \
  session list --format json
```

Exact stderr:

```text
Server at https://opencode-do.southpolesteve.workers.dev did not provide a compatible V2 health response: UnexpectedStatus: 404
```

The CLI ran with isolated temporary config/data/state/cache locations and project configuration disabled. No user credential values or environment values are included in the evidence artifact. The health/list checks sent no model prompts and performed no session mutations. The original legacy client was not installed or run, in keeping with the instruction to use the latest scoped OpenCode version.

The responding legacy health route establishes that a matching public endpoint is deployed. It does not independently establish the deployed commit SHA, historical TUI compatibility, model inference, session recovery, or cancellation behavior.

Sources: [original demo documentation](https://github.com/southpolesteve/opencode-do/blob/8e6dd548c0b39be5be8a9da475bc26aa921b1291/README.md), [Jarvis Actions](https://github.com/jarvisAI-droid/opencode-do/actions), [Jarvis releases](https://github.com/jarvisAI-droid/opencode-do/releases), [original Actions](https://github.com/southpolesteve/opencode-do/actions), [latest package metadata](https://registry.npmjs.org/@opencode/cli/latest), [saved compatibility evidence](./opencode-do-compatibility.json).

## 8. ZIP inventory and hashes: static inspection only

The Jarvis-only `src/do-opencode-1.4.zip` is 580,808 bytes. Its SHA-256 is:

```text
8460a019c1268750731b75b4627906eb80dc080795a72af83902e0dd76f2ddae
```

The ZIP contains three unencrypted entries:

| Entry | Uncompressed bytes | Compressed bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `Launcher.cmd` | 26 | 28 | `d71cdcdd390fb300904a7fdc31d56c0a3a728350eca2debf3d00d7932dc14839` |
| `lua51.exe` | 872448 | 437898 | `3ee51b5f9579b775e87edb23c238650a512c2fe46efc06694cd906a771727f97` |
| `rest.txt` | 299679 | 142574 | `58448cb79f50cf71408e7eabfe7e0718e77a09910fd59963f83840b67faa245f` |

The complete launcher text is:

```bat
start lua51.exe rest.txt
```

`lua51.exe` has a Windows PE executable header. `rest.txt` contains heavily obfuscated Lua code. The archive contains no TypeScript Worker source, Wrangler configuration, OpenCode dependency manifest, or native OpenCode UI bundle. The current README's Windows installer instructions are not corroborated by any release entry or project build script.

This is a static inventory and provenance finding, **not a behavioral malware determination**. Neither the launcher, executable, nor Lua program was run. Their eventual behavior was not established. The archive is unrelated to the demonstrated TypeScript deployment path and is unnecessary for the source-based compatibility investigation.

Sources: [ZIP-adding commit](https://github.com/jarvisAI-droid/opencode-do/commit/a5be25daa9c3c0e2146654054618f498c1fcb9c6), [pinned archive entry](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/src/do-opencode-1.4.zip), [current README](https://github.com/jarvisAI-droid/opencode-do/blob/a5be25daa9c3c0e2146654054618f498c1fcb9c6/README.md).

## 9. Comparison with PentCloud and smallest reuse path

The current PentCloud trial checkout pins `agents@0.33.0` and `@opencode/sdk` / `@opencode/plugin` at `2.2.6` in `apps/control-plane/package.json`. Its `apps/control-plane/src/native/attempt.ts` has a real `OpenCodeWorkerd` host, `Plugin.define()` callbacks, Cloudflare workspace tool execution, a `RecoveryGuardedHarness`, and an explicit abort path. The small `createOpenCode` factory seam in the trial preserves the existing production host creation and lets the isolated full-server fixture substitute a standard HTTP client.

The Jarvis project does not supply any missing handler or native UI bridge for that runtime. Reusing it would require replacing its protocol with V2 and replacing its custom model/session behavior with PentCloud's existing implementation. Its generic Worker-to-DO routing idea is already present in PentCloud.

The two smaller alternatives remain separate from this repository:

1. Continue the authorized trial with the real latest full server and native UI. Stopping that server when returning control is sufficient for the simple evaluation requested; this finding does not call for another control protocol or recovery loop.
2. Evaluate the explicit embedded SDK export patch already identified at version 2.2.6: expose the existing `host.fetch` on `PromiseSdk.Interface` and the returned object, then route to that same host. This would retain the existing in-process plugin closures and SQLite session rather than copy this repository's protocol emulation. Actual UI/TUI compatibility would still need a focused trial. Browser assets are separate from the embedded API, and workerd file/PTY services remain unavailable.

Primary sources for the second alternative: [2.2.6 Promise SDK](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/sdk/src/promise.ts), [existing internal host](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/sdk/src/internal/host.ts#L50-L68), [OpenCode export request #54803](https://github.com/anomalyco/opencode/issues/54803), [Agents passthrough request #2567](https://github.com/cloudflare/agents/issues/2567). Both issues were open when checked during this investigation.

No implementation from the audited repository was installed into PentCloud. No production changes or deployment were performed for this audit.
