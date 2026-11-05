# OpenCode reference schemas

OpenCode configuration/OpenAPI snapshots used by the contract comparison tests
for the pinned OpenCode SDK 2.2.5 integration. These are test data, not active
endpoints, installation configuration or runtime records. The tests compare the
adopted contracts and retain the documented deprecated-skills schema difference.

The configuration schema identifies its public source as
https://opencode.ai/config.json. The OpenAPI snapshot identifies itself as the
experimental opencode HttpApi, OpenAPI 3.1.0 / API 0.0.1. These fixtures are
frozen references; they do not claim to track the latest upstream API.

Source project: [anomalyco/opencode](https://github.com/anomalyco/opencode).
The [MIT license](LICENSE.txt) is retained from the SDK's
[v2.2.5 source release](https://github.com/anomalyco/opencode/tree/v2.2.5).

Snapshot checksums (SHA-256):

- `config-schema.json`: `7feca1416fc02b39201e468160199cbe5957792523f482e35c050f8996dcb0ad`
- `openapi.json`: `92cc33ef9a107c8af6295e6fcbdf6d339d4374955910924456bd91a76844a5db`
