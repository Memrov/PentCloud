# Agent prompt sources

These runtime defaults adapt PentAGI's specialist guidance to Cloudflare Computer,
OpenCode and the shared Kali toolbox. Eight role files supply the always-loaded
role guidance; tools.md supplies the bundled pentcloud-tools skill.
The original upstream/internal Go templates remain unchanged.

Regenerate from the repository root with Go 1.26.5:

    go run ./scripts/native-specialists
    go run ./scripts/native-specialists -check
    go test ./scripts/native-specialists ./internal/contracts

provenance.json records original paragraphs, explicit runtime adaptations and
source/output hashes. Tests verify the original template hashes, deterministic
output and retained role/procedure obligations. Go templates are build-time
provenance only; new settings and launches require explicit Markdown instructions.
