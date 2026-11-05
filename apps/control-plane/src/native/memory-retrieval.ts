import type { Workspace } from "@cloudflare/computer";

type Scope = Partial<Record<"task_id" | "subtask_id", number>>;

/** Native run/job strings are never fabricated into the original numeric IDs. */
export function originalMemoryScope(...sources: Record<string, unknown>[]): Scope {
  const scope: Scope = {};
  for (const source of sources) for (const key of ["task_id", "subtask_id"] as const) {
    const value = source[key];
    if (value === undefined || value === null || value === 0) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      throw new Error(`Cannot map ${key}: original numeric memory scope requires an explicit positive safe integer`);
    if (scope[key] !== undefined && scope[key] !== value)
      throw new Error(`Cannot map ${key}: conflicting original memory scope metadata`);
    scope[key] = value;
  }
  return scope;
}

interface MemoryWorkspace {
  fs: Pick<Workspace["fs"], "readdir" | "lstat">;
  resolve(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  active(): Promise<unknown>;
}

function selectors(text: string): Record<string, unknown> {
  const end = text.indexOf("\n---\n", 4);
  const header = text.startsWith("---\n") && end >= 0 ? text.slice(4, end) : "";
  const encoded = header.match(/^selectors: (.+)$/m)?.[1];
  if (encoded !== undefined) {
    try {
      const value: unknown = JSON.parse(encoded);
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
  }
  // Historical entries stored original type/lang only as scalar Markdown sections.
  // Ambiguous sections are not guessed, so prose/code cannot silently override a selector.
  const result: Record<string, unknown> = {};
  for (const key of ["lang", "type"] as const) {
    const values = [...text.matchAll(new RegExp(`^## ${key}\\r?\\n\\r?\\n([^\\r\\n]+)\\r?\\n(?=\\r?\\n## |$)`, "gm"))];
    if (values.length === 1) result[key] = values[0]![1];
  }
  return result;
}

/** Literal retrieval includes untracked current work without granting publication authority. */
export async function searchWorkingMemory(workspace: MemoryWorkspace, name: string, args: Record<string, unknown>) {
  const queries = [args.query, args.question, ...(Array.isArray(args.questions) ? args.questions : [])]
    .filter((query): query is string => typeof query === "string" && !!query.trim());
  if (!queries.length) throw new Error("Memory query is required");
  const kind = name === "search_in_memory" ? undefined : name.slice(7);
  const scope = originalMemoryScope(args);
  const scoped = Object.keys(scope).length > 0;
  const selected = name === "search_code" ? "lang" : name === "search_guide" || name === "search_answer" ? "type" : undefined;
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let truncated = false, visited = 0, bytes = 0, missingMetadata = 0, scopeMapped = !scoped;
  const pending = [kind ? `.pentagi/memory/${kind}` : ".pentagi/memory"];
  let directories = 0;
  while (pending.length && visited < 1024 && directories < 128) {
    const directory = pending.shift()!;
    const absolute = await workspace.resolve(directory);
    let entries;
    try { entries = await workspace.fs.readdir(absolute, {limit: 1025}); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    directories++;
    if (entries.length > 1024) truncated = true;
    for (const entry of entries.slice(0, 1024)) {
      if (entry.isSymbolicLink) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        if (path.split("/").length < 8 && pending.length < 128) pending.push(path);
        else truncated = true;
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;
      if (++visited > 1024) { truncated = true; break; }
      if (kind && path.split("/")[2] !== kind) continue;
      const resolved = await workspace.resolve(path);
      const stat = await workspace.fs.lstat(resolved);
      if (!stat.isFile || stat.isSymbolicLink) continue;
      if (stat.size > 2 * 1024 * 1024 || bytes + stat.size > 8 * 1024 * 1024) { truncated = true; continue; }
      bytes += stat.size;
      await workspace.active();
      const text = await workspace.readText(resolved);
      const metadata = selectors(text);
      if (selected && metadata[selected] === undefined) { missingMetadata++; continue; }
      if (selected && metadata[selected] !== args[selected]) continue;
      if (scoped && !Object.entries(scope).every(([key, value]) => metadata[key] === value)) {
        if (Object.keys(scope).some(key => metadata[key] === undefined)) missingMetadata++;
        continue;
      }
      scopeMapped = true;
      for (const [index, line] of text.split("\n").entries()) {
        if (!queries.some(query => line.toLowerCase().includes(query.toLowerCase()))) continue;
        matches.push({path, line: index + 1, text: line.slice(0, 4000)});
        if (matches.length >= 200) { truncated = true; break; }
      }
      if (matches.length >= 200) break;
    }
    if (matches.length >= 200) break;
  }
  truncated ||= pending.length > 0;
  if (!scopeMapped)
    throw new Error(`Cannot map requested task/subtask scope: no matching original numeric scope metadata in this run's ${truncated ? "bounded " : ""}Git memory. Native run/job IDs are not original numeric task IDs.`);
  return {queries, matches, truncated, ...(missingMetadata ? {excluded_missing_metadata: missingMetadata} : {}),
    filters: {...(kind ? {kind} : {}), ...(selected ? {[selected]: args[selected]} : {}), ...scope},
    method: "Git memory literal case-insensitive retrieval"};
}
