#!/usr/bin/env python3
"""Review drift in the OpenCode contracts used by the managed native adapters.

Pass downloaded upstream JSON snapshots (or HTTPS URLs), for example:
  python3 scripts/check-native-upstream-contracts.py --config new-config.json --api new-openapi.json

The baseline is generated offline from the installed pinned schema/protocol via
their public exports; the application never boots. Requires the repository's
Node version and root npm ci. Only the adopted fields/operations below are
compared, including referenced schemas and error responses. Exit 0: unchanged;
1: review drift; 2: invalid input/install. This is an explicit upgrade check,
not a runtime dependency, compatibility proof, or whole-inventory refresh.
"""

import argparse
import json
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FIELDS = ("agents", "skills", "permissions", "default_agent", "providers")
OPERATIONS = (
    ("/api/session/{sessionID}/form", "get"),
    ("/api/session/{sessionID}/form", "post"),
    ("/api/session/{sessionID}/form/{formID}", "get"),
    ("/api/session/{sessionID}/form/{formID}", "delete"),
    ("/api/session/{sessionID}/form/{formID}/reply", "post"),
    ("/api/session/{sessionID}/permission", "get"),
    ("/api/session/{sessionID}/permission/{requestID}/reply", "post"),
    ("/api/experimental/session/stats", "get"),
    ("/api/experimental/usage/limits", "get"),
    ("/api/websearch", "post"),
    ("/api/websearch/provider", "get"),
    ("/api/skill", "get"),
    ("/api/experimental/session/{sessionID}/skill", "post"),
)
DOC_KEYS = {"description", "title", "summary", "examples", "example", "$comment", "externalDocs", "tags"}
# These objects contain user-defined names, which can themselves be doc keywords.
NAME_MAPS = {"properties", "patternProperties", "$defs", "definitions", "schemas", "content", "headers"}


def load(source):
    if str(source).startswith("https://"):
        with urlopen(source, timeout=30) as response:
            document = json.load(response)
    else:
        document = json.loads(Path(source).read_text())
    if not isinstance(document, dict):
        raise ValueError("schema document must be an object")
    return document


def pinned_contracts():
    # Schema/HttpApi declarations only: no embedded host, fetch or model calls.
    source = '''
      import { readFileSync } from "node:fs";
      import { Schema } from "effect";
      import { OpenApi } from "effect/http-api";
      import { Config } from "@opencode/schema/config";
      import { Api } from "@opencode/server/api";
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@opencode/schema/config")), "utf8")).version;
      const config = Schema.toJsonSchemaDocument(Schema.toEncoded(Config.Info), { onExcessProperty: "error" });
      console.log(JSON.stringify({ version, config: { ...config.schema, $defs: config.definitions }, api: OpenApi.fromApi(Api) }));
    '''
    result = subprocess.run(["node", "--input-type=module", "-e", source], cwd=ROOT,
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError(f"cannot generate pinned declarations; run root npm ci with the required Node version\n{result.stderr}")
    return json.loads(result.stdout)


def contract(value, document, seen=(), names=False):
    """Follow local refs and remove prose without erasing property names."""
    if isinstance(value, list):
        return [contract(item, document, seen) for item in value]
    if not isinstance(value, dict):
        return value
    ref = value.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/") and ref not in seen:
        target = document
        for part in ref[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        # JSON Schema permits meaningful siblings alongside a reference.
        return contract({**target, **{key: item for key, item in value.items() if key != "$ref"}},
                        document, (*seen, ref))
    return {key: contract(item, document, seen, key in NAME_MAPS)
            for key, item in value.items() if names or key not in DOC_KEYS}


def operation(document, path, method):
    item = document.get("paths", {}).get(path, {})
    value = item.get(method)
    if value is None:
        return None
    return {
        "operationId": value.get("operationId"),
        "parameters": value.get("parameters", []),
        "pathParameters": item.get("parameters", []),
        "requestBody": value.get("requestBody"),
        "responses": value.get("responses", {}),
        "security": value.get("security", document.get("security", [])),
    }


def compare(label, baseline, candidate, old_document, new_document):
    if candidate is None:
        print(f"{label}: missing")
        return 1
    if contract(baseline, old_document) != contract(candidate, new_document):
        print(f"{label}: changed")
        return 1
    return 0


def compare_config(old, new):
    def field(document, name):
        schema = document.get("properties", {}).get(name)
        return None if schema is None else {"schema": schema, "required": name in document.get("required", [])}
    return int(any([compare(f"config.{name}", field(old, name), field(new, name), old, new)
                    for name in CONFIG_FIELDS]))


def compare_api(old, new):
    changes = 0
    for path, method in OPERATIONS:
        previous = operation(old, path, method)
        changes += compare(f"api.{previous['operationId']}", previous, operation(new, path, method), old, new)
    return int(bool(changes))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", help="candidate upstream config JSON schema file or HTTPS URL")
    parser.add_argument("--api", help="candidate upstream OpenAPI JSON file or HTTPS URL")
    args = parser.parse_args()
    if not (args.config or args.api):
        parser.error("provide --config and/or --api; snapshots are never fetched implicitly")
    pinned = pinned_contracts()
    pin = load(ROOT / "apps/control-plane/package.json")["dependencies"]["@opencode/sdk"]
    if pin != pinned["version"]:
        raise ValueError(f"installed schemas are OpenCode {pinned['version']}, configured SDK is {pin}; run root npm ci")
    changes = 0
    if args.config:
        changes += compare_config(pinned["config"], load(args.config))
    if args.api:
        changes += compare_api(pinned["api"], load(args.api))
    if not changes:
        print(f"No adopted contract drift from OpenCode {pin}")
    return int(bool(changes))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"Contract check failed: {error}", file=sys.stderr)
        sys.exit(2)
