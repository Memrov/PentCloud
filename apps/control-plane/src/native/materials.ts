export const MATERIAL_FILE_LIMIT = 2 * 1024 * 1024;
export const MATERIAL_TOTAL_LIMIT = 8 * 1024 * 1024;
export const MATERIAL_MAX_FILES = 8;
export const DERIVED_LIMIT = 2 * 1024 * 1024;

export interface UploadReceipt {
  id: string;
  runId: string;
  name: string;
  sha256: string;
  size: number;
  mediaType: string;
  kind: "text" | "document";
  status: "ready";
  sourcePath: string;
  textPath: string;
}
export interface MaterialConversion {
  service: "workers-ai.toMarkdown";
  sourceSha256: string;
  outputSha256: string;
  options: { format: "markdown" };
  status: "completed";
}
export type MaterialFile = Omit<UploadReceipt, "runId" | "status"> & {
  textSha256: string;
  textSize: number;
  uploadedBy: string;
  createdAt: number;
  conversion?: MaterialConversion;
};
export interface MaterialSelection {
  version: 1;
  files: MaterialFile[];
  digest: string;
  manifestPath: string;
}
export interface RunFile {
  path: string;
  name: string;
  size: number;
  sha256?: string;
  mediaType: string;
  kind: "input" | "derived" | "output" | "report";
  sourceSha256?: string;
  commit: string;
  previewable: boolean;
}
export interface RunFiles {
  runId: string;
  commit: string;
  materialsDigest?: string;
  files: RunFile[];
}

/** Plain names are labels, never caller-controlled filesystem paths. */
export function materialName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 180 ||
    value === "." ||
    value === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("400: invalid material filename");
  return value;
}
export function materialId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,100}$/.test(value)
  )
    throw new Error("400: invalid material identity");
  return value;
}
export function materialDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("400: invalid material SHA-256");
  return value;
}
export async function materialHash(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    )
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function normalizeUploadIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MATERIAL_MAX_FILES)
    throw new Error("400: at most eight upload identities are allowed");
  return [...new Set(value.map(materialId))].sort();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function selectionManifest(
  selection: Pick<MaterialSelection, "version" | "files">
): string {
  return (
    canonical({ version: selection.version, files: selection.files }) + "\n"
  );
}
const documentTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet"
]);
function checkedFile(raw: MaterialFile): MaterialFile {
  if (!raw || typeof raw !== "object")
    throw new Error("400: invalid material descriptor");
  materialId(raw.id);
  materialName(raw.name);
  materialDigest(raw.sha256);
  materialDigest(raw.textSha256);
  if (
    !Number.isSafeInteger(raw.size) ||
    raw.size < 1 ||
    raw.size > MATERIAL_FILE_LIMIT ||
    !Number.isSafeInteger(raw.textSize) ||
    raw.textSize < 1 ||
    raw.textSize > DERIVED_LIMIT ||
    !Number.isSafeInteger(raw.createdAt) ||
    raw.createdAt < 0 ||
    typeof raw.uploadedBy !== "string" ||
    !raw.uploadedBy.trim() ||
    raw.uploadedBy.length > 500
  )
    throw new Error("400: invalid material bounds or provenance");
  const sourcePath = `.pentagi/materials/${raw.sha256}/source`;
  if (raw.sourcePath !== sourcePath)
    throw new Error("400: invalid material source path");
  if (raw.kind === "text") {
    if (
      raw.mediaType !== "text/plain" ||
      raw.textPath !== sourcePath ||
      raw.textSha256 !== raw.sha256 ||
      raw.textSize !== raw.size ||
      raw.conversion
    )
      throw new Error("400: invalid text material descriptor");
  } else if (raw.kind === "document") {
    if (
      !documentTypes.has(raw.mediaType) ||
      raw.textPath !==
        `.pentagi/materials/${raw.sha256}/derived/${raw.textSha256}.md` ||
      raw.conversion?.service !== "workers-ai.toMarkdown" ||
      raw.conversion.sourceSha256 !== raw.sha256 ||
      raw.conversion.outputSha256 !== raw.textSha256 ||
      raw.conversion.status !== "completed" ||
      raw.conversion.options?.format !== "markdown"
    )
      throw new Error("400: invalid document conversion descriptor");
  } else throw new Error("400: invalid material kind");
  return structuredClone(raw);
}
export async function materialSelection(
  previous: MaterialSelection | undefined,
  files: MaterialFile[]
): Promise<MaterialSelection> {
  if (!Array.isArray(files) || files.length > MATERIAL_MAX_FILES)
    throw new Error("400: invalid material selection");
  if (previous) {
    if (
      previous.version !== 1 ||
      !Array.isArray(previous.files) ||
      previous.files.length > MATERIAL_MAX_FILES ||
      previous.manifestPath !==
        `.pentagi/materials/selections/${materialDigest(previous.digest)}.json` ||
      (await materialHash(
        new TextEncoder().encode(selectionManifest(previous))
      )) !== previous.digest
    )
      throw new Error("400: previous material selection changed");
  }
  const merged = new Map<string, MaterialFile>();
  for (const value of previous?.files ?? []) {
    const file = checkedFile(value);
    if (merged.has(file.name))
      throw new Error("400: duplicate material filename");
    merged.set(file.name, file);
  }
  const incoming = new Set<string>();
  for (const value of files) {
    const file = checkedFile(value);
    if (incoming.has(file.name))
      throw new Error("400: duplicate material filename");
    incoming.add(file.name);
    merged.set(file.name, file);
  }
  const selected = [...merged.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  if (
    selected.length > MATERIAL_MAX_FILES ||
    selected.reduce((sum, f) => sum + f.size, 0) > MATERIAL_TOTAL_LIMIT
  )
    throw new Error(
      "400: material selection exceeds file count or total byte limit"
    );
  const value = { version: 1 as const, files: selected };
  const digest = await materialHash(
    new TextEncoder().encode(selectionManifest(value))
  );
  return {
    ...value,
    digest,
    manifestPath: `.pentagi/materials/selections/${digest}.json`
  };
}
