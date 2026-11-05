#!/usr/bin/env bash
set -euo pipefail

readonly expected_commit="cffed9485aa1cca70762cd08a57ac62a80406258"
readonly expected_digest="fe64d11a7a9ad76f9c9664ad7066b059dbfa51e4950999688470680d3801720a"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <pentagi-checkout>" >&2
  exit 2
fi

upstream_root=$(cd "$1" && pwd -P)
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
actual_commit=$(git -C "$upstream_root" rev-parse HEAD)
if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "PentAGI commit $actual_commit does not match pinned $expected_commit" >&2
  exit 1
fi

source_dir="$upstream_root/backend/pkg/templates/prompts"
mapfile -t prompt_names < <(find "$source_dir" -maxdepth 1 -type f -name '*.tmpl' -printf '%f\n' | LC_ALL=C sort)
if [[ ${#prompt_names[@]} -ne 39 ]]; then
  echo "expected 39 prompt templates, found ${#prompt_names[@]}" >&2
  exit 1
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/upstream/pentagi/prompts" "$stage/contracts" "$stage/backend/.pentagi-export-tools" "$stage/backend/.pentagi-render-golden" "$stage/golden"

for name in "${prompt_names[@]}"; do
  cp "$source_dir/$name" "$stage/upstream/pentagi/prompts/$name"
done

python3 - "$stage" "$expected_commit" "$expected_digest" "${prompt_names[@]}" <<'PY'
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

stage = Path(sys.argv[1])
commit = sys.argv[2]
expected = sys.argv[3]
names = sys.argv[4:]
files = []
aggregate = bytearray()
for name in names:
    vendored = f"upstream/pentagi/prompts/{name}"
    source = f"backend/pkg/templates/prompts/{name}"
    digest = hashlib.sha256((stage / vendored).read_bytes()).hexdigest()
    files.append({"source_path": source, "vendored_path": vendored, "sha256": digest})
    aggregate.extend(f"{digest}  {source}\n".encode())
actual = hashlib.sha256(aggregate).hexdigest()
if actual != expected:
    raise SystemExit(f"prompt aggregate {actual} does not match pinned {expected}")
manifest = {
    "repository": "https://github.com/vxcontrol/pentagi.git",
    "commit": commit,
    "aggregate_sha256": actual,
    "files": files,
}
(stage / "upstream/pentagi/manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY

cp -a "$upstream_root/backend/." "$stage/backend/"
cp "$repo_root/scripts/export-tools/main.go" "$stage/backend/.pentagi-export-tools/main.go"
cp "$repo_root/scripts/render-golden/main.go" "$stage/backend/.pentagi-render-golden/main.go"
(
  cd "$stage/backend"
  go run -tags pentagi_import ./.pentagi-export-tools
) > "$stage/contracts/pentagi-tools.json"
(
  cd "$stage/backend"
  go run -tags pentagi_import ./.pentagi-render-golden \
    "$stage/upstream/pentagi/prompts/primary_agent.tmpl" \
    "$repo_root/internal/prompts/testdata/render-cases.json" primary
) > "$stage/golden/primary_agent.golden"
(
  cd "$stage/backend"
  go run -tags pentagi_import ./.pentagi-render-golden \
    "$stage/upstream/pentagi/prompts/pentester.tmpl" \
    "$repo_root/internal/prompts/testdata/render-cases.json" pentester
) > "$stage/golden/pentester.golden"

python3 - "$stage/contracts/pentagi-tools.json" "$stage/contracts/pentagi-roles.json" <<'PY'
from __future__ import annotations
import json
from pathlib import Path
import sys

tools_path, roles_path = map(Path, sys.argv[1:])
snapshot = json.loads(tools_path.read_text())
if len(snapshot.get("tools", [])) != 42:
    raise SystemExit(f"expected 42 tool schemas, found {len(snapshot.get('tools', []))}")
names = [tool["name"] for tool in snapshot["tools"]]
if names != sorted(names) or len(names) != len(set(names)):
    raise SystemExit("tool snapshot names must be sorted and unique")

roles = {
    "adviser": [],
    "assistant_agent": ["advice", "coder", "file", "get_flow_status", "maintenance", "memorist", "pentester", "search", "terminal"],
    "assistant_direct": ["file", "get_flow_status", "terminal"],
    "coder": ["advice", "code_result", "file", "maintenance", "memorist", "search", "terminal"],
    "enricher": ["enricher_result", "file", "terminal"],
    "generator": ["file", "memorist", "search", "subtask_list", "terminal"],
    "maintenance": ["advice", "file", "maintenance_result", "memorist", "search", "terminal"],
    "memorist": ["file", "memorist_result", "terminal"],
    "pentester": ["advice", "coder", "file", "hack_result", "maintenance", "memorist", "search", "terminal"],
    "primary": ["advice", "coder", "done", "maintenance", "memorist", "pentester", "search"],
    "refiner": ["file", "memorist", "search", "subtask_patch", "terminal"],
    "reflector": [],
    "reporter": ["report_result"],
    "searcher": ["memorist", "search_result"],
}
optional = {
    "assistant_agent": ["browser", "patch_flow_subtasks", "stop_flow", "submit_flow_input", "wait_flow_completion", "web_search"],
    "assistant_direct": ["browser", "graphiti_search", "patch_flow_subtasks", "search_answer", "search_code", "search_guide", "search_in_memory", "stop_flow", "submit_flow_input", "wait_flow_completion", "web_search"],
    "coder": ["browser", "graphiti_search", "search_code", "store_code"],
    "enricher": ["browser", "graphiti_search", "search_in_memory"],
    "generator": ["browser"],
    "maintenance": ["browser", "search_guide", "store_guide"],
    "memorist": ["graphiti_search", "search_in_memory"],
    "pentester": ["browser", "graphiti_search", "search_guide", "store_guide", "web_search"],
    "primary": ["ask"],
    "refiner": ["browser"],
    "searcher": ["browser", "search_answer", "store_answer", "web_search"],
}
known = set(names)
for role, offered in {**roles, **optional}.items():
    unknown = sorted(set(offered) - known)
    if unknown:
        raise SystemExit(f"role {role} references unknown tools: {unknown}")
payload = {"roles": roles, "optional": optional}
roles_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PY

mkdir -p "$repo_root/upstream/pentagi" "$repo_root/contracts" "$repo_root/internal/contracts/assets" "$repo_root/internal/prompts/assets" "$repo_root/internal/prompts/testdata"
rm -rf "$repo_root/upstream/pentagi/prompts"
cp -a "$stage/upstream/pentagi/prompts" "$repo_root/upstream/pentagi/prompts"
cp "$stage/upstream/pentagi/manifest.json" "$repo_root/upstream/pentagi/manifest.json"
cp "$stage/contracts/pentagi-tools.json" "$repo_root/contracts/pentagi-tools.json"
cp "$stage/contracts/pentagi-roles.json" "$repo_root/contracts/pentagi-roles.json"
cp "$stage/contracts/pentagi-tools.json" "$repo_root/internal/contracts/assets/pentagi-tools.json"
cp "$stage/contracts/pentagi-roles.json" "$repo_root/internal/contracts/assets/pentagi-roles.json"
rm -rf "$repo_root/internal/prompts/assets"
cp -a "$stage/upstream/pentagi/prompts" "$repo_root/internal/prompts/assets"
cp "$stage/golden/primary_agent.golden" "$repo_root/internal/prompts/testdata/primary_agent.golden"
cp "$stage/golden/pentester.golden" "$repo_root/internal/prompts/testdata/pentester.golden"
