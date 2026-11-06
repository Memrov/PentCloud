# Native tool packs

This optional private Worker connects the PentCloud scanner roles to the bounded `@memrov2/pentcloud-*` SDKs. Browser Run and Computer retain their existing roles. An installation without `TOOL_PACKS` continues to use its existing Kali gateway.

Build the pinned pack images with [PentCloud-tools](https://github.com/Memrov/PentCloud-tools), then provide their immutable image references in a private deployment configuration. The checked-in Wrangler file intentionally contains no account, registry or image references. Exported SDK classes own native Cloudflare Container lifecycle; the gateway uses service-binding RPC and has no public execution endpoint.

After deploying the private Worker, add this service binding to the app's deployment configuration:

```json
{"binding":"TOOL_PACKS","service":"your-private-tool-worker","entrypoint":"ToolPackGateway"}
```

Keep the existing bindings and secrets. Backend selection is pinned when an attempt is created. Scanner roles prepare the HTTP pack while preparing their workspace; other packs start on demand. Each runtime belongs to a run and attempt, and terminal cleanup permanently retires that identity. A later attempt uses a new identity. Scanner tools, inputs and limits remain bounded by the SDK profiles; this is not full Kali parity or universal network scope enforcement.

Completed calls replay their durable receipts. Uncertain dispatches block automatic repeat scans. File inputs come from guarded repository or per-attempt scratch paths. Binary inputs can be generated with Cloudflare Computer’s native JavaScript filesystem in scratch; exact scratch input bytes are copied into existing immutable evidence before execution. Inputs have a combined two MiB limit. Full results use the existing immutable Git evidence checkpoints; large results are split into bounded files, with repository paths in the `result.json` concatenation manifest. The model receives a smaller preview. Existing per-attempt evidence limits still apply and incomplete collection is disclosed.

SDK prereleases are explicitly pinned for development validation. Changing a dependency or image requires the SDK checks, application checks and native end-to-end validation before a production rollout. Public CI runs synthetic checks and receives no target or Cloudflare credentials.
