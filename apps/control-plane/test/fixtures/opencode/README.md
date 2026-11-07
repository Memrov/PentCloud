# OpenCode reference schemas

Frozen configuration/OpenAPI snapshots for the pinned OpenCode SDK **2.2.6**
integration. These are test data, not active endpoints or runtime records.
The comparator remains strict for the adopted contracts; mutation tests cover
removed operations and changed nested request, response and error schemas.

## Provenance

Source release: [anomalyco/opencode v2.2.6](https://github.com/anomalyco/opencode/tree/v2.2.6),
commit `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`.

- `config-schema.json`: generated from the published `@opencode/schema@2.2.6`
  `Config.Info` export using that release's
  [configuration schema generator](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/schema/script/config-schema.ts)
  and frozen `config-v1.json`. Only module resolution and file I/O were adapted
  to run under Node. This preserves the public schema's deprecated V1 skills
  object branch; installed V2 declarations accept `string[]` only, which remains
  the sole expected comparison difference.
- `openapi.json`: generated with `OpenApi.fromApi(Api)` from the published
  `@opencode/server@2.2.6` `Api` export and installed Effect 4.1.0, using the same
  public declaration generator as `scripts/check-native-upstream-contracts.py`.
  This is a frozen 2.2.6 declaration reference, not a snapshot of a live endpoint.

The 2.2.5 to 2.2.6 review found additive `cache.warming` configuration and
narrower optional parameter nullability. Adopted request bodies and response
schemas were unchanged. Fixtures were refreshed instead of adding drift
exceptions. The source project's [MIT license](LICENSE.txt) is retained.

## Snapshot checksums (SHA-256)

- `config-schema.json`: `d97487fda9279d43b08df45c53bdf644648cb815f3adc0399553de0a7c63aa0c`
- `openapi.json`: `42eb6a8e52829b0623fcb22858c347bc523622ce7f76d99edb2453f88250b5cb`
