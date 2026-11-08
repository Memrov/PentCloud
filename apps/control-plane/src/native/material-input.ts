import {
  materialHash,
  materialSelection,
  selectionManifest,
  type MaterialSelection
} from "./materials";

interface MaterialReader {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
}
async function bytes(
  fs: MaterialReader,
  path: string,
  maximum: number
): Promise<Uint8Array> {
  const reader = (await fs.readFile(path)).getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error("Pinned material size changed");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const value = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}
/** Verify the exact committed material set before the session can call its model. */
export async function verifyMaterialInput(
  fs: MaterialReader,
  root: string,
  context: Record<string, unknown>
): Promise<MaterialSelection | undefined> {
  if (context.materials === undefined) return;
  const raw = context.materials as MaterialSelection;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.files))
    throw new Error("Pinned material manifest is invalid");
  const selected = await materialSelection(undefined, raw.files);
  if (
    raw.digest !== selected.digest ||
    raw.manifestPath !== selected.manifestPath ||
    selectionManifest(raw) !== selectionManifest(selected)
  )
    throw new Error("Pinned material manifest digest changed");
  const manifest = selectionManifest(selected),
    expected = new TextEncoder().encode(manifest);
  const actual = await bytes(
    fs,
    `${root}/${selected.manifestPath}`,
    expected.byteLength
  );
  if (new TextDecoder().decode(actual) !== manifest)
    throw new Error("Pinned material manifest bytes changed");
  for (const file of selected.files) {
    for (const [path, sha, size] of [
      [file.sourcePath, file.sha256, file.size],
      [file.textPath, file.textSha256, file.textSize]
    ] as const) {
      const value = await bytes(fs, `${root}/${path}`, size);
      if (value.byteLength !== size || (await materialHash(value)) !== sha)
        throw new Error("Pinned material bytes/hash changed");
    }
  }
  return selected;
}
