# Native Kali toolbox

PentCloud uses one shared on-demand Cloudflare Container containing the pinned
stock vxcontrol Kali image. The guided installer imports/prepares the exact
stock image into the deployer's own registry and generates the gateway config.
This source release bundles no Container layers or third-party scanner binaries.

The gateway is private behind a service binding; its HTTP handler returns 404.
Readiness must precede Kali-capable inference. Active/unresolved work retains
operation ownership; cancellation drains or reconciles uncertain execution.
The native 30-minute inactivity policy remains in force. Do not poll status to
check whether Kali is asleep, since requests can extend activity.

Use native Container preparation/logs, app/gateway Issues and the recorded
operation receipts to debug. See [debugging](../../docs/operations/debugging.md),
[evidence transfer](../../docs/operations/kali-evidence.md) and
[network limits](../../SECURITY.md#network-and-data-risks).
