---
name: pentcloud-development
description: Use when implementing, debugging, refactoring, reviewing, or testing PentCloud pages, React UI, Cloudflare Workers, Durable Objects, agents, or development tooling.
---

# PentCloud development

Use PentCloud's native stack and make the smallest coherent change that fully meets the request. Resolve repository paths below from the checkout being worked on, not from this installed skill's directory.

## Research before implementation

The first step is to search relevant documentation, before building or changing pages or editing application code.

1. Read the checkout's `AGENTS.md`, task-relevant operation docs, package versions, installed API types and CLI help. Search official vendor documentation for the feature; verify current guidance against the pinned release. Use the Cloudflare docs connector when available and primary sources for technical research.
2. Find and inspect a relevant implementation or test in an open-source repository, preferably the owning upstream project. Record its file/commit permalink and why its version/runtime fits. A docs landing page, search result, or uninspected repository link does not establish an implementation example. Respect the source's license when adapting code.
3. Before editing, give one short research note: **Docs** (specific source), **Example** (inspected upstream code), **Fit and patch** (what applies and the minimum change), **Checks** (behavior and commands). Then proceed within the user's authorization; this note is not an approval request. Keep research proportional to the task while completing both searches. Report unavailable or mismatched evidence honestly.

## Choose the native owner

Read `docs/operations/testing.md` for commands and gate selection, `docs/operations/debugging.md` for diagnosis, and `docs/operations/browser-qa.md` for deployed QA. These repository documents and current configuration own the details.

| Work | First native route | Matching installed skills |
| --- | --- | --- |
| Tooling, types, lint, tests | Vite+ config, `vp help`, bundled `node_modules/vite-plus/docs`; existing tasks/hooks | Relevant testing/debugging skills |
| React pages and controls | Kumo AI usage guide, component registry and types; existing React/Tailwind/Phosphor patterns | `kumo-design`, React/frontend-testing skills |
| Worker requests or state | Cloudflare Vite plugin, Wrangler, Local Explorer schema/traces, SQLite DOs | `wrangler`, `workers-best-practices`, `durable-objects` |
| Agents, sessions and tools | Pinned Agents/OpenCode/Computer APIs, lifecycle, Artifacts/Git, existing tool adapters | `agents-sdk` |
| Browser behavior | Shared Node Playwright fixtures, Cloudflare test harness, native traces/reports | `playwright`; `cloudflare-browser-qa` for deployed QA |
| Platform or CI investigation | Connected Cloudflare schema/API and GitHub metadata/jobs/logs; scoped native CLI fallback | Cloudflare/Access or AWS skills only for the affected subsystem |

Load only relevant available skills. When optional guidance such as `workers-development`, `workers-profiling` or `cf-cli` is absent, use official docs and installed help; do not assume it is installed.

Prefer native components, binding fixtures, outbound mocks, generated types, task ordering and diagnostics over another dependency, HTTP driver, wrapper or abstraction. Native capability does not replace PentCloud's authorization, admission, idempotency, recovery or provenance policy.

## Small patch, high quality

- Preserve unrelated work and existing contracts. Reuse established code; isolate only the responsibility needed by the change. Avoid adjacent cleanup and speculative infrastructure.
- Keep types precise, errors observable and boundaries explicit. Review any new cast, suppression, dependency, public interface or extra file for necessity. Do not weaken assertions, disable isolation, raise warning ceilings or skip scenarios to obtain green checks.
- Verify meaningful behavior with existing tests and a regression where needed. Use focused feedback during edits, then the gate required by `docs/operations/testing.md`. Preserve crash/storage, real transport, privacy and permission checks when reducing duplicate tests.
- For UI changes, check keyboard/accessibility behavior and inspect affected desktop/mobile evidence. A successful build or loading-page screenshot does not establish correct UI behavior.
- Use local traces before adding diagnostic code. Check remote bindings before writing test state. Keep local fixture success distinct from deployed Access/CDP, live model or scanner acceptance.

## Finish with evidence

`vp check` is static; `vp run check` is the app gate. Root `vp run build` is the customer build. Keep runtime/browser/build gates fresh; only the configured static task is cached. Preserve per-test browser URLs after native resets and runtime collection of imported Workers cases.

Run appropriate checks, inspect the diff, and report the change, actual results and material limits. Local work does not authorize cloud changes, paid probes, messages, merge or deployment; reuse authorization already given instead of asking again.

Native routing example: [Cloudflare workers-development skill](https://github.com/cloudflare/skills/blob/6eb6c781aa9b6438e0c7307bd102788a75fe1a6d/skills/workers-development/SKILL.md). Skill format: [Agent Skills specification](https://agentskills.io/specification).
