export const toolPacks = [
  "recon",
  "http",
  "nuclei",
  "sqlmap",
  "service",
  "web-context",
  "pcap",
  "file-analysis",
  "password",
  "reference",
  "metasploit"
] as const;
export type ToolPack = (typeof toolPacks)[number];
export interface ToolPackScope {
  runId: string;
  attemptId: string;
  role: string;
  discovery?: boolean;
}
export interface ToolPackRequest {
  pack: ToolPack;
  request: Record<string, unknown>;
  files?: Record<string, string>;
}
export interface ToolPackService {
  ready(scope: ToolPackScope, pack: ToolPack): Promise<unknown>;
  run(
    scope: ToolPackScope,
    input: ToolPackRequest,
    files: Record<string, Uint8Array>
  ): Promise<unknown>;
  stop(scope: ToolPackScope, packs: ToolPack[]): Promise<{ stopped: boolean }>;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
export function assertPackAccess(
  scope: ToolPackScope,
  pack: unknown,
  request?: Record<string, unknown>
): asserts pack is ToolPack {
  if (
    !scope ||
    !identifier.test(scope.runId) ||
    !identifier.test(scope.attemptId)
  )
    throw Error("Invalid tool runtime ownership");
  if (!toolPacks.includes(pack as ToolPack)) throw Error("Unknown tool pack");
  if (scope.discovery) {
    if (
      scope.role !== "pentester" ||
      pack !== "web-context" ||
      (request &&
        (request.tool !== "whatweb" ||
          Object.keys(request).some((k) => !["tool", "target"].includes(k))))
    )
      throw Error("Discovery only permits the WhatWeb profile");
  } else if (!["pentester", "coder", "maintenance"].includes(scope.role))
    throw Error("Tool packs are unavailable to this role");
}
export function packFileNames(input: ToolPackRequest): string[] {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((k) => !["pack", "request", "files"].includes(k)) ||
    !input.request ||
    typeof input.request !== "object" ||
    Array.isArray(input.request)
  )
    throw Error("Invalid tool pack request");
  const expected =
    input.pack === "pcap" || input.pack === "file-analysis"
      ? ["input"]
      : input.pack === "password"
        ? input.request.view === "sha256-dictionary"
          ? ["input", "dictionary"]
          : ["input"]
        : [];
  const files = input.files ?? {};
  if (
    typeof files !== "object" ||
    Array.isArray(files) ||
    Object.keys(files).length !== expected.length ||
    expected.some((k) => typeof files[k] !== "string" || !files[k])
  )
    throw Error("Select the required input files for this profile");
  return expected;
}
