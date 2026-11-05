# Browser QA

PentCloud includes standalone CLI commands for Cloudflare Browser Run screenshots
and read-only interaction checks. They use your explicit account and installation,
with temporary native Access service authentication.

## Run a review

Use Node 26.12.1+, the installed official `cf` CLI and its saved account login.
If needed, complete `cf auth login` through Cloudflare's normal flow. Never paste
credentials into chat or inspect the CLI's credential files. The command uses
Unix `/dev/stdin` for private JSON input (macOS/Linux, or an equivalent Unix
execution environment). Select the installation explicitly:

```sh
npm run qa:ui -- \
  --account YOUR_ACCOUNT_ID \
  --origin https://YOUR_APP_HOST \
  --output /absolute/path/outside-the-repository/qa-evidence
```

Optional `--run-id EXISTING_RUN_ID` captures an existing agent chat. Use an
approved completed run for predictable review. The command creates no run, sends
no chat, saves no settings, and never starts or polls Kali. Private screenshots
can contain existing target/run content; inspect them before sharing. Never
publish evidence automatically.

The command captures targets, dashboard, settings and findings at 1440 × 900 and
390 × 844. It checks the application title/root, expected accessibility heading,
loading state and complete PNG dimensions. The runner waits for the application’s native `aria-busy` state or ready
heading rather than an arbitrary delay or network-idle across open streams. A loading capture fails
rather than becoming an approved baseline. No CSS or DOM replacement is used.
Each capture has an exact-origin HTTP/WebSocket request allowlist; these modified
network conditions are recorded.

The native CLI exposes snapshot content/tree/image but drops the API's outer
navigation metadata. The report therefore marks final upstream HTTP status as
unavailable; it verifies actual PentCloud content within the origin allowlist.
Do not interpret a login page's HTTP 200 as an application pass.

A successful command means **captures are ready for review**, not that the UI
looks correct. Open and inspect every affected screenshot, document spacing,
wrapping, clipping, alignment and contrast findings, and fix them with native Kumo
components/tokens. An approved same-condition baseline is needed before calling
a difference a visual regression. Do not approve new baselines automatically.

## Access and credential custody

The runner resolves one exact-host self-hosted Access application. It creates a
uniquely named **one-hour native Access service token** and a separate Service
Auth policy matching only that token. Existing user/automation policies and
Managed OAuth are preserved. Access signs the application's JWT and the existing
Worker still validates its issuer, audience, signature and expiry. There is no
everyone/bypass rule or wildcard token selector.

The service credential stays in process memory and is passed to the official CLI
through stdin. It never enters shell text, command arguments, source, evidence or
a credential file. Browser Run uses the native `cf` authorization; no OAuth value
is extracted from its cache. Full PNG bytes are captured from the native CLI's
private stdout, avoiding the API connector's long-string image truncation.

The existing native account authorization adapter mints a selected-account API
lease with only `Access: Apps and Policies Write` and `Access: Service Tokens
Write` for setup/cleanup. It expires within two hours and is revoked using the
original `cf` grant. A supplied API token is never saved, replaced or revoked;
headless environments still need native CLI authorization accepted by Browser
Run as well as Access management. An Access-only token is insufficient.

The runner deletes and verifies removal of its own Access policy/service token
in `finally`, then releases its API lease. An ambiguous create is reconciled by
its unique recorded resource name, never by retrying POST. Quick Actions own
and close their one-call browsers; the final command acquires no persistent CDP
session. SIGINT/SIGTERM stop between bounded captures and unwind cleanup. A hard
kill can leave metadata/resources behind; credentials remain bounded by expiry.
Reconcile only the exact recorded names/IDs after interruption. Do not sweep
unrelated policies, tokens or browsers.

## Coverage limits and interactive testing

Use the official Cloudflare Playwright runner for deployed interactions:

```sh
npm run qa:ui:interactive -- \
  --account YOUR_ACCOUNT_ID \
  --origin https://YOUR_APP_HOST \
  --output /absolute/path/outside-the-repository/interactive-evidence \
  --run-id EXISTING_COMPLETED_RUN
```

The root development dependency `@cloudflare/playwright` is pinned independently
of PentCloud's agent runtime. The command creates a uniquely named disposable QA
Worker with a native Browser binding, no Durable Object/database/storage, and no
observability logging. Existing production Workers and Builds sources are not
modified. Normal `cf` authorization acquires the task-owned browser; the Worker
connects through its native binding. The session ID is bound to the QA Worker;
callers cannot substitute an assessment's browser. Its inactivity fallback is
three minutes; normal cleanup explicitly closes it and verifies native readback.

This runner requires an existing same-account wildcard Workers development
Access application. It fails before deploying if that protection is absent.
It adds an exact-token Service Auth policy there and to the installation's exact
Access application, sharing one one-hour credential. It preserves existing rules
and deletes only those policies/token. The standalone QA Worker also checks Cloudflare's trusted native
`ctx.access` against the development application's audience. Only the
configured installation can be reviewed. The account lease selects Workers
Scripts Write, Access Apps/Policies Write and Access Service Tokens Write;
it is revoked afterward. A supplied
account token is not replaced or revoked. Native CLI Browser Run authorization
is required separately, without exporting its cached OAuth grant.

The runner captures desktop/phone navigation, target form drafts, Findings and
report dialogs, settings roles, theme switching and optional existing agent
conversations/disclosures/scrolling. It never saves a target, submits a message,
starts a run or presses cancellation/recovery controls. HTTP mutations and
requests outside the installation origin are blocked. These modified conditions
are recorded. Model dropdowns locked by retained runtime state, unavailable
reports and nonoverflowing transcripts are recorded as not exercised, not passed.
Run-deletion QA opens the native confirmation, checks wrong/exact IDs and
cancels, at both widths. It never confirms deletion of an existing user run.
Actual deletion, failure/retry and stale-state fencing use local fixtures.

Console errors, uncaught exceptions and failed request/status metadata are
collected before navigation. URLs omit query values, and response bodies,
credentials and console message text are not logged. Screenshots remain private
and may contain assessment content. Every screenshot needs actual inspection;
offcanvas elements and intentional horizontal scroll regions are not defects
merely because a geometric probe sees them outside a container.

Action traces include screenshots/timing with DOM/network snapshots disabled.
A Python standard-library sanitizer removes credential/header/cookie metadata
and nonimage resources before writing archives. This deliberately limits trace
detail. The runner separately reports network failure/status metadata. A short
frame sample is a laboratory observation of the current page, not INP, an active
streaming acceptance test, Safari/device evidence or a full performance audit.

Readiness uses an authenticated health response matching the unique task ID;
the POST that runs the browser is never blindly retried. The QA Worker has a
`QA_RUN_ID` binding checked before deletion. Its URL and nonsecret ownership IDs
are recorded in the private report. SIGINT/SIGTERM unwind after bounded work;
hard termination can still leave the Worker/resources. Reconcile only the
recorded Worker name plus matching `QA_RUN_ID`, session ID and policy/token IDs.
Never sweep other development Workers, policies or active browsers.

Quick Actions do not prove clicks, typing, focus, scrolling, streaming smoothness,
console/network health, performance traces, Safari or real-device compatibility.
The report explicitly records this blocked coverage. Keep local deterministic
Playwright cases for synthetic streaming, error/empty states and questions,
without paid inference, alongside the deployed screenshot review. Add the
feature-specific interaction case before calling a UI change verified.

## Troubleshooting

- **Login/error page or missing heading:** check the exact app and temporary
  Service Auth policy. Preserve the failure; do not relax Access to everyone.
- **Missing permission/expired CLI grant:** use the selected account role and
  official `cf` reconnect flow; do not copy another application's credential.
- **Still loading:** use the page's appropriate readiness signal and preserve the
  first failed result. Do not enable `bestAttempt` to manufacture a pass.
- **Cleanup unconfirmed:** reconcile only the recorded name/IDs before retrying.
- **Interactive path unavailable:** mark it blocked and retain the screenshot
  review plus affected local interaction tests as their actual, limited coverage.

Official references: [Access service tokens and strict authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
[Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Browser Run Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/),
[Playwright CDP](https://developers.cloudflare.com/browser-run/cdp/playwright/),
[Native Workers Playwright](https://developers.cloudflare.com/browser-run/playwright/),
[Live View CDP links](https://developers.cloudflare.com/browser-run/features/live-view/).

### QA Worker Access context

The disposable QA Worker directly receives the Access-protected request and has
no Static Assets router. It checks Cloudflare's trusted `ctx.access.aud` against
the existing development Access application's audience; it does not parse a JWT
or fetch signing certificates itself. A missing/wrong context is denied, and the
runner verifies anonymous denial before calling the readonly QA entry point.
Production PentCloud retains its JWT validation: its Static Assets router does
not propagate `ctx.access`. See [native Access context and its limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations).
The QA account lease does not request Access organization-read permission.

Before UI assertions, the interactive runner waits for the actual managed browser
to read the protected app's `/health` identity. New Service Auth/edge startup
failures and bounded retries remain in `accessReadiness` and network evidence.
This route reads configuration only and never polls Kali or calls a model.
A failure to become ready blocks UI assertions rather than passing an error page.

## Target setup fixtures

After building the UI, add `--target-access --fixture-origin https://YOUR-OWNED-TEST-TARGET`
to the interactive command to test
program search/import, saved scope, headers and Cloudflare credential references
at desktop and phone sizes. This mode serves actual built UI assets and uses
production stores against a synthetic catalog and your reachable, disposable login
fixture. Use only a task-owned test host with fake credentials. Responses travel
through Chromium, not a synthetic response relay. It makes no model
requests and starts no assessment or production scanner.

The native Browser Run checks include login POST/redirect/cookie reuse, binary
request/response bytes, popup requests, excluded redirects and the Agents SDK CDP
capability boundary. Fixture credentials are disposable; they are never production
secrets. Review the captured UI as well as the JSON results. Synthetic routes do
not establish compatibility with a particular site's login or live Kali tools.

The target-access fixture journey also covers the Bug bounty dashboard tab: a
locked picker, a rejected connection, a successful native-binding check, and
unlocking only that platform. It checks forwarding expiry/retry, readable
verification labels and secret checks that do not display run-start status.
Provider and email replies are synthetic in this fixture; its screenshots do not
prove a live platform login or email delivery.
