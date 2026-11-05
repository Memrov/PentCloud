#!/usr/bin/env bash
# Documentation assets only; no package install, runtime build or deployment.
set -euo pipefail

media_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
d2_bin="${D2_BIN:-d2}"
if [[ "$("$d2_bin" --version)" != "v0.9.0" ]]; then
  echo "Use D2 v0.9.0 to reproduce these documentation assets." >&2
  exit 1
fi

for source in "$media_dir"/diagrams/*.d2; do
  name="$(basename "$source" .d2)"
  [[ "$name" == _* ]] && continue
  "$d2_bin" --layout elk --theme 101 --dark-theme -1 --pad 24 "$source" "$media_dir/$name.light.svg"
  "$d2_bin" --layout elk --theme 200 --dark-theme -1 --pad 24 "$source" "$media_dir/$name.dark.svg"
  "$d2_bin" --layout elk --theme 101 --dark-theme -1 --pad 24 "$source" "$media_dir/$name.light.png"
  "$d2_bin" --layout elk --theme 200 --dark-theme -1 --pad 24 "$source" "$media_dir/$name.dark.png"
done
