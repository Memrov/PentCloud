import type { Workspace } from "@cloudflare/computer";
import {
  DERIVED_LIMIT,
  MATERIAL_FILE_LIMIT,
  materialDigest,
  materialHash,
  materialId,
  materialName,
  materialSelection,
  normalizeUploadIds,
  type MaterialFile,
  type MaterialSelection,
  type UploadReceipt
} from "./materials";

export interface StagedMaterial {
  receipt: UploadReceipt;
  file: MaterialFile;
  sourceFile: string;
  textFile: string;
}
export interface MaterialStoreOptions {
  ownerKind?: "run" | "target-definition";
  fs: Pick<Workspace["fs"], "readFile" | "writeFile" | "mkdir">;
  get: <T>(key: string) => T | undefined;
  put: (key: string, value: unknown) => void;
  convert?: (input: { name: string; blob: Blob }) => Promise<{
    format: string;
    data?: string;
    error?: string;
    mimetype?: string;
  }>;
  now?: () => number;
}
export interface StageMaterialInput {
  runId: string;
  id: string;
  name: string;
  sha256: string;
  body: ReadableStream<Uint8Array>;
  uploadedBy: string;
}
export class MaterialStore {
  private readonly staging = new Map<string, Promise<UploadReceipt>>();
  constructor(private readonly options: MaterialStoreOptions) {}
  async stage(input: StageMaterialInput): Promise<UploadReceipt> {
    const runId = materialId(input.runId),
      id = materialId(input.id),
      name = materialName(input.name);
    const expected = materialDigest(input.sha256);
    if (
      typeof input.uploadedBy !== "string" ||
      !input.uploadedBy.trim() ||
      input.uploadedBy.length > 500
    )
      throw new Error("400: invalid material uploader");
    // A retry must actually consume and verify its new body, not merely trust its claimed hash.
    const source = await readBounded(input.body, MATERIAL_FILE_LIMIT);
    const actual = await materialHash(source);
    const key = this.key(runId, id);
    const preceding = this.staging.get(key);
    const pending = (async () => {
      await preceding?.catch(() => undefined);
      const prior = this.options.get<StagedMaterial>(key);
      if (prior) {
        if (
          actual !== expected ||
          prior.receipt.sha256 !== actual ||
          prior.receipt.name !== name ||
          prior.file.uploadedBy !== input.uploadedBy
        )
          throw new Error(
            "409: upload identity reused with changed metadata or bytes"
          );
        return structuredClone(prior.receipt);
      }
      if (actual !== expected)
        throw new Error("400: upload SHA-256 does not match actual bytes");
      if (!source.byteLength)
        throw new Error("400: empty uploads are unavailable");
      const format = classify(name, source);
      let text = source;
      if (format.kind === "document") {
        if (!this.options.convert)
          throw new Error("400: document conversion is unavailable");
        let converted: Awaited<
          ReturnType<NonNullable<MaterialStoreOptions["convert"]>>
        >;
        try {
          converted = await this.options.convert({
            name,
            blob: new Blob([new Uint8Array(source)], { type: format.mediaType })
          });
        } catch {
          throw new Error("400: document conversion failed");
        }
        if (
          !["markdown", "text"].includes(converted?.format) ||
          typeof converted.data !== "string" ||
          !converted.data.trim()
        )
          throw new Error(
            "400: document conversion did not return readable text"
          );
        text = new TextEncoder().encode(converted.data);
        if (text.byteLength > DERIVED_LIMIT)
          throw new Error("400: converted document exceeds text limit");
        validateText(text);
      }
      const textSha256 = await materialHash(text);
      const sourcePath = `.pentagi/materials/${actual}/source`;
      const textPath =
        format.kind === "text"
          ? sourcePath
          : `.pentagi/materials/${actual}/derived/${textSha256}.md`;
      const root =
        (this.options.ownerKind === "target-definition"
          ? "/target-definitions/"
          : "/uploads/") +
        runId +
        "/" +
        id;
      const receipt: UploadReceipt = {
        id,
        runId,
        name,
        sha256: actual,
        size: source.byteLength,
        ...format,
        status: "ready",
        sourcePath,
        textPath
      };
      const { runId: _run, status: _status, ...descriptor } = receipt;
      const file: MaterialFile = {
        ...descriptor,
        textSha256,
        textSize: text.byteLength,
        uploadedBy: input.uploadedBy,
        createdAt: (this.options.now ?? Date.now)(),
        ...(format.kind === "document"
          ? {
              conversion: {
                service: "workers-ai.toMarkdown" as const,
                sourceSha256: actual,
                outputSha256: textSha256,
                options: { format: "markdown" as const },
                status: "completed" as const
              }
            }
          : {})
      };
      // Validate the descriptor before any readiness record can be persisted.
      await materialSelection(undefined, [file]);
      const staged: StagedMaterial = {
        receipt,
        file,
        sourceFile: `${root}/source`,
        textFile: format.kind === "text" ? `${root}/source` : `${root}/text`
      };
      await this.options.fs.mkdir(root, { recursive: true });
      await this.options.fs.writeFile(staged.sourceFile, source);
      if (staged.textFile !== staged.sourceFile)
        await this.options.fs.writeFile(staged.textFile, text);
      this.options.put(key, staged);
      return structuredClone(receipt);
    })();
    this.staging.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.staging.get(key) === pending) this.staging.delete(key);
    }
  }
  private key(runId: string, id: string) {
    return (
      (this.options.ownerKind === "target-definition"
        ? "material:target-definition:"
        : "material:upload:") +
      materialId(runId) +
      ":" +
      materialId(id)
    );
  }
  get(runId: string, id: string): StagedMaterial {
    const record = this.options.get<StagedMaterial>(this.key(runId, id));
    if (!record)
      throw new Error("404: staged upload was not found in this run");
    return structuredClone(record);
  }
  async selection(
    runId: string,
    ids: string[],
    previous?: MaterialSelection
  ): Promise<MaterialSelection> {
    return materialSelection(
      previous,
      normalizeUploadIds(ids).map((id) => this.get(runId, id).file)
    );
  }
  async readSelectedFile(
    runId: string,
    id: string,
    path: string
  ): Promise<Uint8Array> {
    const value = this.get(runId, id);
    if (path === value.file.sourcePath)
      return this.readVerified(
        value.sourceFile,
        value.file.sha256,
        value.file.size
      );
    if (path === value.file.textPath)
      return this.readVerified(
        value.textFile,
        value.file.textSha256,
        value.file.textSize
      );
    throw new Error("404: File is not selected for preparation");
  }
  async copyInto(runId: string, ids: string[], dir: string): Promise<void> {
    if (
      !dir.startsWith("/") ||
      dir.split("/").some((p) => p === ".." || p === ".git") ||
      dir.includes("\0")
    )
      throw new Error("400: invalid trusted material destination");
    const selected = normalizeUploadIds(ids).map((id) => this.get(runId, id));
    await materialSelection(
      undefined,
      selected.map((value) => value.file)
    );
    // Verify all source bytes before mutating the trusted clone. Never copy unrelated staged uploads.
    const copies: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const staged of selected) {
      const source = await this.readVerified(
        staged.sourceFile,
        staged.file.sha256,
        staged.file.size
      );
      copies.push({ path: staged.file.sourcePath, bytes: source });
      if (staged.textFile !== staged.sourceFile)
        copies.push({
          path: staged.file.textPath,
          bytes: await this.readVerified(
            staged.textFile,
            staged.file.textSha256,
            staged.file.textSize
          )
        });
    }
    for (const copy of copies) {
      const path = `${dir.replace(/\/+$/, "")}/${copy.path}`;
      await this.options.fs.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true
      });
      await this.options.fs.writeFile(path, copy.bytes);
    }
  }
  private async readVerified(
    path: string,
    expected: string,
    size: number
  ): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(
        await this.options.fs.readFile(path),
        MATERIAL_FILE_LIMIT
      );
    } catch {
      throw new Error("409: staged material bytes are unavailable or changed");
    }
    if (bytes.byteLength !== size || (await materialHash(bytes)) !== expected)
      throw new Error("409: staged material bytes changed");
    return bytes;
  }
}

export async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<Uint8Array> {
  if (!body || typeof body.getReader !== "function")
    throw new Error("400: upload body is required");
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new Error("400: upload stream must contain bytes");
      size += value.byteLength;
      if (size > limit)
        throw new Error("413: material exceeds the two MiB byte limit");
      chunks.push(value.slice());
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
function validateText(bytes: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("400: material is not valid UTF-8 text");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    throw new Error("400: opaque binary material is unavailable");
}
function classify(
  name: string,
  bytes: Uint8Array
): { kind: "text" | "document"; mediaType: string } {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  const pdf = prefix.startsWith("%PDF-");
  const zip =
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  const documents: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet"
  };
  if (Object.hasOwn(documents, extension)) {
    if (!(extension === "pdf" ? pdf : zip))
      throw new Error("400: document bytes do not match its format");
    return { kind: "document", mediaType: documents[extension]! };
  }
  if (
    pdf ||
    zip ||
    prefix.startsWith("MZ") ||
    prefix.startsWith("\u007fELF") ||
    /^(png|jpe?g|gif|webp|bmp|svg|avif|ico|zip|tar|gz|bz2|xz|7z|rar|exe|dll|so|dylib|wasm|pcap|pcapng|doc|xls|ppt|pptx)$/.test(
      extension
    )
  )
    throw new Error(
      "400: images, archives and opaque binaries are unavailable"
    );
  validateText(bytes);
  return { kind: "text", mediaType: "text/plain" };
}
