#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
renderer_go="${GO_BIN:-go}"
renderer_version="$($renderer_go env GOVERSION)"
if [[ "$renderer_version" != go1.26.5 ]]; then
  echo "prompt renderer requires Go 1.26.5; got $renderer_version (set GO_BIN)" >&2
  exit 1
fi
renderer_assets=apps/control-plane/src/native/assets
mkdir -p "$renderer_assets"
CGO_ENABLED=0 GOOS=js GOARCH=wasm "$renderer_go" build -trimpath -buildvcs=false -ldflags='-s -w' \
  -o "$renderer_assets/prompt-renderer.wasm" ./cmd/pentcloud-render-wasm
cp "$renderer_assets/prompt-renderer.wasm" "$renderer_assets/prompt-renderer.bin"
# Keep the matching upstream runtime and its copyright notice verbatim.
cp "$($renderer_go env GOROOT)/lib/wasm/wasm_exec.js" "$renderer_assets/wasm_exec.js"
cp "$renderer_assets/wasm_exec.js" "$renderer_assets/wasm_exec.txt"
cp "$($renderer_go env GOROOT)/LICENSE" "$renderer_assets/GO-LICENSE"
(
  cd "$renderer_assets"
  sha256sum prompt-renderer.wasm prompt-renderer.bin wasm_exec.js GO-LICENSE > SHA256SUMS
)

cp "$renderer_assets/SHA256SUMS" "$renderer_assets/SHA256SUMS.txt"
