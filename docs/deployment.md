# Install and deployment

Start with [requirements and costs](requirements.md), then the
[Cloudflare account/key guide](cloudflare-setup.md). Each installation runs in
its own Cloudflare account, protected by Access, for one owner or trusted team.
No creator account, remote repository, credentials, runs or evidence are seeded.

## Guided CLI

Use macOS/Linux x64/arm64, Node 26.12.1 or later 26.x, Go 1.26.5,
Python 3.11+, Git, Bash and libarchive (`bsdtar` with 7z support). Install the
official [cf CLI](https://developers.cloudflare.com/cf/get-started/) and
cloudflared for interactive sign-in. Root `npm ci` installs pinned Wrangler.

```sh
npm ci
npm run pentcloud -- setup
```

Setup checks prerequisites, opens official Cloudflare sign-in when needed, and
lets you select your account, active domain zone, unused app hostname and owner
email. It preserves your existing Zero Trust organization and identity providers.
If they are missing, the reviewed plan explicitly proposes a team and email OTP
login. Confirm the plan to provision the installation.

The CLI saves private configuration and ownership state outside Git (by default
under `~/.local/share/pentcloud/`). It prints the app URL after verification.
The installation uses **eleven smaller tool packages**, a private gateway and an
Access-protected app. It builds pinned package recipes in your account's registry;
new installations never import Kali. Initial builds can take tens of minutes.
The adjacent image cache permits subsequent installs and upgrades to reuse
verified immutable images. Keep configuration, state and caches for recovery.

For explicit configuration or CI, copy
[the schema-2 example](../templates/private-install/pentcloud.example.json)
outside Git and fill in your selected account, domain zone, unused hostname,
Access team domain and operator emails:

```sh
npm run pentcloud -- plan --config ../my-pentcloud.json
npm run pentcloud -- install --config ../my-pentcloud.json --state ../my-pentcloud-state --apply
```

Use `--headless` only with explicit private configuration/state and a selected-account
`CLOUDFLARE_API_TOKEN`. Interactive setup uses the official cf session to mint a
short-lived deployment lease and revoke it afterward. Credentials never belong
in config or command arguments. Model keys are optional during installation;
add them directly through Worker Secrets using [key setup](cloudflare-setup.md).

Every install and upgrade verifies bindings, anonymous rejection, native Loader,
Browser Run, HTML-to-Markdown, Artifacts Git/Blob access, result Workflow wiring,
and all eleven package runtimes. It issues one bounded HTTP tool request to its
own temporary verification host, retires its runtimes and removes temporary
verification resources. It does not run model inference or an assessment.
Interactive installs also verify owner sign-in through cloudflared. Headless CI
reports `ownerVerified: false`; a service-token test does not prove human SSO.

```sh
npm run pentcloud -- doctor --config ../my-pentcloud.json --state ../my-pentcloud-state
npm run pentcloud -- doctor --config ../my-pentcloud.json --state ../my-pentcloud-state --full --apply
```

Basic doctor inspects installed bindings and authentication without starting tool
runtimes. Full doctor runs the installation verification described above.

## Safe defaults and ongoing delivery

The checked-in app/gateway Wrangler examples support local compilation only.
They have no trusted Access issuer/audience, model key, account ID or prepared
image; the gateway example deliberately omits a Container image. Use the
installer-generated production configurations in your private state directory.
Never deploy the examples unchanged or copy another installation's identity.

The dedicated [installation CI](installation-ci.md) imports source into native
Artifacts and tests a package-only installation in the separate testing account.
Its credentials/settings are private GitHub environment secrets, and its
ownership state remains in Artifacts. It installs the eleven tool packages
without a Kali gateway. Ordinary pull-request CI receives no deployment secrets.
The same public CLI runs in CI. No public one-click deploy button is available yet.
Existing schema-1 legacy installations retain their backend and require their
existing ownership manifest; the CLI never converts them implicitly.

For development, create a separately named installation with its own Access
application/audience, app and gateway Workers, Durable Objects, Artifacts
namespace, result Workflow/event filter and tool-package resources. A separate
hostname alone does not isolate data. Worker Preview service bindings can still
reach a peer Worker's production deployment, so a Preview alone is insufficient
for this full chain. Keep generated dev configuration and ownership state outside
Git. Promote only reviewed, tested source through your release process.

## Lifecycle

Upgrade pauses admissions while checking that active work has drained, preserves
saved targets, definitions and history, deploys the candidate, then verifies its
exact commit before reopening admissions. If deployment is interrupted, retain
the recorded operation and rerun upgrade to finish it. It does not reuse the
permanent uninstall fence or delete saved onboarding data. A previous source
commit may be redeployed only when its schemas and DO migrations remain compatible;
this is not a general database rollback mechanism.

Local locks record the owner process and POSIX process group before work starts.
After interruption, the CLI recovers a valid same-host lock only when that process
and its entire group are gone. Active, foreign-host, legacy empty or otherwise
unprovable locks require private reconciliation. This does not clear an uncertain
Cloudflare resource receipt or overwrite divergent Artifacts state.

```sh
npm run pentcloud -- upgrade --config ../my-pentcloud.json --state ../my-pentcloud-state --apply
npm run pentcloud -- cleanup --config ../my-pentcloud.json --state ../my-pentcloud-state --apply
```

Native Artifacts mirrors allowlisted private ownership/config/image/release receipts
in `<instance>-setup/installation`. Reusing an empty local state directory can
restore those receipts. Divergent local/remote receipts fail closed for reconciliation;
credentials and account logs are never mirrored. Keep runtime data separate from
installation receipts.

The CLI also supports export, import-targets and uninstall; consult
`node scripts/pentcloud.mjs --help`. Mutations require --apply; uninstall also
requires --data retain|delete and --confirm INSTANCE. Keep ownership state for
safe reconciliation. Retain detaches owned ingress; delete requires an empty
runtime namespace, no runs/active instances or foreign references, and exact
resource ownership. Images and setup audit receipts remain for recovery; global
Zero Trust and email settings are retained. Git-bundle export excludes native DO/session state,
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
