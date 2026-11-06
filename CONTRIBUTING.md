# Contributing

Use issues for reproducible bugs, documentation corrections and focused proposals.
Read [SECURITY](SECURITY.md) and use
[private vulnerability reporting](https://github.com/Memrov/PentCloud/security/advisories/new)
for security flaws. Keep real credentials, target identities, transcripts,
installation state and private evidence out of issues, PRs and workflow artifacts.

## Development

Use the toolchain versions in [the development guide](docs/operations/testing.md).
Install dependencies with `npm ci`. Run `npm run check` for the fast gate;
backend, authentication, dependency or deployment changes require
`npm run verify:full`. UI behavior changes also need the relevant browser fixtures
and visual inspection. Record the commands, results and any skipped checks in
the PR. Do not equate synthetic checks with a live customer-install test.

Public CI must stay synthetic: no account/target/model/npm credentials, live
scans, paid model requests or production deployments. Use synthetic targets and
minimal reproductions. Do not execute another person's target without permission.

## Pull requests

Keep changes focused and describe the concrete problem, resulting behavior and
validation. Identify any auth, admission, evidence, network, migration or dependency
impact. Preserve source attribution and third-party license notices. If AI helped
produce code or findings, review the result and verify its claims yourself;
include material verification limits. Contribution does not require using AI.

Pin GitHub Actions to full commit SHAs and use the least token permissions needed.
Upgrading an allowlisted third-party action also requires maintainer review of
the repository's exact action-SHA allowlist.
Keep publishing/deployment changes separate and explicit. The owner listed in
[CODEOWNERS](.github/CODEOWNERS) reviews the project; ownership alone does not
establish independent review. Follow [the code of conduct](CODE_OF_CONDUCT.md).
