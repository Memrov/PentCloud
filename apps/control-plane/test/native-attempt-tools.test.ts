import { describe, expect, it } from "vitest";
import {
  supportedOptionalTools,
  resultInspector,
  isRemoteInspection,
  validateRemoteReconciliation,
  allowedRemoteTool,
  assertRoleWrite,
  catalogForRole,
  confinedRelative,
  redact,
  validateToolInput
} from "../src/native/tool-policy";

describe("native attempt authority", () => {
  it("retains role tool separation and validates result payloads", () => {
    expect(catalogForRole("reporter").map((t) => t.name)).toEqual([
      "report_result"
    ]);
    expect(catalogForRole("adviser")).toEqual([]);
    expect(catalogForRole("primary").map((t) => t.name)).toContain("yield");
    expect(() => catalogForRole("reporter", ["browser"])).toThrow(
      "not optional"
    );
    expect(() =>
      validateToolInput("done", { success: "yes", result: "x", message: "x" })
    ).toThrow();
    expect(() =>
      validateToolInput("done", {
        success: true,
        result: "x",
        message: "x",
        extra: 1
      })
    ).toThrow();
  });
  it("retires duplicate executable contracts without enabling remote aliases", () => {
    for (const role of [
      "primary",
      "adviser",
      "reporter",
      "coder",
      "maintenance",
      "memorist",
      "pentester",
      "searcher"
    ] as const) {
      const names = catalogForRole(role, supportedOptionalTools(role)).map(
        (tool) => tool.name
      );
      for (const name of ["file", "terminal", "workspace_javascript"]) {
        expect(names).not.toContain(name);
        expect(allowedRemoteTool(role, name)).toBe(false);
        expect(() => validateToolInput(name, {})).toThrow("retired");
      }
    }
  });
  it("blocks git metadata, traversal, inherited state and source writes by read-only roles", () => {
    for (const path of [
      "../x",
      "/etc/passwd",
      ".git/config",
      "src/../.git/HEAD",
      ".pentagi/jobs/other/result.json"
    ]) {
      expect(() => assertRoleWrite("coder", "own", path)).toThrow();
    }
    expect(() => assertRoleWrite("primary", "own", "src/app.ts")).toThrow();
    expect(() =>
      assertRoleWrite("reporter", "own", ".pentagi/memory/x")
    ).toThrow();
    expect(() => assertRoleWrite("coder", "own", "src/app.ts")).not.toThrow();
    expect(() =>
      assertRoleWrite("memorist", "own", ".pentagi/memory/code/x.md")
    ).not.toThrow();
    expect(confinedRelative("/workspace/repo/src/app.ts")).toBe("src/app.ts");
  });
  it("does not grant raw scanner MCP tools to roles without scanner authority", () => {
    expect(allowedRemoteTool("primary", "nmap_scan")).toBe(false);
    expect(allowedRemoteTool("adviser", "nmap_scan")).toBe(false);
    expect(allowedRemoteTool("reporter", "nmap_scan")).toBe(false);
    expect(allowedRemoteTool("pentester", "nmap_scan")).toBe(true);
    expect(allowedRemoteTool("memorist", "nmap_scan")).toBe(false);
    expect(allowedRemoteTool("searcher", "nmap_scan")).toBe(false);
  });
  it("redacts secret values recursively", () => {
    expect(
      redact(
        {
          headers: { authorization: "Bearer x" },
          output: "token secret-value",
          nested: ["secret-value"]
        },
        ["secret-value"]
      )
    ).toEqual({
      headers: { authorization: "[redacted]" },
      output: "token [redacted]",
      nested: ["[redacted]"]
    });
  });
  it("pins only implemented optional capabilities for each original role", () => {
    expect(supportedOptionalTools("memorist")).toEqual(["search_in_memory"]);
    for (const role of [
      "primary",
      "adviser",
      "reporter",
      "coder",
      "maintenance",
      "memorist",
      "pentester",
      "searcher"
    ] as const) {
      const names = supportedOptionalTools(role);
      expect(() => catalogForRole(role, names)).not.toThrow();
      expect(names).not.toContain("graphiti_search");
      expect(names).not.toContain("ask");
    }
    expect(supportedOptionalTools("searcher")).toContain("web_search");
    expect(supportedOptionalTools("coder")).toContain("store_code");
  });
  it("clears uncertainty only with matching stock terminal evidence", () => {
    const args = { target: "127.0.0.1" };
    const reply = (data: object) => ({
      content: [{ type: "text", text: JSON.stringify(data) }]
    });
    const terminal = {
      scan_id: "scan-1",
      target: "127.0.0.1",
      scan_type: "port",
      status: "completed"
    };
    expect(isRemoteInspection("nmap_list_active_scans")).toBe(true);
    expect(isRemoteInspection("nmap_port_scan")).toBe(false);
    expect(
      validateRemoteReconciliation(
        "nmap_port_scan",
        args,
        "nmap_get_scan_results",
        "scan-1",
        reply(terminal)
      )
    ).toEqual(terminal);
    for (const invalid of [
      { ...terminal, status: "running" },
      { ...terminal, scan_id: "scan-2" },
      { ...terminal, target: "other" },
      { ...terminal, scan_type: "service" }
    ]) {
      expect(() =>
        validateRemoteReconciliation(
          "nmap_port_scan",
          args,
          "nmap_get_scan_results",
          "scan-1",
          reply(invalid)
        )
      ).toThrow();
    }
    expect(() =>
      validateRemoteReconciliation(
        "nmap_port_scan",
        args,
        "masscan_get_scan_results",
        "scan-1",
        reply(terminal)
      )
    ).toThrow();
    expect(() =>
      validateRemoteReconciliation(
        "nmap_port_scan",
        args,
        "nmap_list_active_scans",
        "scan-1",
        reply({ active_scans: [] })
      )
    ).toThrow();
  });

  it("uses actual FFUF and Wayback inspector names, ID keys and stock canonical identities", () => {
    expect(resultInspector("ffuf_ffuf_dir")?.tool).toBe(
      "ffuf_get_fuzz_results"
    );
    expect(resultInspector("waybackurls_fetch_wayback_urls")?.idKey).toBe(
      "fetch_id"
    );
    expect(isRemoteInspection("ffuf_get_scan_results")).toBe(false);
    expect(isRemoteInspection("waybackurls_list_active_fetches")).toBe(true);
    const reply = (data: object) => ({
      content: [{ type: "text", text: JSON.stringify(data) }]
    });
    expect(
      validateRemoteReconciliation(
        "ffuf_ffuf_dir",
        { url: "https://example.com/" },
        "ffuf_get_fuzz_results",
        "fuzz-1",
        reply({
          scan_id: "fuzz-1",
          target: "https://example.com/FUZZ",
          status: "completed"
        })
      ).status
    ).toBe("completed");
    expect(
      validateRemoteReconciliation(
        "waybackurls_fetch_wayback_urls",
        { domain: " HTTPS://EXAMPLE.COM/path " },
        "waybackurls_get_fetch_results",
        "fetch-1",
        reply({
          fetch_id: "fetch-1",
          domain: "example.com",
          status: "completed"
        })
      ).status
    ).toBe("completed");
    expect(() =>
      validateRemoteReconciliation(
        "waybackurls_fetch_wayback_urls",
        { domain: "example.com" },
        "waybackurls_get_fetch_results",
        "fetch-1",
        reply({
          scan_id: "fetch-1",
          domain: "example.com",
          status: "completed"
        })
      )
    ).toThrow();
  });
});
