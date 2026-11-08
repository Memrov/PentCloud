#!/usr/bin/env bash
# Fast native build gate by default; --full retains the complete recovery suite.
# Dependencies are installed once by Cloudflare Builds, or by local `npm ci`.
# This script never deploys or contacts the production model/toolbox.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
worker=app
full=0
check_only=0
while (( $# )); do
  case "$1" in
    --worker) [[ $# -ge 2 ]] || { echo '--worker needs app, gateway, or all' >&2; exit 64; }; worker=$2; shift 2;;
    --full) full=1; shift;;
    --check) check_only=1; shift;;
    --help) echo 'Usage: native-cloudflare-verify.sh [--worker app|gateway|all] [--full] [--check]'; exit 0;;
    *) echo "Unknown verification option: $1" >&2; exit 64;;
  esac
done
case "$worker" in app|gateway|all) ;; *) echo "Unknown verification worker: $worker" >&2; exit 64;; esac
node --input-type=module -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number); if(major!==26 || minor<12 || (minor===12 && patch<1)) throw new Error("Node 26.12.1 or later 26.x is required")'
[[ -f node_modules/wrangler/bin/wrangler.js ]] || {
  echo 'Dependencies are missing. Run npm ci once locally; Workers Builds installs from the root lockfile automatically.' >&2
  exit 65
}
export WRANGLER_SEND_METRICS=false
# Formatting, type-aware lint and type checks share the root Vite+ policy.
npm exec -- vp run check:static
# Generated runtime types are committed; regenerate with `npm run types` in the
# Worker's workspace after changing its Wrangler config or compatibility date.
types_check() { env -u WRANGLER_CI_OVERRIDE_NAME -u WRANGLER_CI_MATCH_TAG npm run types:check --workspace "$1"; }
if [[ "$worker" != gateway ]]; then
  types_check @pentagi-artifacts/control-plane
  types_check @pentcloud/tool-packs
  npm run typecheck --workspace @pentagi-artifacts/control-plane
  npm run typecheck --workspace @pentcloud/tool-packs
  npm run test:unit
  npm run test:workers
  npm run test:customer
  node --test scripts/test-customer-deploy.mjs
  if (( full )); then
    # Cloudflare Builds supplies GO_VERSION; local setup selects the same compiler.
    # A wrong compiler fails immediately rather than installing inside a test loop.
    native_go=${PENTCLOUD_GO_BINARY:-${GO_BIN:-$(command -v go || true)}}
    if [[ -z "$native_go" ]] || [[ $("$native_go" env GOVERSION 2>/dev/null) != go1.26.5 ]]; then
      echo 'Full app checks require Go 1.26.5. Set GO_BIN locally; pin GO_VERSION=1.26.5 in Workers Builds.' >&2
      exit 65
    fi
    export PENTCLOUD_GO_BINARY="$native_go"
    export GO_BIN="$native_go"
    export PATH="$(dirname -- "$native_go"):$PATH"
    npm run build --workspace @pentcloud/tool-packs
    "$native_go" test ./... -count=1
    "$native_go" vet ./...
    node --test scripts/test-native-test-harness.mjs scripts/test-native-canary-defaults.mjs
    node --test scripts/test-native-auth.mjs scripts/test-browser-run-qa.mjs scripts/test-cloudflare-build-config.mjs
    node scripts/test-native-run-lifecycle.mjs
    node --test apps/control-plane/test/native-kali-canary/contract.node.mjs
    npm run test:integration
  fi
  if (( ! check_only )); then
    npm run deploy:dry-run --workspace @pentagi-artifacts/control-plane
  fi
fi
if [[ "$worker" != app ]]; then
  # App Builds pins Wrangler to the app identity. Gateway fixtures stay local.
  types_check @pentagi-artifacts/aws-toolbox-control
  npm run typecheck --workspace @pentagi-artifacts/aws-toolbox-control
  env -u WRANGLER_CI_OVERRIDE_NAME -u WRANGLER_CI_MATCH_TAG npm test --workspace @pentagi-artifacts/aws-toolbox-control
fi
