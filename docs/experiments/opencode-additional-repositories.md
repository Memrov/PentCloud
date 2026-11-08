# Additional Cloudflare/OpenCode repository verification

Checked **2026-11-08, 05:52–05:56 UTC** using GitHub's current commit, tree, file, and Actions APIs, plus current Cloudflare documentation. Read-only research: no repositories cloned, dependencies installed, application endpoints exercised, or services created.

## Findings that matter for PentCloud

| Repository/reference | What the source actually runs | UI | Deployment evidence |
| --- | --- | --- | --- |
| [hexamh/opencode-agent](https://github.com/hexamh/opencode-agent) | Full OpenCode server in a Cloudflare Sandbox container | Stock OpenCode web UI; explicit WebSocket forwarding for its terminal | Successful Cloudflare deployment workflow at current HEAD; no recorded UI test in that workflow |
| [miantiao-me/cloud-code](https://github.com/miantiao-me/cloud-code) | `opencode web` in a Cloudflare Container | Stock OpenCode web UI through a small Worker proxy | Deployable source/configuration; live deployment not established by the inspected public records |
| [Current official OpenCode example](https://github.com/cloudflare/sandbox-sdk/tree/61cac81b53334b314e4a4daf04486b9cee9b65c2/examples/coding-agents/opencode) | `opencode run --format json --auto` for one task | HTTP task/event/diff API; no stock web server or interactive terminal route | Maintained official example and CI configuration; not evidence of a deployed native UI |
| [Historical official web example](https://github.com/cloudflare/sandbox-sdk/tree/bc0de65a1fc4f36205e16539a5ae21bfaaa2484d/examples/opencode) | Full OpenCode server with Sandbox proxy helpers | Stock OpenCode web UI, API, and terminal WebSocket | Genuine historical official implementation; removed from main on September 2 |

**The smallest relevant source pattern is cloud-code's full-server proxy. The strongest public deployment record in this subset is hexamh's successful deployment workflow.** Neither establishes that OpenCode 2.2.6 works unchanged with its older integration. The current official coding-agent example addresses a different interface: headless jobs.

## 1. hexamh/opencode-agent

### Current source and UI

Current HEAD remains [`685aabc7a016fbeded220b355b72176e8c351579`](https://github.com/hexamh/opencode-agent/commit/685aabc7a016fbeded220b355b72176e8c351579), committed **2026-03-30 08:31:05 UTC**. This matches the previously inspected SHA; it is not a later modernization.

The [Worker](https://github.com/hexamh/opencode-agent/blob/685aabc7a016fbeded220b355b72176e8c351579/src/index.ts) imports `createOpencodeServer` and `proxyToOpencode` from `@cloudflare/sandbox/opencode`. Its default route ensures the server and forwards the original request. An explicit WebSocket branch uses the same helpers. That is source evidence for a native OpenCode web/terminal transport, with no separately implemented chat frontend. It does not prove a browser-rendered OpenCode TUI was tested.

The [Dockerfile](https://github.com/hexamh/opencode-agent/blob/685aabc7a016fbeded220b355b72176e8c351579/Dockerfile) inherits `cloudflare/sandbox:0.8.0-opencode`, exposes port 4096, and clones Cloudflare's Agents repository into the server workspace. The [manifest](https://github.com/hexamh/opencode-agent/blob/685aabc7a016fbeded220b355b72176e8c351579/package.json) specifies Sandbox `^0.8.0` and the old `@opencode-ai/sdk ^1.1.40`. The runtime binary version comes from the image; the source and surviving workflow metadata do not establish its exact installed version. The README's sample health response saying `1.1.40` is an example, not a captured runtime measurement. This is not evidence of latest OpenCode 2.2.6.

### What “deployed” proves here

[Actions run 23735398760](https://github.com/hexamh/opencode-agent/actions/runs/23735398760) is **completed/success**, triggered by a push of that exact HEAD on **2026-03-30 08:31:08 UTC**. Its single job, `Deploy OpenCode Agent`, completed successfully at **08:34:29 UTC**. These fields were re-read from the [run API](https://api.github.com/repos/hexamh/opencode-agent/actions/runs/23735398760) and [jobs API](https://api.github.com/repos/hexamh/opencode-agent/actions/runs/23735398760/jobs).

The [workflow](https://github.com/hexamh/opencode-agent/blob/685aabc7a016fbeded220b355b72176e8c351579/.github/workflows/deploy.yml) installs dependencies, generates types, typechecks, and runs `cloudflare/wrangler-action@v3` with `command: deploy`. It contains no subsequent HTTP health check, browser journey, terminal interaction, or model/tool test. Downloading job 69138651635's logs returned **HTTP 410** during this research. Therefore:

- There is public evidence that its deployment workflow succeeded.
- There is no surviving inspected log proving the live server's binary version or runtime UI behavior.
- Current availability, authenticated isolation, persistence after container replacement, and a complete model/tool journey remain unverified.

[SETUP_COMPLETE.md](https://github.com/hexamh/opencode-agent/blob/685aabc7a016fbeded220b355b72176e8c351579/SETUP_COMPLETE.md) names `https://opencode-agent.visatk-us.workers.dev`, but its status narrative still refers to an earlier failing run. That document is stale relative to the successful Action and was not treated as live service proof. The application URL was not exercised.

### Reuse value

Keep the small “ensure server, forward HTTP/WebSocket” pattern. The repository's main Worker is **727 physical lines**, including Telegram, MCP, and convenience API routes; those features are unnecessary for PentCloud's optional inspector. Its user selection reads `X-User-ID` or a query parameter with a shared default, and the inspected handler does not authenticate that identity. The source is an architectural reference, not a ready-made authorization boundary.

## 2. miantiao-me/cloud-code

### Current source and UI

Current HEAD remains [`cc49b33ad7da8e37a313b54b3020f24cd5fd048c`](https://github.com/miantiao-me/cloud-code/commit/cc49b33ad7da8e37a313b54b3020f24cd5fd048c), committed **2026-01-29 12:05:34 UTC**. Its [Dockerfile](https://github.com/miantiao-me/cloud-code/blob/cc49b33ad7da8e37a313b54b3020f24cd5fd048c/Dockerfile) runs:

```sh
opencode web --port 2633 --hostname 0.0.0.0
```

The image installs OpenCode from `https://opencode.ai/install` without a version argument. This floats at **image build time**; it does not continuously update a running server, and the source does not identify the version in any deployed image. A cached or old build cannot establish today's latest release.

The actual TypeScript wrapper is **139 physical lines across three files**:

- [index.ts](https://github.com/miantiao-me/cloud-code/blob/cc49b33ad7da8e37a313b54b3020f24cd5fd048c/src/index.ts), 42 lines: optional Basic authentication, then forward the request.
- [container.ts](https://github.com/miantiao-me/cloud-code/blob/cc49b33ad7da8e37a313b54b3020f24cd5fd048c/src/container.ts), 61 lines: a singleton `Container`, port 2633, and a native event observer.
- [sse.ts](https://github.com/miantiao-me/cloud-code/blob/cc49b33ad7da8e37a313b54b3020f24cd5fd048c/src/sse.ts), 36 lines: SSE parsing.

No frontend implementation appears in its complete repository tree. The UI is supplied by OpenCode's web server. This is a concrete small full-server hosting implementation, without a separate chat starter.

### Lifecycle, persistence, and scope

The container uses `sleepAfter = '10m'`; its `session.updated` listener renews activity. The entrypoint handles SIGTERM/SIGINT by terminating OpenCode and unmounting optional storage. There is no dedicated HTTP “stop server” endpoint in the inspected Worker. The Dockerfile optionally mounts S3/R2 using TigrisFS and puts both workspace and XDG state beneath the mount; that is the implementation's persistence mechanism, not independent proof of crash-safe recovery.

The [configuration](https://github.com/miantiao-me/cloud-code/blob/cc49b33ad7da8e37a313b54b3020f24cd5fd048c/wrangler.jsonc) specifies one container and the [manifest](https://github.com/miantiao-me/cloud-code/blob/cc49b33ad7da8e37a313b54b3020f24cd5fd048c/package.json) uses `@cloudflare/containers ^0.1.0`. This is an older API/configuration generation. Its optional `cloudflared` binary is for exposing services from inside the container; the primary OpenCode service is hosted in Cloudflare Containers, so this is more than a tunnel to a user's laptop.

### Deployment evidence

The [Actions API](https://api.github.com/repos/miantiao-me/cloud-code/actions/runs?per_page=10) returned **total_count: 0**. The current tree has no workflow, and [repository metadata](https://api.github.com/repos/miantiao-me/cloud-code) supplies no homepage. The README provides `pnpm deploy` instructions. These establish source and an intended deployment path, but not a verified running service.

The connector did not expose GitHub's Deployments collection; its unsupported-endpoint error is not evidence that deployments do not exist. No claim is made that this repository was never deployed.

## 3. Official Cloudflare examples: current and historical

### Current main is headless

Current `cloudflare/sandbox-sdk` HEAD is [`61cac81b53334b314e4a4daf04486b9cee9b65c2`](https://github.com/cloudflare/sandbox-sdk/commit/61cac81b53334b314e4a4daf04486b9cee9b65c2), committed **2026-11-02 14:29:23 UTC**.

At that exact commit, the [OpenCode Dockerfile](https://github.com/cloudflare/sandbox-sdk/blob/61cac81b53334b314e4a4daf04486b9cee9b65c2/examples/coding-agents/opencode/Dockerfile) pins **`opencode-linux-x64-baseline@1.18.32`**, Node 26, and Sandbox donor image **1.0.3**. The [agent implementation](https://github.com/cloudflare/sandbox-sdk/blob/61cac81b53334b314e4a4daf04486b9cee9b65c2/examples/coding-agents/opencode/src/index.ts) executes a noninteractive JSON-emitting task. Its [handler](https://github.com/cloudflare/sandbox-sdk/blob/61cac81b53334b314e4a4daf04486b9cee9b65c2/examples/coding-agents/opencode/src/runner/handler.ts) serves repository/task/events/diff/execution resources; unmatched paths return 404. It does not run `opencode serve`/`web`, proxy native assets, or expose a browser terminal.

The [shared runner](https://github.com/cloudflare/sandbox-sdk/blob/61cac81b53334b314e4a4daf04486b9cee9b65c2/examples/coding-agents/opencode/src/runner/sandbox.ts) uses native `ctx.container` start/exec/destroy operations. Its reset endpoint destroys the container, and the next execution gets a fresh filesystem. This is useful source for a straightforward stop action, independent of adopting the whole headless runner.

The [current documentation](https://developers.cloudflare.com/sandbox/coding-agents/opencode/), marked **October 22, 2026**, is different from the repository: it pins **1.19.4**, Node 24, and Sandbox **1.0.1**. It also explicitly runs without an interactive terminal. Keep these two references distinct; neither is the 2.2.6 full-server integration tested locally in PentCloud.

[PR CI](https://github.com/cloudflare/sandbox-sdk/blob/61cac81b53334b314e4a4daf04486b9cee9b65c2/.github/workflows/pr.yml) checks example packaging/version consistency and standalone installation. The [privileged cloud smoke workflow](https://github.com/cloudflare/sandbox-sdk/blob/61cac81b53334b314e4a4daf04486b9cee9b65c2/.github/workflows/pr-privileged.yml) deploys the generic `workspace` example. These checks should not be described as a deployed OpenCode UI test.

### The old official native web example really existed, then was removed

The [path history](https://api.github.com/repos/cloudflare/sandbox-sdk/commits?path=examples/opencode&per_page=5) identifies removal commit [`c3b61c38c66e4d6f7669f300479b25155c734828`](https://github.com/cloudflare/sandbox-sdk/commit/c3b61c38c66e4d6f7669f300479b25155c734828), **2026-09-02 12:31:54 UTC**, titled “Remove existing Sandbox implementation”.

Its parent is `bc0de65a1fc4f36205e16539a5ae21bfaaa2484d`. The [old Worker at that parent](https://github.com/cloudflare/sandbox-sdk/blob/bc0de65a1fc4f36205e16539a5ae21bfaaa2484d/examples/opencode/src/index.ts) exists and uses `withOpenCode`, `createOpenCodeClient`, and `createOpenCodeProxy`. The old [README](https://github.com/cloudflare/sandbox-sdk/blob/bc0de65a1fc4f36205e16539a5ae21bfaaa2484d/examples/opencode/README.md) describes the native web UI, API, and terminal WebSocket. Its [Dockerfile](https://github.com/cloudflare/sandbox-sdk/blob/bc0de65a1fc4f36205e16539a5ae21bfaaa2484d/examples/opencode/Dockerfile) uses `cloudflare/sandbox:0.12.1-opencode`.

The same source path returns **404 at the removal commit**, and the current main tree has no `examples/opencode` directory. Search results that still show its README under `main` are stale relative to the checked Git history. This is valid historical evidence for the full-server proxy pattern; it is not a native-UI template present on current main. This check does not establish the support status of every older release branch.

## Practical conclusion

For the narrow PentCloud goal, these sources support **one full OpenCode server, a thin authenticated HTTP/WebSocket proxy, and a way to stop the server/container**. They do not require replacing the dashboard or building another chat frontend. Borrow that pattern while keeping the already-verified latest OpenCode packages. None of the examined external deployment records supplies the missing proof that PentCloud's own cloud runtime and stock UI passed; its separate cloud attempt remained blocked by the pre-existing Access policy before boot.
