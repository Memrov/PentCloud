# Optional OpenCode server integration probes

These fixtures run the existing PentCloud adviser and Coordinator against a full OpenCode server. They use scripted model responses and fixture artifact transport. The local fixture exposes one existing read-only workspace tool through MCP; the cloud fixture reuses it through a private container binding.

## Setup and typecheck

Run from the repository root with Node 26.12.1 or newer and the project's dependencies installed:

```sh
npm ci
npm --prefix apps/control-plane/test/native-opencode-server-probe ci --ignore-scripts --no-audit --no-fund --workspaces=false
npm --prefix apps/control-plane/test/native-opencode-server-probe run typecheck
```

The nested package pins MCP server 2.4.0 and is intentionally outside the root npm workspaces. Root `npm ci` does not install it. The control-plane's normal typecheck excludes these two optional fixture directories and continues to exclude `node_modules`. This directory's separate TypeScript configuration checks both fixture entrypoints and their imported application code, using the app's existing Vite and generated Worker declarations.

## Run the local probes

Use the latest **scoped** `@opencode/cli` binary. Check `npm view @opencode/cli@latest version` and the binary's `--version` before running. This experiment currently targets OpenCode 2.2.6; if latest has changed, update the matching fixture/SDK versions before continuing.

```sh
node scripts/probe-opencode-integration.mjs --cli /absolute/path/to/opencode --output /tmp/opencode-integration.json
```

That runs the advice, workspace-tool, and cancellation scenarios. To inspect the stock web UI with a working Playwright browser:

```sh
node scripts/probe-opencode-integration.mjs --cli /absolute/path/to/opencode --scenario tool --browser --screenshots /tmp/opencode-ui --output /tmp/opencode-ui.json
```

Add `--probe-direct-followup` to an advice scenario to record what happens when another prompt is submitted while the completed agent's server remains running. The local runner stops its server and removes temporary server directories afterward.

The separate `scripts/probe-opencode-cloud.mjs` runner requires an already booted isolated cloud fixture and a private credentials file. It does not deploy resources. Its deployment owner is responsible for stopping and deleting the cloud resources. See the [integration report](../../../../docs/experiments/opencode-integration-trial.md) for the verified local results and the cloud deployment's current limits.
