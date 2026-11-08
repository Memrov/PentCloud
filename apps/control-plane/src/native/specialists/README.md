# Agent prompt sources

Edit these Markdown files directly. They are the canonical defaults loaded by
OpenCode; there is no prompt generator. The eight role files keep methodology,
completion, language, scope, cancellation and receipt rules always loaded.
They do not promise a particular scanner backend.

The runtime selects the `pentcloud-tools` skill from trusted installation bindings:
`tool-packs.md` for bounded native tool packs, or `tools.md` for legacy stock Kali.
Only advertised tools and their schemas grant capabilities. Detailed procedures
belong in the applicable skill; mandatory safety rules stay in every role.

The [original PentAGI prompts and frozen adaptation record](../../../../../upstream/pentagi/README.md)
retain attribution, source hashes and the former generator's paragraph mapping.
Future upstream updates require an explicit reviewed Markdown change; importing
the reference snapshot does not regenerate these defaults.

Native launch tests cover both backends and always-loaded policies. Saved role
settings and existing attempts keep their original bytes and digests. Reset a
saved role to its default in settings to adopt these instructions for future runs.
