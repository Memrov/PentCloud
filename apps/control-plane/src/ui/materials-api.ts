import { APIError } from "./api";

export const MATERIAL_LIMITS = {
  files: 8,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  previewBytes: 64 * 1024
} as const;
export const MATERIAL_ACCEPT =
  ".pdf,.docx,.xlsx,.odt,.ods,text/*,.md,.json,.jsonc,.yaml,.yml,.toml,.xml,.csv,.log,.ts,.tsx,.js,.jsx,.py,.go,.rs,.c,.h,.cpp,.sh,.sql,.ini,.conf,.cfg,.env";
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
export interface PendingMaterial {
  id: string;
  file: File;
  sha256?: string;
  status: "hashing" | "uploading" | "ready" | "failed";
  receipt?: UploadReceipt;
  error?: string | undefined;
}
export interface MaterialDraftSnapshot {
  files: PendingMaterial[];
  error?: string;
}
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const safeName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 255 &&
  !/[\x00-\x1f\x7f/\\]/.test(value) &&
  value !== "." &&
  value !== "..";
const safePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2048 &&
  !/[\x00-\x1f\x7f\\]/.test(value) &&
  !value.startsWith("/") &&
  value
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        part.toLowerCase() !== ".git"
    );
const size = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const media = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\r\n\x00]/.test(value);
async function jsonResponse(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new APIError(
      response.status,
      record(value) && typeof value.error === "string"
        ? value.error
        : `Request failed with HTTP ${response.status}`
    );
  return value;
}
/** These responses reject admission; network failures and server errors may have admitted it. */
export function canCorrectMaterialSubmission(error: unknown): boolean {
  return (
    error instanceof APIError &&
    [400, 409, 413, 415, 422].includes(error.status)
  );
}
function validateSelection(
  files: readonly File[],
  current: readonly PendingMaterial[]
) {
  if (files.length + current.length > MATERIAL_LIMITS.files)
    throw new Error("Select at most 8 files.");
  if (
    files.reduce(
      (total, file) => total + file.size,
      current.reduce((total, item) => total + item.file.size, 0)
    ) > MATERIAL_LIMITS.totalBytes
  )
    throw new Error("Selected files must total at most 8 MiB.");
  const names = new Set(current.map((item) => item.file.name));
  for (const file of files) {
    if (!safeName(file.name))
      throw new Error("Use a filename without folders or control characters.");
    if (names.has(file.name))
      throw new Error(
        `${file.name}: duplicate filename. Remove or rename the file before attaching it.`
      );
    names.add(file.name);
    if (file.size > MATERIAL_LIMITS.fileBytes)
      throw new Error(`${file.name}: maximum file size is 2 MiB.`);
    if (
      /^(image|audio|video)\//i.test(file.type) ||
      /\.(zip|tar|gz|tgz|7z|rar|exe|dll|so|dylib|wasm|pcap|pcapng|png|jpe?g|gif|webp|bmp|ico|avif|mp[34]|mov|wav)$/i.test(
        file.name
      )
    )
      throw new Error(
        `${file.name}: select UTF-8 text, PDF, DOCX, XLSX, ODT or ODS files.`
      );
  }
}
function parseUploadReceipt(
  value: unknown,
  runId: string,
  item: PendingMaterial
): UploadReceipt {
  if (
    !record(value) ||
    value.id !== item.id ||
    value.runId !== runId ||
    value.name !== item.file.name ||
    value.sha256 !== item.sha256 ||
    value.size !== item.file.size ||
    !SHA.test(String(value.sha256)) ||
    !media(value.mediaType) ||
    !["text", "document"].includes(String(value.kind)) ||
    value.status !== "ready" ||
    !safePath(value.sourcePath) ||
    !safePath(value.textPath)
  )
    throw new Error("Invalid upload receipt; retry the same file.");
  return {
    id: item.id,
    runId,
    name: item.file.name,
    sha256: item.sha256!,
    size: item.file.size,
    mediaType: value.mediaType,
    kind: value.kind as UploadReceipt["kind"],
    status: "ready",
    sourcePath: value.sourcePath,
    textPath: value.textPath
  };
}

/** Component-local pending selections only. Bytes/receipts remain authoritative on the server. */
export class AttachmentDraft {
  private value: MaterialDraftSnapshot = { files: [] };
  private listeners = new Set<() => void>();
  constructor(
    readonly runId: string,
    private readonly fetcher: typeof fetch = (...args) =>
      globalThis.fetch(...args)
  ) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: MaterialDraftSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  private update(id: string, patch: Partial<PendingMaterial>) {
    if (!this.value.files.some((file) => file.id === id)) return;
    this.publish({
      ...this.value,
      files: this.value.files.map((file) =>
        file.id === id ? { ...file, ...patch } : file
      )
    });
  }
  async add(files: readonly File[]): Promise<void> {
    try {
      validateSelection(files, this.value.files);
    } catch (error) {
      this.publish({
        ...this.value,
        error: error instanceof Error ? error.message : "File selection failed"
      });
      return;
    }
    const added: PendingMaterial[] = files.map((file) => ({
      id: `upload-${crypto.randomUUID()}`,
      file,
      status: "hashing"
    }));
    this.publish({ files: [...this.value.files, ...added] });
    // Bound peak hashing/conversion pressure and preserve each ID through any retry.
    for (const item of added) await this.upload(item);
  }
  async retry(id: string): Promise<void> {
    const item = this.value.files.find((file) => file.id === id);
    if (item?.status === "failed") await this.upload(item);
  }
  remove(id: string) {
    this.publish({ files: this.value.files.filter((file) => file.id !== id) });
  }
  clear() {
    this.publish({ files: [] });
  }
  private async upload(item: PendingMaterial): Promise<void> {
    try {
      const sha256 =
        item.sha256 ??
        [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", await item.file.arrayBuffer())
          )
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      if (!this.value.files.some((file) => file.id === item.id)) return;
      const pending = { ...item, sha256 };
      this.update(item.id, { sha256, status: "uploading", error: undefined });
      const response = await this.fetcher(
        `/v1/ui/runs/${encodeURIComponent(this.runId)}/uploads/${encodeURIComponent(item.id)}?name=${encodeURIComponent(item.file.name)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": item.file.type || "application/octet-stream",
            "X-Content-SHA256": sha256
          },
          body: item.file,
          cache: "no-store"
        }
      );
      const receipt = parseUploadReceipt(
        await jsonResponse(response),
        this.runId,
        pending
      );
      this.update(item.id, { status: "ready", receipt, error: undefined });
    } catch (error) {
      this.update(item.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Upload failed"
      });
    }
  }
}
export function parseRunFiles(value: unknown, runId: string): RunFiles {
  if (
    !record(value) ||
    value.runId !== runId ||
    !COMMIT.test(String(value.commit)) ||
    !Array.isArray(value.files) ||
    value.files.length > 2000 ||
    (value.materialsDigest !== undefined &&
      !SHA.test(String(value.materialsDigest)))
  )
    throw new Error("Invalid run files response");
  const commit = value.commit as string;
  const files = value.files.map((file): RunFile => {
    if (
      !record(file) ||
      !safePath(file.path) ||
      !safeName(file.name) ||
      !size(file.size) ||
      !media(file.mediaType) ||
      !["input", "derived", "output", "report"].includes(String(file.kind)) ||
      file.commit !== commit ||
      typeof file.previewable !== "boolean" ||
      (file.sha256 !== undefined && !SHA.test(String(file.sha256))) ||
      (file.sourceSha256 !== undefined && !SHA.test(String(file.sourceSha256)))
    )
      throw new Error("Invalid run file descriptor");
    return {
      path: file.path,
      name: file.name,
      size: file.size,
      mediaType: file.mediaType,
      kind: file.kind as RunFile["kind"],
      commit,
      previewable: file.previewable,
      ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
      ...(typeof file.sourceSha256 === "string"
        ? { sourceSha256: file.sourceSha256 }
        : {})
    };
  });
  return {
    runId,
    commit,
    files,
    ...(typeof value.materialsDigest === "string"
      ? { materialsDigest: value.materialsDigest }
      : {})
  };
}
export async function listRunFiles(
  runId: string,
  jobId: string,
  fetcher: typeof fetch = globalThis.fetch
): Promise<RunFiles> {
  return parseRunFiles(
    await jsonResponse(
      await fetcher(
        `/v1/ui/runs/${encodeURIComponent(runId)}/files?job=${encodeURIComponent(jobId)}`,
        { cache: "no-store" }
      )
    ),
    runId
  );
}
export function materialFileURL(
  runId: string,
  file: Pick<RunFile, "commit" | "path">,
  preview = false
): string {
  if (!COMMIT.test(file.commit) || !safePath(file.path))
    throw new Error("Invalid immutable file identity");
  const query = new URLSearchParams({ commit: file.commit, path: file.path });
  if (preview) query.set("preview", "1");
  return `/v1/ui/runs/${encodeURIComponent(runId)}/file?${query}`;
}
export async function readMaterialPreview(
  runId: string,
  file: RunFile,
  fetcher: typeof fetch = globalThis.fetch
): Promise<{ text: string; truncated: boolean }> {
  const response = await fetcher(materialFileURL(runId, file, true), {
    cache: "no-store"
  });
  if (!response.ok) {
    await jsonResponse(response);
    throw new Error("Preview unavailable");
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/plain")
  )
    throw new Error("Invalid text preview response");
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  let total = 0,
    text = "",
    truncated = ["1", "true"].includes(
      response.headers.get("X-Content-Truncated") ?? ""
    );
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const keep = chunk.value.subarray(
        0,
        Math.max(0, MATERIAL_LIMITS.previewBytes - total)
      );
      text += decoder.decode(keep, { stream: true });
      total += keep.byteLength;
      if (keep.byteLength < chunk.value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}
