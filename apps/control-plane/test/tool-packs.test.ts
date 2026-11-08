import { describe, it, expect } from "vitest";
import { assertPackAccess, packFileNames } from "../../../shared/tool-packs";
import {
  replayPackCall,
  packResultPreview,
  journalPackCall
} from "../src/native/tool-pack-operation";

function storage() {
  const records = new Map<string, unknown>();
  let queue = Promise.resolve();
  const s = {
    delete: async (k: string) => records.delete(k),
    get: async (k: string) => structuredClone(records.get(k)),
    put: async (k: string, v: unknown) => {
      records.set(k, structuredClone(v));
    },
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...records].filter(([k]) => k.startsWith(prefix))),
    transaction: <T>(fn: (tx: DurableObjectStorage) => Promise<T>) => {
      const p = queue.then(() => fn(s as unknown as DurableObjectStorage));
      queue = p.then(
        () => undefined,
        () => undefined
      );
      return p;
    }
  };
  return s as unknown as DurableObjectStorage;
}
const scope = {
  runId: "run-owned",
  attemptId: "attempt-owned",
  role: "pentester"
};
describe("bounded tool pack access", () => {
  it("keeps scanner permissions restricted while permitting the initial WhatWeb discovery", () => {
    expect(() => assertPackAccess(scope, "http")).not.toThrow();
    for (const role of [
      "primary",
      "reporter",
      "searcher",
      "memorist",
      "adviser"
    ])
      expect(() => assertPackAccess({ ...scope, role }, "http")).toThrow(
        /role/
      );
    expect(() =>
      assertPackAccess({ ...scope, discovery: true }, "web-context", {
        tool: "whatweb",
        target: "https://owned.example/"
      })
    ).not.toThrow();
    expect(() =>
      assertPackAccess({ ...scope, role: "primary", discovery: true }, "http", {
        tool: "curl"
      })
    ).toThrow(/Discovery/);
    expect(() =>
      assertPackAccess({ ...scope, runId: "../other" }, "http")
    ).toThrow(/ownership/);
  });
  it("requires only the files consumed by an offline profile", () => {
    expect(packFileNames({ pack: "http", request: { tool: "curl" } })).toEqual(
      []
    );
    expect(
      packFileNames({
        pack: "pcap",
        request: { tool: "tshark" },
        files: { input: "capture.pcap" }
      })
    ).toEqual(["input"]);
    expect(() =>
      packFileNames({
        pack: "pcap",
        request: { tool: "tshark" },
        files: { other: "capture.pcap" }
      })
    ).toThrow(/required/);
    expect(() =>
      packFileNames({
        pack: "password",
        request: { tool: "hashcat", view: "sha256-dictionary" },
        files: { input: "hashes" }
      })
    ).toThrow(/required/);
  });
});
describe("pack execution uses the existing remote receipt namespace", () => {
  it("sends a tool call once and replays its durable result", async () => {
    const state = storage();
    let calls = 0;
    const input = {
      pack: "http",
      request: { tool: "curl", target: "https://owned.example/" }
    };
    const send = async () => {
      calls++;
      return { exitCode: 0, stdout: "owned fixture" };
    };
    expect(
      await journalPackCall(state, "remote:pack-one", input, send)
    ).toEqual({ exitCode: 0, stdout: "owned fixture" });
    expect(
      await journalPackCall(state, "remote:pack-one", input, send)
    ).toEqual({ exitCode: 0, stdout: "owned fixture" });
    expect(calls).toBe(1);
    await expect(
      journalPackCall(
        state,
        "remote:pack-one",
        {
          ...input,
          request: { tool: "curl", target: "https://different.example/" }
        },
        send
      )
    ).rejects.toThrow(/identity/);
  });
  it("fences an interrupted call and never silently rescans", async () => {
    const state = storage();
    let calls = 0;
    const input = {
      pack: "nuclei",
      request: { tool: "nuclei", target: "https://owned.example/" }
    };
    const send = async () => {
      calls++;
      throw Error("connection lost");
    };
    await expect(
      journalPackCall(state, "remote:pack-lost", input, send)
    ).rejects.toThrow(/unknown/);
    await expect(
      journalPackCall(state, "remote:pack-lost", input, send)
    ).rejects.toThrow(/unknown/);
    expect(calls).toBe(1);
  });
  it("does not dispatch after cancellation or while another remote operation is unresolved", async () => {
    const state = storage();
    let calls = 0;
    const send = async () => {
      calls++;
    };
    await state.put("cancelled", true);
    await expect(
      journalPackCall(state, "remote:pack-stop", {}, send)
    ).rejects.toThrow(/stopped/);
    await state.delete("cancelled");
    await state.put("remote:other", { state: "unknown" });
    await expect(
      journalPackCall(state, "remote:pack-stop", {}, send)
    ).rejects.toThrow(/unresolved/);
    expect(calls).toBe(0);
  });
});

import { toolResultFiles, EVIDENCE_FILE_LIMIT } from "../src/native/evidence";
it("preserves oversized Unicode tool results in bounded evidence parts", () => {
  const record = {
    stdout: "🧪".repeat(EVIDENCE_FILE_LIMIT / 2),
    stderr: "complete stderr",
    exitCode: 0
  };
  const files = toolResultFiles(record),
    manifest = JSON.parse(new TextDecoder().decode(files.at(-1)!.bytes));
  expect(files.every((f) => f.bytes.byteLength <= EVIDENCE_FILE_LIMIT)).toBe(
    true
  );
  expect(manifest.parts).toEqual(files.slice(0, -1).map((f) => f.name));
  const bytes = new Uint8Array(
    files.slice(0, -1).reduce((n, f) => n + f.bytes.length, 0)
  );
  let offset = 0;
  for (const f of files.slice(0, -1)) {
    bytes.set(f.bytes, offset);
    offset += f.bytes.length;
  }
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(record);
});

it("keeps the discovery HTTP status outside a truncated model preview", () => {
  const result = packResultPreview(
    {
      stdout: JSON.stringify([
        { http_status: 200, plugins: { title: "x".repeat(40000) } }
      ]),
      exitCode: 0
    },
    "web-context",
    []
  );
  expect(result.httpStatus).toBe(200);
  expect(result.modelPreviewTruncated).toBe(true);
});

it("replays completed file work without rereading a changed input", async () => {
  const s = storage();
  await journalPackCall(
    s,
    "remote:pack-files",
    { requestDigest: "stable", files: { input: { sha256: "old" } } },
    async () => ({ stdout: "saved" })
  );
  expect(await replayPackCall(s, "remote:pack-files", "stable")).toEqual({
    result: { stdout: "saved" }
  });
  await expect(
    replayPackCall(s, "remote:pack-files", "changed")
  ).rejects.toThrow(/identity changed/);
});
