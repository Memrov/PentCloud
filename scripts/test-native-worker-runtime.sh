#!/usr/bin/env bash
# Router/API and migrated probe verification in the Cloudflare Workers runtime.
# Remaining integration probes use Wrangler createTestHarness separately.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../apps/control-plane"
node ../../node_modules/vitest/vitest.mjs run --config vitest.runtime.config.ts "$@"
