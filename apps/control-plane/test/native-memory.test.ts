import {afterEach, describe, expect, it} from "vitest";
import {mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {originalMemoryScope, searchWorkingMemory} from "../src/native/memory-retrieval";

const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pentcloud-memory-"));
  roots.push(root);
  const stat = async (path: string) => {
    const value = await lstat(path);
    return {name: path.split("/").at(-1)!, inode: value.ino, mode: value.mode, mtime: value.mtimeMs,
      size: value.size, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink()};
  };
  const workspace = {root, fs: {
    lstat: stat,
    readdir: async (path: string, options?: {limit?: number; offset?: number}) => {
      const names = (await readdir(path)).sort().slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? Infinity));
      return Promise.all(names.map(async name => ({...await stat(join(path, name)), name, parentPath: path})));
    },
  }, resolve: async (path: string) => join(root, path), readText: (path: string) => readFile(path, "utf8"), active: async () => {}};
  const put = async (path: string, content: string) => {await mkdir(join(root, path, ".."), {recursive: true}); await writeFile(join(root, path), content);};
  return {root, workspace, put};
}
describe("bounded working-tree memory", () => {
  it("does not spend a typed code search's file budget on unrelated answers", async () => {
    const {workspace, put} = await fixture();
    await Promise.all(Array.from({length: 1024}, (_, n) => put(`.pentagi/memory/answer/${String(n).padStart(4, "0")}.md`, "unrelated answer\n")));
    await put(".pentagi/memory/code/needle.md", '---\nselectors: {"lang":"python"}\n---\n\nunique-code-needle\n');
    const result = await searchWorkingMemory(workspace, "search_code", {questions: ["unique-code-needle"], lang: "python"});
    expect(result.matches.map(match => match.path)).toEqual([".pentagi/memory/code/needle.md"]);
    expect(result.truncated).toBe(false);
  });
  it("refuses to guess missing legacy selectors or numeric native scope", async () => {
    const {workspace, put} = await fixture();
    await put(".pentagi/memory/code/legacy.md", "legacy needle without language metadata\n");
    const typed = await searchWorkingMemory(workspace, "search_code", {questions: ["needle"], lang: "python"});
    expect(typed.matches).toEqual([]);
    expect(typed.excluded_missing_metadata).toBe(1);
    const broad = await searchWorkingMemory(workspace, "search_in_memory", {questions: ["needle"]});
    expect(broad.matches[0]?.text).toBe("legacy needle without language metadata");
    await expect(searchWorkingMemory(workspace, "search_in_memory", {questions: ["needle"], task_id: 1})).rejects.toThrow("Cannot map requested task/subtask scope");
    expect(() => originalMemoryScope({task_id: 1}, {task_id: 2})).toThrow("conflicting");
  });
  it("skips symlink files and directories without reading outside memory", async () => {
    const {root, workspace, put} = await fixture();
    await put("outside.md", "secret-marker\n");
    await mkdir(join(root, ".pentagi/memory/code"), {recursive: true});
    await symlink(join(root, "outside.md"), join(root, ".pentagi/memory/code/link.md"));
    await symlink(root, join(root, ".pentagi/memory/elsewhere"));
    const result = await searchWorkingMemory(workspace, "search_in_memory", {questions: ["secret-marker"]});
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
