# Hosted UI and operator IP privacy

PentCloud uses a Cloudflare-hosted UI behind hostname-based
Access. Each installation uses the deployer's account and generated
`workers.dev` address. A custom domain is optional for personal installations;
Cloudflare recommends one for business-critical production. A localhost UI
provides no inherent target-IP privacy improvement and is not a product mode.
No local connector, Tunnel, new credential service or extra datastore is needed.

The intended path is browser → Access → PentCloud Worker/private services →
cloud tools → target. Cloudflare can see operator IP and identity. Browser Run,
tool Containers and managed HTTP retrieval execute in the cloud. This is not a claim of
anonymous or fixed egress, complete network auditing or engagement host confinement.
See [network and data risks](../../SECURITY.md#network-and-data-risks).

## Browser controls

- Chat text and reasoning share one Markdown renderer. Network-bearing HTML is
  excluded; image URLs become inert placeholders. Formatted findings, code and
  links remain readable. Bounded data-only tool screenshots and authenticated
  same-origin file/report downloads remain available.
  Downloads retain their captured bytes; this browser policy does not follow
  files into external viewers or other applications.
- External chat/form/account-management links require explicit interaction and
  disclose that the destination can see the device IP. They open without referrer
  or opener access. The signed Cloudflare read-only Live View remains a direct
  Cloudflare link. Navigating externally leaves this protected workflow.
- Every asset request passes through the existing Worker before the Assets
  binding. HTML receives a Content Security Policy restricting scripts and
  connections to the installation, explicitly allowing that hostname's WebSocket
  endpoint. Images/fonts are local or data-only; frames, objects and media are
  blocked. Inline style remains allowed for Kumo. Theme initialization is a local
  script, so the policy needs neither inline JavaScript nor eval.
- The policy uses the actual request hostname, including custom domains. It adds
  a Worker invocation for static assets; Assets still serves the stored bundle.
  Keep this behavior in generated installation configs and upgrades.

## Target HTTP controls

`target-headers.ts` removes operator forwarding/IP, Access, cookie, authorization,
origin and referrer headers before target requests. Only explicitly selected
API credentials are added afterward. Reserved identity header names cannot be
saved/imported as API-key headers. Existing audience/path checks, redirect review,
response bounds, cancellation and mutation receipts remain.

| Surface | Identity handling |
| --- | --- |
| Address verification | Fresh, cleaned User-Agent-only headers; redirects reviewed |
| API test | Separate anonymous/authenticated requests; only selected target key added |
| Native API request tool | Clean headers plus selected target key; redirects not followed |
| Managed HTTP reader | Cleans SDK headers on every hop; passes a URL, not an inherited operator Request |
| Cloudflare Chromium / tool Containers | Private cloud execution; no operator request/cookie/header object supplied to those tools |
| OpenCode / research / conversion | Native model/conversion bindings and versioned per-role search providers; no operator HTTP headers supplied |

This is identity containment, not a new hostname allowlist. Preserve installed tool
schemas, image identities and the professional egress caveat. User-supplied
data or agent-created requests may themselves contain identifying information;
these controls do not remove arbitrary identity embedded in content.

## Verification and debugging

Use [testing](testing.md). Focused unit checks cover renderer output, CSP and
header removal while retaining target API keys. The opt-in materials browser
suite includes a production-bundle case: no automatic external requests from
hostile chat content, a real inline screenshot, SSE and Coordinator WebSocket
projections, external-link warning, and an actual browser CSP rejection. Build
the app before running that browser case. Existing file/history cases remain.

Use [authentication](authentication.md) for sign-in. Keep hostname-based Access
and signed assertion verification. Worker-level Access currently rejects
WebSocket upgrades. Live checks should verify denied unauthenticated access,
current bindings and deployed headers without model/scanner work or health polling.
A local fixture does not prove human SSO or end-to-end cloud egress. Confirm these checks in the account where the application is deployed.

## Official references

- [workers.dev and deployment guidance](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
- [Hostname Access and WebSockets](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
- [Worker client-IP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests).
- [Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/): custom Worker responses need their own headers.
- [Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/).
