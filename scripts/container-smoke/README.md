# Computer container smoke

This local fixture uses the customer Computer image and the pinned
`ContainerBackend` to test a Durable Object to container connection. It reads a
Workspace file in Linux, runs Node and ripgrep, writes another file, and checks
the synchronized result. It does not make a model request or contact a target.

With Docker running, start the Worker from the repository root:

```sh
vp exec wrangler dev --config scripts/container-smoke/wrangler.jsonc --port 8798 --local
```

In another terminal, check the response:

```sh
curl -fsS http://localhost:8798/ | jq -e '.exitCode == 0 and .returned == "from-container" and (.stdout | contains("pentcloud-container-marker"))'
```
