#!/usr/bin/env bash
# Compatibility entry for npm and Cloudflare Builds; Vite Task owns the graph.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
worker=app
full=
checks=
while (( $# )); do
  case "$1" in
    --worker) [[ $# -ge 2 ]] || { echo '--worker needs app, gateway, or all' >&2; exit 64; }; worker=$2; shift 2;;
    --full) full=:full; shift;;
    --check) checks=:checks; shift;;
    --help) echo 'Usage: native-cloudflare-verify.sh [--worker app|gateway|all] [--full] [--check]'; exit 0;;
    *) echo "Unknown verification option: $1" >&2; exit 64;;
  esac
done
case "$worker" in
  app|all) task="gate:${worker}${full}${checks}";;
  gateway) task=gate:gateway;;
  *) echo "Unknown verification worker: $worker" >&2; exit 64;;
esac
export WRANGLER_SEND_METRICS=false
exec npm exec -- vp run "$task"
