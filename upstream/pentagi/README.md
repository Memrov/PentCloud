# Preserved PentAGI reference

The 39 templates in `prompts/` and `manifest.json` preserve the import from
[vxcontrol/pentagi](https://github.com/vxcontrol/pentagi/tree/cffed9485aa1cca70762cd08a57ac62a80406258).
The manifest records the exact commit and individual/aggregate SHA-256 hashes.
The original text and attribution remain unchanged. `internal/contracts` tests
verify these canonical bytes; no second prompt copy is needed.

## Historical native adaptation — November 8, 2026

`native-specialists-provenance.json` is the unchanged adaptation record previously
stored at `apps/control-plane/src/native/specialists/provenance.json` in
[PentCloud commit 7857915](https://github.com/Memrov/PentCloud/tree/7857915650c25de0842ee96a62f7d0d12d49747a).
It preserves original/rendered paragraphs, explicit adaptations and output hashes
from the retired Go generator. Its source paths, backend descriptions and output
hashes describe that historical baseline, not current runtime defaults. Historical
`internal/prompts/assets` paths were byte-identical mirrors of `prompts/`.

The complete original Markdown output and generator remain in that Git revision.
Current defaults are edited directly in
[`apps/control-plane/src/native/specialists`](../../apps/control-plane/src/native/specialists/README.md).
`scripts/import-pentagi.sh` only refreshes the pinned reference and contract
snapshot; adapting upstream changes into runtime policy is an explicit review.
