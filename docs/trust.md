# Verify PentCloud

PentCloud is a self-hosted preview. Public checks and reproducible evidence help
you evaluate it; this project has no independent security certification. Review
[the threat and operational boundaries](../SECURITY.md) before using real targets
or credentials.

## Follow the three repositories

| Repository | Responsibility | Evidence to inspect |
| --- | --- | --- |
| [PentCloud](https://github.com/Memrov/PentCloud) | App, admission, sessions, authentication and evidence handling | Exact deployed commit, CI, CodeQL, PR discussion and documented limits |
| [PentCloud-tools](https://github.com/Memrov/PentCloud-tools) | Scanner adapters and Cloudflare runtimes | Exact npm version, lockfile integrity, tool/image pins, release checksums and third-party licenses |
| [PentCloud-scopes](https://github.com/Memrov/PentCloud-scopes) | Public bug bounty scope data | Catalog commit, manifest, source commit/timestamps and validation history |

Each repository has its own checks and security-reporting channel. An application
commit does not identify every separately deployed image, configuration or data
revision. Record those references when deploying and investigating a result.
The public catalog helps discovery; program rules and explicit authorization
remain the operator's responsibility.

## Read the badges as links to evidence

- [CI](https://github.com/Memrov/PentCloud/actions/workflows/ci.yml?query=branch%3Amain)
  runs the application checks and synthetic browser fixtures. Public Actions do
  not have production, model, target or Cloudflare credentials. A green fixture
  run does not establish a successful installation in another account.
- [CodeQL](https://github.com/Memrov/PentCloud/actions/workflows/codeql.yml?query=branch%3Amain)
  analyzes Actions, Go, JavaScript/TypeScript and Python with the extended security
  query suite. Its badge reports workflow status. Review findings in the Security
  tab and PR discussions separately; a successful scan can still report findings.
- [Dependency review](https://github.com/Memrov/PentCloud/actions/workflows/dependency-review.yml)
  checks dependency changes on pull requests and rejects newly introduced high
  or critical vulnerabilities. It does not establish that all existing or
  undisclosed vulnerabilities are absent.
- [Snyk](https://snyk.io/test/github/Memrov/PentCloud) provides dependency checks
  through the existing GitHub integration in the `memrov` Snyk organization.
  The badge currently says **monitored**; it is not a vulnerability count.
  Inspect the `security/snyk (memrov)` PR status and its linked report: a passing
  status may say **No manifest changes detected**, which is not a fresh scan of
  every dependency. Coverage depends on the imported manifests and enabled
  products. It does not establish coverage of separately deployed scanner images.
- [OpenSSF Scorecard](https://github.com/Memrov/PentCloud/actions/workflows/scorecard.yml)
  is configured to inspect public repository practices on default-branch pushes
  and weekly. The workflow requests public results from OpenSSF and retains its
  scan output as a workflow artifact.
  The numeric badge should be added only after a published result exists. A score
  measures repository practices, not application exploit resistance or scanner
  accuracy. Some controls may be unavailable to the workflow's read token; this
  workflow receives no administrative PAT.
- The MIT badge describes this repository's license. Upstream scanner binaries,
  images, prompts and data have their own notices and licenses.

Use a result for the exact commit you intend to deploy. Default-branch workflow
badges can describe an older run while a newer run is pending; a scheduled badge
does not independently prove that a scheduler is still running.

For a local dependency scan after installing the development dependencies, use
the [Snyk CLI authentication instructions](https://docs.snyk.io/developer-tools/snyk-cli/authenticate-to-use-the-cli)
and run:

```sh
snyk auth
snyk test --all-projects --dev --org=memrov --remote-repo-url=https://github.com/Memrov/PentCloud
```

Organization membership is required. The explicit public repository URL helps
Snyk classify the scan correctly. Check the account's actual plan and usage;
open-source program benefits require eligibility and do not follow from a badge.
The GitHub app handles imported projects without a Snyk credential in Actions.
Keep local CLI credentials outside the repository and review the imported
projects before creating additional `snyk monitor` snapshots.

The GitHub import includes the root npm manifest, `go.mod`, and the explicitly
imported app and gateway npm workspaces, with daily testing configured. Npm
development dependency scanning is enabled. SCM scanning approximates nested
manifests without adjacent lockfiles instead of using the workspace root lockfile.
Run the CLI from the repository root with `--all-projects` as well. Compare
reported versions with `package-lock.json` and `npm ls` before triage: CLI 1.1308.4
reported older Undici versions despite the committed overrides and installed
patched versions. A scan of one manifest or a reduced dependency tree is not a
substitute for checking the full workspace graph. Snyk documents
[SCM workspace limitations](https://docs.snyk.io/supported-languages/supported-languages-list/javascript#support-for-monorepos-and-workspaces).

## Inspect dependencies and releases

GitHub exposes the [dependency graph](https://github.com/Memrov/PentCloud/network/dependencies)
and an exportable SPDX software bill of materials. Use **Insights → Dependency
graph → Export SBOM**, or the current
[GitHub SBOM API](https://docs.github.com/en/rest/dependency-graph/sboms), to obtain
an inventory. Inspect the export's creation time and commit/reference.

The graph inventory covers dependencies GitHub recognizes in this repository.
It is not a complete inventory of deployed Cloudflare resources, model providers,
runtime configuration or scanner Container operating-system packages. For tools,
review the version/checksum pins and upstream notices as well. A complete image
inventory and image vulnerability assessment require the exact image digest.

GitHub release immutability is enabled for future releases. It protects the tag
and assets of a published immutable release; it does not turn historical mutable
releases, moving branches or npm packages into attested builds. Maintainers must
attach every asset to a draft before publishing an immutable release.

For any downloaded package or image, distinguish:

1. A checksum or registry signature checks the artifact against the published
   bytes/registry statement.
2. Build provenance links artifact bytes to a builder, source revision and build
   workflow. GitHub artifact attestations and npm provenance are mechanisms for
   publishing that evidence, but evidence must exist for the exact artifact.
3. Neither mechanism establishes that the source is free of vulnerabilities.

The current tools packages have registry signatures and release checksums; their
existing releases do not have npm build-provenance attestations. Moving future
publication to OIDC trusted publishing, generating exact-image SBOMs and attesting
the distributed artifacts are release follow-ups. No public workflow in this
update publishes packages, images or production deployments.

## Contribute and disclose

Read [CONTRIBUTING](../CONTRIBUTING.md) for checks and safe reproductions. Use the
[private security report form](https://github.com/Memrov/PentCloud/security/advisories/new)
for vulnerabilities; keep credentials and private evidence out of public issues.
`CODEOWNERS` identifies the maintainer but does not imply an independent human
approved every change. Review the actual PR approvals and branch rules.
