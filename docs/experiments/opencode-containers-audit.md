# Audit: elithrar/opencode-cloudflare-containers

Reviewed 2026-11-08 UTC. Read-only source and public GitHub evidence review; no code was deployed from this repository during the audit.

## Finding

**The useful pattern is small: run the full OpenCode server in one Cloudflare Container and forward standard client requests to it.** The entire handwritten Worker is 54 lines. It supports the requested approach of one optional native inspector with an explicit stop-server control; it does not introduce a separate chat UI.

The repository is a September 2025 demonstration, with authentication disabled and no pinned OpenCode release. Its source is useful evidence of the hosting pattern. Public GitHub records do not independently establish a live deployment or current-version UI success. PentCloud's separate local trial supplies the verified evidence for the current scoped OpenCode 2.2.6 server, stock web UI, and actual adviser/Coordinator integration. See [the integration report](opencode-integration-trial.md).

## Snapshot and review coverage

| Item | Observed value |
| --- | --- |
| Repository | [elithrar/opencode-cloudflare-containers](https://github.com/elithrar/opencode-cloudflare-containers) |
| Default branch | `main` |
| Reviewed HEAD | [`66980dc776c0f021d6977d96b21a57ff8fc872c3`](https://github.com/elithrar/opencode-cloudflare-containers/commit/66980dc776c0f021d6977d96b21a57ff8fc872c3) |
| Latest commit | `2025-09-17T19:59:22Z`, “update readme” |
| History | Four commits, all on September 17, 2025 |
| Repository status | Public; not archived |
| License | [MIT](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/LICENSE) |

The review covered the complete handwritten application, Dockerfile, Wrangler configuration, package manifest/lock, commit history and substantive diffs, and the relevant committed Containers library code. GitHub repository metadata, Actions/check/status collections, issues, pull requests, releases, and deployment records were checked separately from the README. The [branches API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/branches) and [commit history](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/commits?per_page=100) identify the snapshot.

## Application implementation

The [complete Worker](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/src/index.ts) defines `MyContainer extends Container<Env>`, sets port `4096`, sets `sleepAfter = "1h"`, and adds three logging hooks. Its Hono catch-all obtains a container stub and forwards the original request with `container.fetch(c.req.raw)`.

| Concern | What the source implements |
| --- | --- |
| Server runtime | A full OpenCode executable in a Linux container |
| Proxy | Every application route forwards the original request to the container |
| Instance selection | `getContainer(binding)` uses the stable name `cf-singleton-container` |
| Scale | One configured container instance |
| Idle lifecycle | One-hour inactivity setting through the Containers helper |
| Lifecycle callbacks | Start, stop, and error logging only |
| Explicit Stop route/button | None in the application |
| Authentication | Bearer-check function exists; its middleware registration is commented out |
| Provider/model setup | No provider credentials, agent prompt, or model configuration wired by the Worker |
| Agent integration | No Cloudflare Agents SDK, embedded OpenCode SDK, plugin registration, MCP bridge, or Coordinator |
| Browser frontend | No frontend application or custom terminal renderer |
| Native client | README describes the historical `opencode attach` flow |
| Workspace | Container working directory `/app` |
| Persistence | No mounted volume, R2 binding, application snapshot, backup, or session database synchronization |

The [Wrangler configuration](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/wrangler.jsonc) binds `MY_CONTAINER`, sets `max_instances: 1` and historical instance type `standard`, enables observability, and registers the container-owning Durable Object as a SQLite class. That SQLite migration does not itself persist OpenCode's container filesystem: there is no application code copying the session database or workspace into Durable Object storage.

The [Dockerfile](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/Dockerfile) starts `opencode serve --port 4096 --hostname 0.0.0.0`. It does not copy a project into `/app`, configure models, or inject a server password. The only `envVars` entry in the Worker is a demonstration `MESSAGE` value. The repository leaves any subsequent OpenCode setup to the operator/client.

The [README](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/README.md) identifies the project as an unauthenticated demo and shows deployment plus attachment commands. It contains no live deployment address, browser recording, or UI assertion. The current native web interface was verified in PentCloud's own [macOS evidence](opencode-integration-macos-ui.json); it should not be attributed to this historical example.

## Dependency and installation findings

The [manifest](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/package.json) and [lockfile](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/package-lock.json) record:

| Dependency | Manifest requirement | Locked version |
| --- | --- | --- |
| `@cloudflare/containers` | `^0.0.19` | `0.0.19` |
| `hono` | `4.8.2` | `4.8.2` |
| `wrangler` | `^4.37.1` | `4.37.1` |
| `typescript` | `5.8.3` | `5.8.3` |
| `workerd` | Wrangler dependency | `1.20250913.0` |

The Dockerfile uses the mutable image tag `node:20-slim` and installs `opencode-ai` globally without a version. That global installation is outside the project lockfile. **The originally tested OpenCode version cannot be determined from these files.** Rebuilding the Dockerfile does not specifically select the required scoped `@opencode/cli@2.2.6`.

PentCloud should retain its explicit latest-version check and current scoped CLI installation when reusing the hosting pattern. [PentCloud's registry evidence](opencode-latest.json) records all four scoped OpenCode packages at latest `2.2.6` when checked; adopting this example does not require downgrading the current toolchain.

The repository also commits installed dependencies, including platform binaries: its reviewed tree has 2,469 files, with only 11 outside `node_modules`. This explains the repository size despite the small app. The [pinned tree](https://github.com/elithrar/opencode-cloudflare-containers/tree/66980dc776c0f021d6977d96b21a57ff8fc872c3) is the source for that inventory; importing the dependency tree is unnecessary for reuse.

## Stop, idle, and transport behavior

The application inherits its behavior from the exact [Containers 0.0.19 implementation committed in the repository](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/node_modules/@cloudflare/containers/dist/lib/container.js). Inspection of that implementation establishes:

- `stop()` sends signal 15, SIGTERM, to the underlying container.
- `destroy()` calls the underlying container destroy operation.
- `fetch()` forwards HTTP and WebSocket requests to the configured port.
- A request to a stopped or unhealthy container invokes startup and waits for the port.
- Proxy activity renews the inactivity deadline. Open request/response streams are counted, and inactivity shutdown skips a container with open streams.
- The historical WebSocket close-tracking branch contains an unresolved TODO, so it should not be treated as evidence for current idle behavior under every client connection.

The [helper implementation](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/node_modules/@cloudflare/containers/dist/lib/utils.js) supplies the fixed singleton identity. No explicit stop endpoint is registered by the 54-line application.

This provides a straightforward match for the user's stop-server preference: expose a Stop action using the host's existing lifecycle API. One detail matters when copying the example: its next proxied request automatically starts the stopped container again. PentCloud's [current cloud trial host](../../apps/control-plane/test/native-opencode-cloud-probe/worker.ts) already has the desired explicit behavior: it destroys the container on stop, records the stopped phase, and returns 503 unless the server is running and ready. Preserve that behavior so a browser refresh does not undo Stop. No additional admission or recovery policy layer is proposed.

## What changed in its Git history

The [substantive OpenCode commit](https://github.com/elithrar/opencode-cloudflare-containers/commit/2b95ad73addc38382b562b3c8c6649dfb9bf7bdb) changes the generated starter as follows:

- Switches the container image from Alpine to Debian slim.
- Changes the npm installation from `opencode` to `opencode-ai`.
- Sets port 4096 and listens on `0.0.0.0`.
- Comments out the starter's bearer-auth middleware.
- Reduces the configured instance limit from ten to one.
- Replaces template documentation with the OpenCode server/attachment instructions.

The next commit changes ignore rules. The final commit only clarifies the README's demo/no-auth description. The Worker implementation has no later changes in the reviewed branch. This is a deliberately small server-hosting example, not a history of maintaining a custom UI or migrating an existing agent application.

## Deployment evidence and its limits

The following public collections were read on 2026-11-08:

| Evidence | Observed result | Primary link |
| --- | --- | --- |
| GitHub Actions runs | `total_count: 0` | [Runs API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/actions/runs?per_page=100) |
| Latest-commit check runs | `total_count: 0` | [Checks API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/commits/66980dc776c0f021d6977d96b21a57ff8fc872c3/check-runs) |
| Latest-commit statuses | Empty statuses; default aggregate `pending` state | [Status API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/commits/66980dc776c0f021d6977d96b21a57ff8fc872c3/status) |
| Issues, all states | Empty | [Issues API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/issues?state=all&per_page=100) |
| Pull requests, all states | Empty | [PR API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/pulls?state=all&per_page=100) |
| Releases | Empty | [Releases API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/releases?per_page=100) |
| Public GitHub deployment records | Empty | [Deployments API](https://api.github.com/repos/elithrar/opencode-cloudflare-containers/deployments?per_page=100) |
| Application tests/workflow files | None in the reviewed project tree | [Pinned tree](https://github.com/elithrar/opencode-cloudflare-containers/tree/66980dc776c0f021d6977d96b21a57ff8fc872c3) |
| Live demonstration URL | None; placeholder address only | [Pinned README](https://github.com/elithrar/opencode-cloudflare-containers/blob/66980dc776c0f021d6977d96b21a57ff8fc872c3/README.md) |

**A successful live deployment cannot be independently established from the evidence reviewed.** An empty GitHub deployment or Actions collection does not rule out manual deployment. The author's description and the implementation establish a published Cloudflare full-server demo; no stronger operational claim is made here. Collection endpoints may change after the audit date.

## Minimal reuse for PentCloud

Keep the PentCloud integration that already passed locally: a real adviser and Coordinator using the full OpenCode server, the real workspace read through standard MCP, candidate acceptance, and the stock web interface. Adopt this repository's simple host/proxy shape where useful, with the current scoped CLI and existing authentication.

The intended product trial remains **one optional Open agent entry and a Stop server action**. The current explicit stop behavior is already suitable for that experiment. Replacing PentCloud with this repository wholesale would add no existing-plugin or workspace integration: neither is present in the example. Those differences remain documented scope, not a reason to expand this one-agent test.

PentCloud's separate Cloudflare attempt uploaded the Worker but encountered the account's existing Access policy before container boot, then removed its trial resources. This repository's unauthenticated proxy does not resolve that account-level access requirement. See [deployment evidence](opencode-cloud-deployment-attempt.json) and [integration results](opencode-integration-trial.md) for the actual local/cloud distinction.
