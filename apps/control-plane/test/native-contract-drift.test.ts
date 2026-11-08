import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = resolve(root, "scripts/check-native-upstream-contracts.py");
const evidence = resolve(root, "apps/control-plane/test/fixtures/opencode");
const temporary: string[] = [];

function candidate(name: string, change: (document: any) => void) {
  const directory = mkdtempSync(resolve(tmpdir(), "pentcloud-contract-"));
  temporary.push(directory);
  const document = JSON.parse(readFileSync(resolve(evidence, name), "utf8"));
  // Representative config fixture excludes the published V1 compatibility branch.
  if (name === "config-schema.json") {
    document.properties.skills = { type: "array", items: { type: "string" } };
  }
  change(document);
  const path = resolve(directory, name);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

// Only the integration setup below generates installed Node/Effect declarations.
// Mutation tests exercise the pure comparison functions with published fixtures.
function compare(kind: "config" | "api", baseline: string, path: string) {
  return spawnSync(
    "python3",
    [
      "-c",
      `
import runpy, sys
checker = runpy.run_path(sys.argv[1])
old, new = checker["load"](sys.argv[3]), checker["load"](sys.argv[4])
sys.exit(checker["compare_" + sys.argv[2]](old, new))
`,
      script,
      kind,
      baseline,
      path
    ],
    { encoding: "utf8" }
  );
}

afterEach(() =>
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true }))
);

describe("adopted upstream contract drift", () => {
  let installed: ReturnType<typeof spawnSync>;
  beforeAll(() => {
    installed = spawnSync(
      "python3",
      [
        script,
        "--api",
        resolve(evidence, "openapi.json"),
        "--config",
        resolve(evidence, "config-schema.json")
      ],
      { encoding: "utf8" }
    );
  });

  it("compares installed pinned declarations once and identifies only the published legacy skills drift", () => {
    expect(installed.status, String(installed.stderr)).toBe(1);
    // All selected APIs match. Published Config has the additional deprecated
    // skills:{paths,urls} branch; installed Config.Info accepts string[] only.
    expect(String(installed.stdout).trim()).toBe("config.skills: changed");
  });

  it("retains schema properties named like documentation keywords", () => {
    const baseline = candidate("config-schema.json", (document) => {
      document.properties.agents = {
        type: "object",
        properties: { title: { type: "string" } }
      };
    });
    const path = candidate("config-schema.json", (document) => {
      document.properties.agents = {
        type: "object",
        properties: { title: { type: "number" } }
      };
    });
    const result = compare("config", baseline, path);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout.trim()).toBe("config.agents: changed");
  });

  it("ignores documentation and unrelated configuration additions", () => {
    const path = candidate("config-schema.json", (document) => {
      document.properties.unused_future_feature = { type: "string" };
      document.properties.default_agent.description = "Reworded documentation";
      document.properties.providers.title = "Providers";
    });
    const result = compare(
      "config",
      candidate("config-schema.json", () => {}),
      path
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("detects missing fields and changed nested referenced config types", () => {
    const path = candidate("config-schema.json", (document) => {
      delete document.properties.skills;
      document.properties.default_agent = { type: "number" };
      // A constraint reached through an adopted field's $ref must count too.
      document.$defs["Permission.Effect"].enum.push("new-effect");
    });
    const result = compare(
      "config",
      candidate("config-schema.json", () => {}),
      path
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("config.skills: missing");
    expect(result.stdout).toContain("config.default_agent: changed");
    expect(result.stdout).toContain("config.permissions: changed");
  });

  it("detects removed operations and changed native error or reply schemas", () => {
    const path = candidate("openapi.json", (document) => {
      delete document.paths["/api/experimental/session/stats"].get;
      const reply =
        document.paths["/api/session/{sessionID}/form/{formID}/reply"].post;
      delete reply.responses["409"];
      const permission =
        document.paths["/api/session/{sessionID}/permission/{requestID}/reply"]
          .post;
      permission.requestBody.content["application/json"].schema.required.push(
        "newRequired"
      );
    });
    const result = compare("api", resolve(evidence, "openapi.json"), path);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("api.experimental.session.stats: missing");
    expect(result.stdout).toContain("api.session.form.reply: changed");
    expect(result.stdout).toContain("api.session.permission.reply: changed");
  });

  it("covers adopted search, skills and form lifecycle contracts", () => {
    const path = candidate("openapi.json", (document) => {
      delete document.paths["/api/websearch"].post;
      delete document.paths["/api/websearch/provider"].get;
      delete document.paths["/api/skill"].get;
      delete document.paths["/api/experimental/session/{sessionID}/skill"].post;
      delete document.paths["/api/session/{sessionID}/form"].post;
      delete document.paths["/api/session/{sessionID}/form/{formID}"].get;
      delete document.paths["/api/session/{sessionID}/form/{formID}"].delete;
    });
    const result = compare("api", resolve(evidence, "openapi.json"), path);
    expect(result.status, result.stderr).toBe(1);
    for (const id of [
      "websearch.query",
      "websearch.providers",
      "skill.list",
      "experimental.session.skill",
      "session.form.create",
      "session.form.get",
      "session.form.cancel"
    ]) {
      expect(result.stdout).toContain(`api.${id}: missing`);
    }
  });

  it("rejects malformed local references before comparing contracts", () => {
    const path = candidate("config-schema.json", (document) => {
      document.properties.skills = { $ref: "#/$defs/DoesNotExist" };
    });
    const result = compare(
      "config",
      candidate("config-schema.json", () => {}),
      path
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("KeyError: 'DoesNotExist'");
  });
});
