import { expect, it, vi } from "vitest";
import { OnboardingStore } from "../src/native/onboarding";
import {
  SourceLibrary,
  publicGitHubURL,
  readSource
} from "../src/native/source-context";
import { preparationTool } from "../src/native/preparation";

const first = "a".repeat(40),
  second = "b".repeat(40),
  root = "c".repeat(40),
  file = "d".repeat(40);
function fixture() {
  const records = new Map<string, unknown>();
  let head = first,
    ready = true;
  const io = {
    get: <T>(k: string) => structuredClone(records.get(k)) as T | undefined,
    put: (k: string, v: unknown) => {
      records.set(k, structuredClone(v));
    },
    list: <T>(p: string) =>
      [...records]
        .filter(([k]) => k.startsWith(p))
        .map(([, v]) => structuredClone(v) as T),
    remove: (k: string) => {
      records.delete(k);
    }
  };
  const store = new OnboardingStore(io),
    target = store.saveTarget(
      {
        id: "target-one",
        kind: "website",
        name: "Owned",
        url: "https://owned.example"
      },
      null,
      "owner"
    );
  const repo = {
    [Symbol.dispose]() {},
    info: vi.fn(async () => ({ id: "repo-identity", defaultBranch: "main" })),
    log: vi.fn(async () => [{ hash: head }]),
    readCommit: vi.fn(async (hash: string) => ({ hash, treeHash: root })),
    readTree: vi.fn(async () => [
      { name: "README.md", hash: file, type: "blob" },
      { name: "link", hash: file, type: "symlink" },
      { name: "submodule", hash: file, type: "gitlink" }
    ]),
    readBlob: vi.fn(async () => new Blob(["first line\nsecond line\n"]))
  };
  const binding = {
    get: vi.fn(async () => {
      if (!ready)
        throw Object.assign(new Error("importing"), {
          code: "IMPORT_IN_PROGRESS"
        });
      return repo;
    }),
    import: vi.fn(async () => ({
      token: "never-expose-import-token",
      name: "imported"
    })),
    list: vi.fn(async () => ({
      repos: [
        {
          name: "context",
          defaultBranch: "main",
          token: "never-expose-list-token"
        }
      ],
      cursor: "next"
    }))
  };
  // External Cloudflare capability substitute; no model, scanner or production I/O.
  const artifacts = binding as unknown as Artifacts;
  const library = new SourceLibrary({
    ...io,
    artifacts,
    target: (id) => store.target(id),
    save: (id, revision, sources, actor) =>
      store.saveSources(id, revision, sources, actor),
    assertOpen: () => {}
  });
  return {
    library,
    store,
    records,
    target,
    artifacts,
    binding,
    repo,
    setHead: (value: string) => {
      head = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    }
  };
}
it("pins separate source, preserves it through edits, and keeps old runs stable after refresh/removal", async () => {
  const f = fixture();
  const saved = await f.library.attach(
    f.target.id,
    1,
    "context",
    undefined,
    "owner"
  );
  expect(saved.sources![0]).toMatchObject({
    repo: "context",
    branch: "main",
    commit: first,
    repoId: "repo-identity"
  });
  const run = structuredClone(saved);
  const edited = f.store.saveTarget(
    { ...saved, name: "Renamed" },
    saved.revision,
    "owner"
  );
  expect(edited.sources).toEqual(saved.sources);
  await expect(
    f.library.attach(saved.id, saved.revision, "other", undefined, "owner")
  ).rejects.toThrow(/changed/);
  f.setHead(second);
  const refreshed = await f.library.refresh(
    saved.id,
    edited.revision,
    saved.sources![0]!.id,
    "owner"
  );
  expect(refreshed.sources![0]!.commit).toBe(second);
  expect(run.sources![0]!.commit).toBe(first);
  const removed = f.library.detach(
    saved.id,
    refreshed.revision,
    saved.sources![0]!.id,
    "owner"
  );
  expect(removed.sources).toEqual([]);
  expect(run.sources).toHaveLength(1);
  const result = await readSource(
    f.artifacts,
    run.sources!,
    run.sources![0]!.id,
    "file",
    "README.md"
  );
  expect(result).toMatchObject({
    commit: first,
    startLine: 1,
    text: "first line\nsecond line\n"
  });
  expect(f.repo.readCommit).toHaveBeenLastCalledWith(first);
});
it("never accepts caller-injected pins or restores another installation's source authority", async () => {
  const f = fixture();
  const target = await f.library.attach(
    f.target.id,
    1,
    "context",
    "main",
    "owner"
  );
  const exported = f.store.exportData(),
    fresh = fixture();
  fresh.records.clear();
  expect(fresh.store.importData(exported, "owner")).toMatchObject({
    sourcesNeedReattachment: true
  });
  expect(fresh.store.target(target.id).sources).toBeUndefined();
});
it("uses native import once and recovers the same pending import without storing its token", async () => {
  const f = fixture();
  f.setReady(false);
  expect(
    await f.library.importPublic(
      f.target.id,
      1,
      "https://github.com/owner/repo",
      "main",
      "request-one",
      "owner"
    )
  ).toMatchObject({ status: "pending" });
  expect(
    await f.library.importPublic(
      f.target.id,
      1,
      "https://github.com/owner/repo",
      "main",
      "request-one",
      "owner"
    )
  ).toMatchObject({ status: "pending" });
  expect(f.binding.import).toHaveBeenCalledTimes(1);
  expect(f.binding.import.mock.calls[0]).toMatchObject([
    {
      source: {
        url: "https://github.com/owner/repo",
        depth: 1,
        branch: "main"
      },
      target: { opts: { readOnly: true } }
    }
  ]);
  f.setReady(true);
  const done = await f.library.importPublic(
    f.target.id,
    1,
    "https://github.com/owner/repo",
    "main",
    "request-one",
    "owner"
  );
  expect(done).toMatchObject({
    status: "ready",
    target: {
      sources: [{ commit: first, origin: "https://github.com/owner/repo" }]
    }
  });
  expect(JSON.stringify([...f.records.values()])).not.toContain("never-expose");
  await expect(
    f.library.importPublic(
      f.target.id,
      1,
      "https://github.com/other/repo",
      "main",
      "request-one",
      "owner"
    )
  ).rejects.toThrow(/changed/);
});
it("reconciles an unknown import outcome without dispatching again", async () => {
  const f = fixture();
  f.setReady(false);
  f.binding.import.mockRejectedValueOnce(new Error("response lost"));
  await f.library.importPublic(
    f.target.id,
    1,
    "https://github.com/owner/repo",
    undefined,
    "lost-response",
    "owner"
  );
  f.setReady(true);
  expect(
    await f.library.importPublic(
      f.target.id,
      1,
      "https://github.com/owner/repo",
      undefined,
      "lost-response",
      "owner"
    )
  ).toMatchObject({ status: "ready" });
  expect(f.binding.import).toHaveBeenCalledTimes(1);
});
it("imports a fresh public snapshot for future runs while retaining the previous source identity and commit", async () => {
  const f = fixture(),
    initial = await f.library.importPublic(
      f.target.id,
      1,
      "https://github.com/owner/repo",
      "main",
      "initial-import",
      "owner"
    );
  expect(initial.status).toBe("ready");
  if (initial.status !== "ready") throw new Error("fixture import not ready");
  const target = initial.target,
    prior = structuredClone(target.sources![0]!);
  f.setHead(second);
  const updated = await f.library.importPublic(
    target.id,
    target.revision,
    prior.origin,
    "main",
    "refresh-import",
    "owner",
    prior.id
  );
  expect(updated).toMatchObject({
    status: "ready",
    target: { sources: [{ id: prior.id, commit: second }] }
  });
  if (updated.status === "ready")
    expect(updated.target.sources![0]!.repo).not.toBe(prior.repo);
  expect(prior.commit).toBe(first);
  expect(target.sources).toHaveLength(1);
  expect(f.binding.import).toHaveBeenCalledTimes(2);
});
it("rejects private upstreams without borrowing build credentials and projects safe repository choices", async () => {
  const f = fixture();
  f.binding.import.mockRejectedValueOnce(
    Object.assign(new Error("hidden upstream detail"), {
      code: "REMOTE_AUTH_REQUIRED"
    })
  );
  await expect(
    f.library.importPublic(
      f.target.id,
      1,
      "https://github.com/owner/private",
      undefined,
      "private-one",
      "owner"
    )
  ).rejects.toThrow(/terminal/);
  expect(await f.library.list()).toEqual({
    repos: [{ name: "context", defaultBranch: "main" }],
    cursor: "next"
  });
  for (const url of [
    "https://user:secret@github.com/a/b",
    "https://github.com/a/b?token=secret",
    "http://github.com/a/b",
    "https://example.com/a/b",
    "https://github.com/a/b/tree/main"
  ])
    expect(() => publicGitHubURL(url)).toThrow();
});
it("bounds source reads and refuses cross-run IDs, replaced repos, links and traversal", async () => {
  const f = fixture(),
    saved = await f.library.attach(f.target.id, 1, "context", "main", "owner"),
    pins = saved.sources!,
    id = pins[0]!.id;
  await expect(
    readSource(f.artifacts, pins, "other", "file", "README.md")
  ).rejects.toThrow(/not selected/);
  for (const path of [
    "../README.md",
    "/README.md",
    ".git/config",
    "link",
    "submodule"
  ])
    await expect(
      readSource(f.artifacts, pins, id, "file", path)
    ).rejects.toThrow();
  f.repo.readBlob.mockResolvedValueOnce(
    new Blob([new Uint8Array(256 * 1024 + 1)])
  );
  await expect(
    readSource(f.artifacts, pins, id, "file", "README.md")
  ).rejects.toThrow(/256 KiB/);
  f.repo.readBlob.mockResolvedValueOnce(new Blob([new Uint8Array([255])]));
  await expect(
    readSource(f.artifacts, pins, id, "file", "README.md")
  ).rejects.toThrow(/UTF-8/);
  f.repo.info.mockResolvedValueOnce({
    id: "replacement",
    defaultBranch: "main"
  });
  await expect(readSource(f.artifacts, pins, id, "tree", "")).rejects.toThrow(
    /identity changed/
  );
  expect(preparationTool("pentcloud_source_tree")).toBe(true);
  expect(preparationTool("pentcloud_source_read")).toBe(true);
});
