# Cloudflare error checks

Use the existing Cloudflare MCP search/execute tools. Do not place an account API token in PentCloud, the plugin package, browser code or a prompt. Cloudflare administration access is separate from the PentCloud operator's OAuth connection; a working PentCloud tool does not prove log access.

For this Dev connection, the verified account is `e3d8d696e0f67bd937662e1f4363f445`, app Worker `pentcloud-dev-app`, public host `dev.pentcloud.dev`. Confirm the installation before using those values. Other installations need their own verified account and Worker names; never default them to this account. Query other services only when the tested journey uses them and their identity has been verified.

## Baseline and checkpoints

1. Record the UTC test start time. Read active issues using `GET /accounts/{account_id}/workers/observability/issues` with `service` set to the exact Worker, `status: active`, `orderBy: lastObserved`, `order: desc`. Retain issue IDs, counts and last-observed times. Old active issues are a baseline, not automatically new failures.
2. Discover keys using `POST /accounts/{account_id}/workers/observability/telemetry/keys`, restricted to `cloudflare-workers`, the exact `$metadata.service` and a short timeframe. Use the available keys' actual types. Inspect current API schemas through Cloudflare search before changing the query below.
3. Run an ephemeral events query at the start, after significant actions, at progress checkpoints and at completion. Use milliseconds since epoch. Begin with a 15-minute baseline; subsequent windows begin five seconds before the last fully covered error-query window's end. Keep separate watermarks for each service/filter set and for error queries versus normal-activity probes. A successful activity probe cannot close an error-monitoring gap. Deduplicate overlap by event ID and retain the watermarks in the test ledger.
4. Fetch subsequent pages with `offset` set to the last event's `$metadata.id` and `offsetDirection: next` when the event array fills the limit or the returned count indicates more results. Preserve the timeframe and filters. Advance a watermark only after all required pages succeed. A practical bound is four pages of 50 events per checkpoint; if any page fails or the cap is reached with more results outstanding, retain the previous watermark, report incomplete coverage and narrow the failing time interval.

The following body has been exercised against the Dev Worker with the native Cloudflare API. Substitute the current window and verified Worker name. Nested OR error conditions remain inside the outer AND service filter.

```js
const to = Date.now();
const body = {
  "queryId": "pentcloud-product-qa-errors",
  "view": "events",
  "dry": true,
  "limit": 50,
  "timeframe": { "from": to - 15 * 60 * 1000, "to": to },
  "parameters": {
    "datasets": ["cloudflare-workers"],
    "filterCombination": "and",
    "filters": [
      {
        "key": "$metadata.service",
        "operation": "eq",
        "type": "string",
        "value": "pentcloud-dev-app"
      },
      {
        "kind": "group",
        "filterCombination": "or",
        "filters": [
          { "key": "$metadata.error", "operation": "exists", "type": "string" },
          { "key": "$metadata.level", "operation": "eq", "type": "string", "value": "error" },
          { "key": "$workers.event.response.status", "operation": "gte", "type": "number", "value": 500 },
          { "key": "$workers.outcome", "operation": "not_in", "type": "string", "value": "ok,canceled" }
        ]
      }
    ]
  }
};
```

Send this body to `POST /accounts/{account_id}/workers/observability/telemetry/query`. `dry: true` avoids saving the query/results. This data query currently requires Cloudflare's **Workers Observability Write** permission; issue reads accept Read or Write. Report a permission failure as a monitoring gap; do not broaden permissions automatically.

Return only the needed fields from `result.events.events`: timestamp, `$metadata.id`, error/message, level, request ID, and the Worker's outcome, entrypoint, script-version ID and response status. Exclude raw `source`, request headers, cookies, authorization assertions and whole requests. Review error/message strings for secrets before quoting them. Avoid publishing shared-query links containing private results.

Correlate events with the tested action's time, path, run/job/request ID and deployed version. Keep old issues separate; flag an old issue as recurring when its count/time advances. `canceled` can be relevant to a failed journey even though the broad error query excludes ordinary cancellations. Inspect its specific request when the observed behavior calls for it.

## Interpret coverage honestly

An empty query means no matching retained events in that window. Check that collection is enabled and that expected app activity appears in a service-scoped non-error query before calling log coverage verified. Sampling, retention, ingestion delay and result limits can leave gaps. Recheck the final interval after another useful test step when possible, and report a very recent unconfirmed interval explicitly. A 403, disabled collection or empty stale dataset is not a clean error report.

For a new error, send an immediate short update with user impact, occurrence time, IDs/version and the next diagnostic step. Group repeated events by fingerprint or stable error/entrypoint/version; preserve individual IDs for correlation. Do not resolve Cloudflare issues, deploy fixes, change sampling or start notifications merely to test monitoring.

## Sources

- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [error filters](https://developers.cloudflare.com/workers/observability/errors/).
- [Workers Observability API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/) owns current request types and permissions.
- [Cloudflare SDK query example](https://github.com/cloudflare/cloudflare-typescript/blob/0eb9ef0ea40c1fe38e4b19be92f41bd7466bc1d6/tests/api-resources/workers/observability/telemetry.test.ts) demonstrates the parameters. Its generated query tests are skipped, so they establish the schema example, not live correctness; the live Dev query supplies that evidence here.
