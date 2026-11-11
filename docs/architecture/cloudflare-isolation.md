# Cloudflare isolation for the Codex development deployment

The development deployment uses separate Workers for the public UI, Coordinator Durable Object, Attempt Durable Object and Computer container, Artifact adapter, MCP gateway, Codex runner and sandbox, two small Workflows, and eleven tool packs. The agent sandbox connects to MCP. Artifact repositories and tool containers are not bound inside that sandbox.

| Worker | Responsibility |
| --- | --- |
| `pentcloud-dev-app` | Public UI and API, Access verification, target secret broker |
| `pentcloud-dev-coordinator` | Durable run and project state |
| `pentcloud-dev-attempt` | Durable attempt state and Computer container |
| `pentcloud-artifacts-dev` | Owns the `pentcloud-dev-work` Artifacts namespace and exposes repository RPC |
| `pentcloud-mcp-dev` | Private native MCP endpoint, forwarding to Attempt |
| `codex-lifecycle-pilot` | Agent sandbox and runner RPC |
| `codex-role-workflow-dev` | Role completion and run preparation Workflows |
| `pentcloud-dev-tools` | Thin tool gateway, with one service binding to each isolated tool Worker |
| `pentcloud-dev-tool-*` | One Durable Object and container per tool pack |

The public UI Worker has no Coordinator, Attempt, or tool implementation. Its service and Durable Object bindings point to the separate owners. Existing Durable Object namespace IDs survived the transfer. The UI Worker retains the existing target secret bindings and exposes only `TargetSecretBroker` over a private service binding. Coordinator and Attempt resolve target credentials through that broker.

## Deployment order

The dev Worker split used Cloudflare's [four phase Durable Object transfer](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#transfer-a-durable-object-class-between-workers): convert source migrations to declarative exports, deploy receivers with `expecting-transfer`, deploy source tombstones with `transferred`, then bind each receiver to its transferred namespace. The source still exported the classes during the commit. The same sequence moved the eleven tool namespaces. The old tool Worker name became the thin gateway after the target Workers were bound, preserving the app's service binding.

Use `node infra/tool-packs/scripts/prepare-dev-transfer.mjs` to generate the tool phases. `infra/tool-packs/wrangler.dev.*.jsonc` are the steady state configurations after transfer. Use `node scripts/split-dev-worker-config.mjs <private-dev-wrangler.jsonc>` to generate app phases from the private deployment config. Generated `.split-*.jsonc` files and the private input are ignored by Git.

Build each app phase with `PENTCLOUD_WRANGLER_CONFIG=./.split-<stage>.jsonc PENTCLOUD_SPLIT_OUT_DIR=dist-split-<stage> vp build --mode split` from `apps/control-plane`. Before deploying a Coordinator or Attempt build, run `node ../../scripts/strip-split-worker-assets.mjs dist-split-<stage>/worker/wrangler.json`. Check that these target configs have no `routes` or `assets`; only the UI source owns `dev.pentcloud.dev`.

For container backed Durable Object commits, deploy the source with `--containers-rollout immediate`. Using `none` at that step preserves the old Container metadata and Cloudflare rejects the tombstone with `container_class_not_durable_object`. Receiving and final target phases can use `--containers-rollout none` to retain existing images. Deploy with `--keep-vars` so the UI's existing dynamic target secret bindings remain attached. Verify the domain owner and namespace IDs after each phase.

The Artifact adapter and MCP Worker deploy from the pilot's `wrangler.artifacts.jsonc` and `wrangler.mcp.jsonc`. The Workflow Worker deploys from `wrangler.workflow.jsonc`. The runner's `cloudflare.config.ts` binds these Workers and the new Workflow name. The two Workflow entrypoints are event driven; run preparation begins with an HTTP `202` and continues through a durable Workflow step.

Cloudflare Builds watches the `feat/container-computer-pilot` GitHub branch. Its build command writes the private Wrangler config, applies the dev bindings, and calls `scripts/build-split-dev.mjs`. Its deploy command calls `scripts/deploy-split-dev.mjs`, which updates the eleven tool Workers and gateway before the Coordinator, Attempt, and UI Workers. The deploy script rejects a public route on either internal Worker. Run it locally with `PENTCLOUD_DEPLOY_DRY_RUN=1` to verify every generated deployment without uploading.

## Verification

Run `GO_BIN=/Users/darian/.local/share/pentcloud-toolchains/go1.26.5/go/bin/go vp run verify:full` in the PentCloud repository and `npm run typecheck` in the pilot. `npm run build:split --workspace @pentcloud/tool-packs` checks the gateway and all eleven pack bundles. Cloudflare settings should show `ARTIFACTS` as a service, `COORDINATOR` and `ATTEMPTS` on their separate Workers, `TOOL_PACKS` pointing at the old name now backed by eleven services, and the two Workflows on `codex-role-workflow-dev`.

The customer installation configs still use the original combined Worker and tool-pack build. The split entrypoints and generic per-pack configs are present, but the customer deployment process needs its own state transfer before it can use this topology.
