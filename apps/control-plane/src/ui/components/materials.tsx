import { Badge, Banner, Button, LinkButton, Surface, Text, Tooltip } from "@cloudflare/kumo";
import { DownloadSimpleIcon, FileTextIcon, PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent } from "react";
import { AttachmentDraft, MATERIAL_ACCEPT, listRunFiles, materialFileURL, readMaterialPreview, type PendingMaterial, type RunFile, type RunFiles } from "../materials-api";

export function useMaterialDraft(runId: string) {
  const draft = useMemo(() => new AttachmentDraft(runId), [runId]);
  const snapshot = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  return {draft, ...snapshot, ready: snapshot.files.every(file => file.status === "ready"), uploadIds: snapshot.files.flatMap(file => file.receipt ? [file.receipt.id] : [])};
}
/** Native picker/drop/paste with the existing Kumo composer, no second chat store. */
export function MaterialAttachments({draft, files, error, disabled = false}: {draft: AttachmentDraft; files: PendingMaterial[]; error?: string; disabled?: boolean}) {
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const drop = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    if (!disabled) void draft.add(Array.from(event.dataTransfer.files));
  };
  return <section className={`material-attachments grid min-w-0 gap-2 text-base ${dragging ? "rounded-lg ring-2 ring-kumo-brand" : ""}`} aria-label="Chat attachments"
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); if (!disabled) setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
    <div className="material-picker-row flex flex-wrap items-center gap-2">
      <input ref={picker} className="material-file-input sr-only" type="file" multiple accept={MATERIAL_ACCEPT} aria-label="Choose chat files" disabled={disabled}
        onChange={event => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (!disabled) void draft.add(selected); }} />
      <Button variant="secondary" icon={<PaperclipIcon size={15} />} disabled={disabled} onClick={() => picker.current?.click()}>Attach files</Button>
      <Tooltip content="Drop or paste documents, source or configs. Up to 8 files, 2 MiB each, 8 MiB total." render={<Button variant="ghost" shape="square" aria-label="File attachment limits" icon={<FileTextIcon size={16}/>}/>}/>
    </div>
    {files.length > 0 && <ul className="material-staged-list grid max-h-40 gap-2 overflow-auto">{files.map(item => <li key={item.id} className="material-staged-card flex items-center gap-2">
      <FileTextIcon size={17} /><div className="material-file-copy grid min-w-0 flex-1 gap-1 break-words text-base"><Text bold>{item.file.name}</Text><Text variant="secondary">{formatFileSize(item.file.size)} · {item.status === "ready" ? "Staged for next input" : item.status === "hashing" ? "Preparing…" : item.status === "uploading" ? "Uploading and processing…" : "Upload failed"}</Text>{item.error && <Text variant="error" role="alert">{item.error}</Text>}</div>
      {item.status === "ready" && <Badge variant="secondary">Staged</Badge>}
      {item.status === "failed" && <Button variant="secondary" disabled={disabled} onClick={() => void draft.retry(item.id)}>Retry upload</Button>}
      <Button variant="ghost" shape="square" icon={<XIcon size={14} />} aria-label={`Remove ${item.file.name}`} disabled={disabled} onClick={() => draft.remove(item.id)} />
    </li>)}</ul>}
    {error && <Banner className="composer-error" variant="error" role="alert" description={error}/>}
    {dragging && <p className="material-drop-hint text-base text-kumo-subtle">Drop documents, source or configs here</p>}
  </section>;
}
/** Paste files without swallowing ordinary text clipboard content. */
export function pasteMaterials(event: ClipboardEvent, draft: AttachmentDraft, disabled = false) {
  const files = Array.from(event.clipboardData.files);
  if (!files.length) return;
  event.preventDefault();
  if (!disabled) void draft.add(files);
}
export function dropMaterials(event: DragEvent, draft: AttachmentDraft, disabled = false) {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault(); event.stopPropagation();
  if (!disabled) void draft.add(Array.from(event.dataTransfer.files));
}
export function MaterialPreview({name, text, truncated}: {name: string; text: string; truncated: boolean}) {
  return <section className="material-preview grid gap-2 text-base" aria-label={`Preview ${name}`}><strong>{name}</strong><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-base">{text}</pre>{truncated && <p>Preview limited to 64 KiB. Download the file for its full contents.</p>}</section>;
}
export function RunFilesPanel({runId, jobId}: {runId: string; jobId: string}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<RunFiles>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<{name: string; text: string; truncated: boolean}>();
  const [previewPath, setPreviewPath] = useState<string>();
  const previewSequence = useRef(0);
  useEffect(() => {
    if (!open) return;
    let live = true; setLoading(true); setError(undefined);
    void listRunFiles(runId, jobId).then(value => { if (live) setSnapshot(value); }).catch(caught => { if (live) setError(caught instanceof Error ? caught.message : "Files unavailable"); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [runId, jobId, open, refresh]);
  useEffect(() => () => { previewSequence.current++; }, []);
  const read = async (file: RunFile) => {
    const sequence = ++previewSequence.current; setPreview(undefined); setPreviewPath(file.path); setError(undefined);
    try { const value = await readMaterialPreview(runId, file); if (previewSequence.current === sequence) setPreview({name: file.name, ...value}); }
    catch (caught) { if (previewSequence.current === sequence) setError(caught instanceof Error ? caught.message : "Preview unavailable"); }
    finally { if (previewSequence.current === sequence) setPreviewPath(undefined); }
  };
  return <section className="run-files-panel grid min-w-0 gap-3 text-base" aria-label="Attempt files">
    <Button variant="secondary" icon={<PaperclipIcon size={15} />} aria-expanded={open} onClick={() => setOpen(value => !value)}>Files{snapshot ? ` (${snapshot.files.length})` : ""}</Button>
    {open && <Surface className="run-files-content grid min-w-0 gap-3 rounded-lg px-4 py-3 ring ring-kumo-line">
      <div className="material-panel-heading flex flex-wrap items-center justify-between gap-2"><strong>Files pinned to this attempt</strong><Button variant="ghost" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh files</Button></div>
      <p className="material-provenance break-words text-base text-kumo-subtle">Selected files are input evidence; selection does not mean the specialist has read them.</p>
      {snapshot && <p className="material-provenance break-words text-base text-kumo-subtle">Commit <code title={snapshot.commit}>{snapshot.commit.slice(0, 12)}</code>{snapshot.materialsDigest && <> · Material set <code title={snapshot.materialsDigest}>{snapshot.materialsDigest.slice(0, 12)}</code></>}</p>}
      {loading && <p role="status">Loading files…</p>}
      {error && <Banner className="composer-error" variant="error" role="alert" description={error}/>}
      {snapshot?.files.length === 0 && !loading && <p>No files at this attempt's selected commit.</p>}
      {snapshot && <ul className="material-file-list grid gap-3">{snapshot.files.map(file => <li className="flex flex-wrap items-center gap-2" key={file.path}>
        <FileTextIcon size={17} /><div className="material-file-copy grid min-w-0 flex-1 gap-1 break-words text-base"><Text bold>{file.name}</Text><Text variant="secondary">{file.kind} · {formatFileSize(file.size)}</Text><code title={file.path}>{file.path}</code>{file.sha256 && <Text variant="secondary" title={file.sha256}>SHA-256 {file.sha256.slice(0, 16)}</Text>}{file.sourceSha256 && <Text variant="secondary" title={file.sourceSha256}>Derived from {file.sourceSha256.slice(0, 16)}</Text>}</div>
        {file.previewable && <Button variant="ghost" disabled={previewPath === file.path} onClick={() => void read(file)}>{previewPath === file.path ? "Opening…" : "Preview"}</Button>}
        <LinkButton variant="secondary" className="material-download" href={materialFileURL(runId, file)} download={file.name} aria-label={`Download ${file.name}`}><DownloadSimpleIcon size={16} /> Download</LinkButton>
      </li>)}</ul>}
      {preview && <><div className="material-preview-actions"><Button variant="ghost" onClick={() => { previewSequence.current++; setPreview(undefined); }}>Close preview</Button></div><MaterialPreview {...preview} /></>}
    </Surface>}
  </section>;
}
function formatFileSize(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`; }
