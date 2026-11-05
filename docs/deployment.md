# Install and deployment

Start with [requirements and costs](requirements.md), then the
[Cloudflare account/key guide](cloudflare-setup.md). Each installation runs in
its own Cloudflare account, protected by Access, for one owner or trusted team.
No creator account, remote repository, credentials, runs or evidence are seeded.

## Guided CLI

Use macOS/Linux x64/arm64, Node 26.12.1 or later 26.x, Go 1.26.5, Git, Bash,
npm, the official cf CLI and cloudflared; Python 3.11+ is needed for full tests.
The pinned Wrangler is installed by root npm ci. Use the current official Cloudflare documentation and CLI help. cf and Wrangler have separate login sessions.

```sh
npm ci
cf auth login
cf auth whoami
cp templates/private-install/pentcloud.example.json ../my-pentcloud.json
```

Fill your account ID, unique instance name, Access team domain and allowed emails
in that JSON. Keep the config/state outside Git. Review billed resources and
Cloudflare service access before continuing:

```sh
node scripts/pentcloud.mjs plan --config ../my-pentcloud.json
node scripts/pentcloud.mjs install --config ../my-pentcloud.json --state ../my-pentcloud-state --apply
```

The installer verifies the selected account/team, prepares a private Artifacts
namespace and stock Kali image in that account, then deploys a private gateway
and Access-protected app with installation-specific configs. The initial image
transfer/preparation may take tens of minutes. Keep state and resume install;
do not replace a pending image or rerun uncertain creates under new identities.

Add your OpenCode workspace key directly through a Cloudflare Worker Secret;
see [key setup](cloudflare-setup.md). Finish native Access sign-in, run doctor,
and deliberately test chosen models only after considering allowance/cost:

```sh
cloudflared access login --quiet https://YOUR-APP-HOST
node scripts/pentcloud.mjs doctor --config ../my-pentcloud.json --state ../my-pentcloud-state
```

Plan/doctor do not start a model or scanner. Never paste credentials in chat,
config, command arguments or application forms. No direct model-vendor key is
needed for OpenCode Go; optional BYOK credentials stay in OpenCode.

## Safe defaults and ongoing delivery

The checked-in app/gateway Wrangler examples support local compilation only.
They have no trusted Access issuer/audience, model key, account ID or prepared
image; the gateway example deliberately omits a Container image. Use the
installer-generated production configurations in your private state directory.
Never deploy the examples unchanged or copy another installation's identity.

For CI, choose one native Workers Builds source per Worker, with your own
private source/credentials and preserved generated config. This public repo has
no deployment credentials, creator-account bindings or automatic deployment
workflow. Installation uses the guided CLI; no one-click deploy button is available.

## Lifecycle

The CLI also supports upgrade, export, import-targets and uninstall; consult
`node scripts/pentcloud.mjs --help`. Mutations require --apply; uninstall also
requires --data retain|delete and --confirm INSTANCE. Keep ownership state for
safe reconciliation. Git-bundle export excludes native DO/session state,
workspaces and secrets; it is not a complete installation backup.

## Limitations

This is a self-hosted preview. Product entitlements, image preparation, human
sign-in and model/scanner connectivity must be checked in your own account.
Local tests do not establish an end-to-end assessment on a fresh account.
Image preparation can be slow; retain state and resume the same installation.

There is no one-click deploy button, hard spending cap, complete system
backup/restore, hosted tenant isolation or dedicated scanning egress.
Use only authorized targets and review [security](../SECURITY.md),
[requirements and costs](requirements.md) and [operations](operations.md).
