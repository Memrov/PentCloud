# Installation configuration

Run `npm run pentcloud -- setup` for guided account/domain/owner selection.
See [deployment](../../docs/deployment.md) and [requirements](../../docs/requirements.md).

For explicit setup, copy [pentcloud.example.json](pentcloud.example.json) outside
Git and select your account, active zone, unused hostname, existing Access team
and operator emails. New schema-2 installs build the eleven pinned tool packages
in your own registry. Keep configuration, ownership state and image cache outside Git.

```sh
cp templates/private-install/pentcloud.example.json ../my-pentcloud.json
# Edit the private configuration.
npm run pentcloud -- plan --config ../my-pentcloud.json
npm run pentcloud -- install --config ../my-pentcloud.json --state ../my-pentcloud-state --apply
```

`app.json` is a rendering base. `gateway.json` is retained for existing legacy
installations; new installs render the package gateway from `infra/tool-packs`.
Neither is a standalone production configuration. Native Artifacts checkpoints
installation ownership for recovery; no credentials belong in these templates.
