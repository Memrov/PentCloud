# Installation configuration

These templates describe the resources generated for a self-hosted PentCloud
installation. Start with [deployment](../../docs/deployment.md),
[requirements and costs](../../docs/requirements.md), and
[Cloudflare/OpenCode setup](../../docs/cloudflare-setup.md).

Copy [pentcloud.example.json](pentcloud.example.json) outside Git. Set your
Cloudflare account ID, unique instance name, Access team domain and allowed
operator emails. The CLI writes generated Worker configs and ownership state
to the directory selected with `--state`.

```sh
cp templates/private-install/pentcloud.example.json ../my-pentcloud.json
# Edit the copied configuration before running these commands.
node scripts/pentcloud.mjs plan --config ../my-pentcloud.json
node scripts/pentcloud.mjs install --config ../my-pentcloud.json --state ../my-pentcloud-state --apply
```

`app.json` and `gateway.json` are base templates, not standalone deployment
configs. The installer fills account-local resource bindings, Access settings
and the prepared Kali image. Keep generated state outside Git and reuse it for
recovery, upgrades and scoped deletion. Never add credentials to these templates.
