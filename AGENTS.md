<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## PentCloud commands

Run commands from the repository root. Use `vp install --frozen-lockfile` for a clean checkout. The global CLI selects Node from `.node-version` and npm from `packageManager`; without it, use `npm ci` and `npm exec -- vp ...`.

- `vp check`: static checks only (format, lint, TypeScript). Root `vite.config.ts` owns lint severities and formatter exclusions.
- `vp test`: all unit, contract and Workers projects. Units use threads with file isolation retained. `vp test --project unit` selects unit tests; `vp test --project attempt` selects the native attempt runtime project. Use `--project contracts` for upstream schema checks and `--project coordinator` for admission/materials/lifecycle recovery.
- `vp run test:customer` and `vp run test:browser`: customer Worker and Playwright fixtures. Install Chromium with `vp exec playwright install chromium` when needed.
- `vp run check`: the existing fast app verification gate, including generated Worker type freshness and runtime/customer tests.
- `vp run verify:full`: the complete app/gateway/integration/build gate. Requires Python 3.11+ and Go 1.26.5; set `GO_BIN` to that Go binary if necessary.
- `vp run build`: the customer build and its compiled-output checks. `vp run @pentagi-artifacts/control-plane#build` builds the existing app target. Bare root `vp build` is not the customer build.

Scripts are uncached by default; only `vp run check:static` opts into caching. That task runs native formatting and type-aware lint with the warning ceiling in `vite.config.ts`; reduce the ceiling when fixing backlog, and do not raise it to make a check pass. Never pass `--cache` to runtime, integration, browser, deployment, or full-verification commands: recovery evidence must come from a fresh execution. Preserve Cloudflare's isolated projects and the OpenCode snapshot transform. Do not weaken assertions or skip scenarios to resolve migration failures.

See [development and testing](docs/operations/testing.md) for the complete gates and build-target contracts. Verification uses local fixtures; production deployment is a separate action.

For focused development use `vp test related <source-file> --project unit`, `vp test --project unit --changed`, `vp test --project unit --lastFailed`, or `vp test watch --project unit`. Use `vp test doctor --project unit` to measure runner settings. Affected-test selection does not replace the full gate for dynamic imports, fixtures, or external contracts.

List imported Workers cases with `vp test list --project attempt --no-static-parse` (or `--project coordinator`). Vitest's default static listing only sees their entry module; runtime collection discovers all case imports.

Native `gate:*` tasks in `scripts/verification-tasks.ts` declare verification dependencies and set `cache: false`, including runtime, transport, browser and customer build/deploy gates. Existing npm/Bash entries remain compatible. Pass filters directly after the task name, for example `vp run test:browser --grep "native questions"` (Vite Task forwards additional arguments without an npm-style separator). Keep direct build/deploy/browser scripts so their flags retain their original behavior.

Browser tests import `test` and `expect` from `scripts/browser-qa/fixtures.mts`. Playwright owns a Cloudflare `createTestHarness()` per worker and resets it between tests; resolve URLs from the per-test `baseURL` because reset can change the port. The fixture builds the actual UI and a test-only Worker once, retaining production CSP and real SSE bytes. Use `vp run test:browser --ui`, `--last-failed`, or `--grep "..."` for focused feedback. Native failure traces/screenshots and the HTML report live under `node_modules/.cache/`; open the report with `vp exec playwright show-report node_modules/.cache/pentcloud-browser-report`. UI mode reruns tests but does not rebuild compiled assets after application source edits; restart the command after those edits. Keep deployed Access/CDP reviews separate.
