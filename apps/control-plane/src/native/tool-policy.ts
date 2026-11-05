import { Validator } from "@cfworker/json-schema";
import original from "../../../../contracts/pentagi-tools.json";
import roles from "../../../../contracts/pentagi-roles.json";
import extensions from "../../../../contracts/cloudflare-tools.json";
import type { Role } from "./types";

export const REPO_DIR = "/workspace/repo";
export interface ToolContract {
  name: string;
  description: string;
  category?: string;
  input_schema: Record<string, unknown>;
}
export const contracts = new Map<string, ToolContract>(
  ([...original.tools, ...extensions.tools] as ToolContract[]).map((t) => [
    t.name,
    t,
  ]),
);
export const delegationTools = new Set([
  "advice",
  "coder",
  "maintenance",
  "memorist",
  "pentester",
  "search",
  "revise_attempt",
]);
export const resultTools = new Set([
  "done",
  "yield",
  "ask",
  "maintenance_result",
  "code_result",
  "hack_result",
  "memorist_result",
  "search_result",
  "report_result",
]);
const sourceWriters = new Set<Role>(["coder", "maintenance", "pentester"]);

/** The SDK reserves `browser` permission for an attached desktop browser.
 * Keep the original tool name/schema while authorizing our scoped HTTP reader separately.
 */
export function nativeToolPermission(name: string): string {
  return name === "browser" ? "pentagi.browser" : name;
}

/** Implemented optional capabilities, frozen by Coordinator into each attempt. */
export function supportedOptionalTools(role: Role): string[] {
  const supported: Record<Role, readonly string[]> = {
    primary: [],
    adviser: [],
    reporter: [],
    memorist: ["search_in_memory"],
    coder: ["search_code", "store_code"],
    maintenance: ["search_guide", "store_guide"],
    searcher: ["browser", "search_answer", "store_answer", "web_search"],
    pentester: ["browser", "search_guide", "store_guide", "web_search"],
  };
  return [...supported[role]];
}

export function catalogForRole(
  role: Role,
  enabled: string[] = [],
): ToolContract[] {
  const base: string[] = roles.roles[role];
  const optional: string[] =
    (roles.optional as Record<string, string[]>)[role] ?? [];
  for (const name of enabled)
    if (!optional.includes(name))
      throw new Error(`${name} is not optional for ${role}`);
  return [
    ...new Set([
      ...base,
      ...((extensions.roles as Record<string, string[]>)[role] ?? []),
      ...enabled,
    ]),
  ]
    .sort()
    .map((name) => {
      const contract = contracts.get(name);
      if (!contract) throw new Error(`Missing original schema for ${name}`);
      return contract;
    });
}
export function validateToolInput(
  name: string,
  input: unknown,
): Record<string, unknown> {
  const tool = contracts.get(name);
  if (!tool) throw new Error(`Unknown original tool ${name}`);
  const result = new Validator(tool.input_schema, "2020-12", false).validate(
    input,
  );
  if (!result.valid)
    throw new Error(
      `Invalid ${name} arguments: ${result.errors
        .map((e) => e.error)
        .join("; ")
        .slice(0, 1000)}`,
    );
  return input as Record<string, unknown>;
}
/** Stock scanner authority is narrower than the upstream terminal permission. */
export function allowedRemoteTool(role: Role, name: string): boolean {
  return (
    sourceWriters.has(role) &&
    /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(name) &&
    !contracts.has(name)
  );
}
export interface ResultInspector {
  tool: string;
  activeTool: string;
  idKey: "scan_id" | "fetch_id";
  argumentKeys: readonly string[];
  evidenceKeys: readonly string[];
}
const inspectors: Record<string, ResultInspector> = Object.fromEntries(
  ["nmap", "masscan", "whatweb", "nuclei", "sqlmap", "binwalk"].map(
    (family) => [
      family,
      {
        tool: `${family}_get_scan_results`,
        activeTool: `${family}_list_active_scans`,
        idKey: "scan_id" as const,
        argumentKeys: ["target"],
        evidenceKeys: ["target"],
      },
    ],
  ),
);
inspectors.ffuf = {
  tool: "ffuf_get_fuzz_results",
  activeTool: "ffuf_list_active_scans",
  idKey: "scan_id",
  argumentKeys: ["url"],
  evidenceKeys: ["url", "target"],
};
inspectors.waybackurls = {
  tool: "waybackurls_get_fetch_results",
  activeTool: "waybackurls_list_active_fetches",
  idKey: "fetch_id",
  argumentKeys: ["domain"],
  evidenceKeys: ["domain", "target"],
};
/** Exact names and ID keys from the live unchanged stock tool catalog. */
export function resultInspector(name: string): ResultInspector | undefined {
  return inspectors[name.split("_")[0] ?? ""];
}
export function isRemoteInspection(name: string): boolean {
  if (
    name === "metasploit_list_listeners" ||
    name === "metasploit_list_active_sessions"
  )
    return true;
  return Object.values(inspectors).some(
    (item) => item.tool === name || item.activeTool === name,
  );
}
export function remoteResultObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed stock MCP result");
  const result = value as Record<string, unknown>;
  if (result.isError === true)
    throw new Error("Stock inspector returned an error");
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  )
    return result.structuredContent as Record<string, unknown>;
  const text = Array.isArray(result.content)
    ? result.content
        .filter(
          (item) =>
            item &&
            typeof item === "object" &&
            item.type === "text" &&
            typeof item.text === "string",
        )
        .map((item) => item.text as string)
        .join("\n")
    : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "Stock inspector did not return structured operation evidence",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Malformed stock operation evidence");
  return parsed as Record<string, unknown>;
}
export function validateRemoteReconciliation(
  tool: string,
  args: Record<string, unknown>,
  inspectionTool: string,
  scanId: string,
  response: unknown,
): Record<string, unknown> {
  const family = tool.split("_")[0];
  const inspector = resultInspector(tool);
  if (!inspector || inspectionTool !== inspector.tool)
    throw new Error(
      "Reconciliation requires the matching stock result inspector",
    );
  const result = remoteResultObject(response);
  let originalIdentity = inspector.argumentKeys
    .map((key) => args[key])
    .find((value) => typeof value === "string");
  // Canonicalizations below follow the unchanged stock server.
  if (
    typeof originalIdentity === "string" &&
    family === "ffuf" &&
    tool === "ffuf_ffuf_dir" &&
    !originalIdentity.includes("FUZZ")
  )
    originalIdentity = originalIdentity.replace(/\/+$/, "") + "/FUZZ";
  if (typeof originalIdentity === "string" && family === "waybackurls") {
    originalIdentity = originalIdentity.trim().toLowerCase();
    if (/^https?:\/\//.test(originalIdentity)) {
      try {
        originalIdentity = new URL(originalIdentity).host;
      } catch {
        throw new Error("Invalid original fetch domain");
      }
    }
  }
  const observedIdentity = inspector.evidenceKeys
    .map((key) => result[key])
    .find((value) => typeof value === "string");
  if (
    result[inspector.idKey] !== scanId ||
    typeof originalIdentity !== "string" ||
    observedIdentity !== originalIdentity
  )
    throw new Error(
      "Inspection evidence does not match the original operation identity",
    );
  if (
    ![
      "completed",
      "failed",
      "cancelled",
      "canceled",
      "terminated",
      "timed_out",
      "timeout",
      "error",
    ].includes(String(result.status))
  )
    throw new Error(
      "Inspection evidence does not prove the remote operation has stopped",
    );
  if (family === "nmap") {
    const expectedType: Record<string, string> = {
      nmap_port_scan: "port",
      nmap_service_scan: "service",
      nmap_os_detection: "os",
      nmap_script_scan: "script",
      nmap_quick_scan: "quick",
    };
    if (expectedType[tool] && result.scan_type !== expectedType[tool])
      throw new Error("Inspection evidence has a different scan type");
  }
  return result;
}

export function confinedRelative(requested: string, root = REPO_DIR): string {
  if (
    typeof requested !== "string" ||
    requested.includes("\0") ||
    requested.includes("\\")
  )
    throw new Error("Unsafe workspace path");
  const relative = requested.startsWith(`${root}/`)
    ? requested.slice(root.length + 1)
    : requested === root
      ? "."
      : requested;
  if (relative.startsWith("/") || relative.split("/").includes(".."))
    throw new Error(`Path ${requested} escapes attempt workspace`);
  const parts = relative.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p.toLowerCase() === ".git"))
    throw new Error("Git metadata is private to the attempt publisher");
  return parts.join("/") || ".";
}
export function assertRoleWrite(
  role: Role,
  id: string,
  requested: string,
): string {
  const path = confinedRelative(requested);
  if(path===`.pentagi/evidence/${id}/manifest.json`||path===`.pentagi/evidence/${id}/captured`||path.startsWith(`.pentagi/evidence/${id}/captured/`))throw new Error("Captured evidence is immutable runtime data");
  if (
    path === "." ||
    path === ".pentagi" ||
    path.startsWith(".pentagi/jobs") ||
    path.startsWith(".pentagi/native")
  )
    throw new Error("Attempt state is owned by the runtime");
  if (path.startsWith(".pentagi/")) {
    if (
      path.startsWith(".pentagi/memory/") &&
      role !== "reporter" &&
      role !== "adviser"
    )
      return path;
    if (
      path === `.pentagi/evidence/${id}` ||
      path.startsWith(`.pentagi/evidence/${id}/`)
    )
      return path;
    throw new Error("Cannot overwrite inherited attempt evidence");
  }
  if (!sourceWriters.has(role))
    throw new Error(`${role} cannot change source files`);
  return path;
}
export function redact(
  value: unknown,
  secrets: readonly (string | undefined)[] = [],
): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets)
      if (secret) result = result.split(secret).join("[redacted]");
    return result
      .replace(
        /(\b[A-Za-z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
        "$1[redacted]",
      )
      .replace(
        /("(?:password|token|secret|api_key|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
        '$1"[redacted]"',
      )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.?~-]+/gi, "$1 [redacted]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(
        /([?&](?:token|api_key|apikey|access_token|secret|signature)=)[^&\s"']+/gi,
        "$1[redacted]",
      );
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /^(authorization|cookie|set-cookie|token|secret|credentials?|.*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password))$/i.test(
          key,
        )
          ? "[redacted]"
          : redact(v, secrets),
      ]),
    );
  return value;
}
export function applyUnifiedDiff(originalText: string, patch: string): string {
  const trailing = originalText.endsWith("\n");
  const source = originalText.replace(/\n$/, "").split("\n");
  const lines = patch.replace(/\n$/, "").split("\n");
  const output: string[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; ) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]!);
    if (!match) throw new Error("Expected unified diff hunk header");
    const start = Math.max(0, Number(match[1]) - 1);
    if (start < cursor || start > source.length)
      throw new Error("Invalid diff hunk start");
    output.push(...source.slice(cursor, start));
    cursor = start;
    i++;
    while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
      const line = lines[i++]!;
      if (line === "\\ No newline at end of file") continue;
      const text = line.slice(1);
      if (line[0] === " " || line[0] === "-") {
        if (source[cursor] !== text)
          throw new Error(`Diff context does not match at line ${cursor + 1}`);
        if (line[0] === " ") output.push(text);
        cursor++;
      } else if (line[0] === "+") output.push(text);
      else throw new Error("Invalid diff line prefix");
    }
  }
  return (
    [...output, ...source.slice(cursor)].join("\n") + (trailing ? "\n" : "")
  );
}
