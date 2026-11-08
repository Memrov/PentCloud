import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  MaterialStore,
  type MaterialStoreOptions
} from "../src/native/material-store";

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const stream = (value: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(value);
      c.close();
    }
  });
function harness(convert?: MaterialStoreOptions["convert"]) {
  const files = new Map<string, Uint8Array>();
  const state = new Map<string, unknown>();
  const fs = {
    async mkdir() {},
    async readFile(path: string, encoding?: unknown) {
      const value = files.get(path);
      if (!value) throw new Error("ENOENT");
      return encoding === "utf8"
        ? new TextDecoder().decode(value)
        : stream(value.slice());
    },
    async writeFile(
      path: string,
      input: string | Uint8Array | ReadableStream<Uint8Array>
    ) {
      files.set(
        path,
        typeof input === "string"
          ? bytes(input)
          : input instanceof Uint8Array
            ? input.slice()
            : new Uint8Array(await new Response(input).arrayBuffer())
      );
    }
  } as MaterialStoreOptions["fs"];
  const options: MaterialStoreOptions = {
    fs,
    get: <T>(key: string) => structuredClone(state.get(key)) as T | undefined,
    put: (key, value) => {
      state.set(key, structuredClone(value));
    },
    now: () => 123,
    ...(convert ? { convert } : {})
  };
  return { store: new MaterialStore(options), options, files, state };
}
function input(value = bytes("hello\n"), extra: Record<string, unknown> = {}) {
  return {
    runId: "run-one",
    id: "upload-one",
    name: "source.ts",
    sha256: hash(value),
    body: stream(value),
    uploadedBy: "owner",
    ...extra
  };
}

describe("bounded material staging", () => {
  it("persists exact source bytes before returning a ready reusable receipt", async () => {
    const h = harness(),
      original = bytes("const π = 3;\r\n");
    const receipt = await h.store.stage(input(original));
    expect(receipt).toEqual({
      id: "upload-one",
      runId: "run-one",
      name: "source.ts",
      sha256: hash(original),
      size: original.length,
      mediaType: "text/plain",
      kind: "text",
      status: "ready",
      sourcePath: `.pentagi/materials/${hash(original)}/source`,
      textPath: `.pentagi/materials/${hash(original)}/source`
    });
    const staged = new MaterialStore(h.options).get("run-one", "upload-one");
    expect(h.files.get(staged.sourceFile)).toEqual(original);
    expect(staged.file).toMatchObject({
      textSha256: hash(original),
      textSize: original.length,
      uploadedBy: "owner",
      createdAt: 123
    });
    await h.store.copyInto("run-one", ["upload-one"], "/trusted/repo");
    expect(h.files.get(`/trusted/repo/${receipt.sourcePath}`)).toEqual(
      original
    );
    expect(() => h.store.get("another-run", "upload-one")).toThrow("404");
  });

  it("validates incoming duplicate bytes and keeps the original receipt and conversion", async () => {
    let conversions = 0;
    const h = harness(async () => ({
      format: "markdown",
      data: `converted ${++conversions}`
    }));
    const raw = bytes("%PDF-1.7\nfixture");
    const first = await h.store.stage(input(raw, { name: "report.pdf" }));
    const again = await new MaterialStore({
      ...h.options,
      now: () => 999
    }).stage(input(raw, { name: "report.pdf" }));
    expect(again).toEqual(first);
    expect(h.store.get("run-one", "upload-one").file).toMatchObject({
      uploadedBy: "owner",
      createdAt: 123
    });
    expect(
      [...h.files.values()].map((b) => new TextDecoder().decode(b))
    ).toContain("converted 1");
    expect(
      [...h.files.values()].map((b) => new TextDecoder().decode(b))
    ).not.toContain("converted 2");
    await expect(
      h.store.stage(input(bytes("%PDF-1.7\nchanged"), { name: "report.pdf" }))
    ).rejects.toThrow("409");
    await expect(
      h.store.stage(input(raw, { name: "renamed.pdf" }))
    ).rejects.toThrow("409");
    await expect(
      h.store.stage(
        input(raw, { name: "report.pdf", uploadedBy: "different-owner" })
      )
    ).rejects.toThrow("409");
    await expect(
      h.store.stage(
        input(bytes("different"), { name: "report.pdf", sha256: hash(raw) })
      )
    ).rejects.toThrow("409");
  });

  it("rejects invalid hashes, names, identities and unsupported binary formats", async () => {
    const h = harness();
    for (const override of [
      { sha256: "invalid" },
      { sha256: "0".repeat(64) },
      { name: "../source.ts" },
      { name: "x\\y" },
      { name: "bad\0.txt" },
      { name: " " },
      { name: "x".repeat(181) },
      { id: "../x" },
      { runId: "../../x" }
    ])
      await expect(
        h.store.stage(input(bytes("hello"), override))
      ).rejects.toThrow("400");
    for (const [name, raw] of [
      ["x.txt", new Uint8Array([0xff, 0xfe])],
      ["x.txt", bytes("a\0b")],
      ["x.zip", bytes("PK\x03\x04test")],
      ["x.exe", bytes("MZplain")],
      ["x.png", bytes("text")],
      ["x.svg", bytes("<svg/>")],
      ["x.pdf", bytes("plain")],
      ["x.docx", bytes("plain")]
    ] as const)
      await expect(h.store.stage(input(raw, { name }))).rejects.toThrow("400");
    expect(h.state.size).toBe(0);
  });

  it("enforces stream byte limits without trusting Content-Length and cancels excess input", async () => {
    const h = harness();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024 * 1024).fill(65));
      },
      cancel() {
        cancelled = true;
      }
    });
    await expect(
      h.store.stage(input(bytes("unused"), { body }))
    ).rejects.toThrow("413");
    expect(cancelled).toBe(true);
    expect(h.state.size).toBe(0);
    await expect(h.store.stage(input(new Uint8Array()))).rejects.toThrow("400");
  });

  it("does not create a ready receipt for converter errors, missing conversion or oversized derivatives", async () => {
    const raw = bytes("%PDF-1.7\nfixture");
    for (const convert of [
      undefined,
      async () => ({ format: "error", error: "encrypted" }),
      async () => ({ format: "markdown", data: "" }),
      async () => ({
        format: "markdown",
        data: "x".repeat(2 * 1024 * 1024 + 1)
      }),
      async () => {
        throw new Error("service unavailable");
      }
    ]) {
      const h = harness(convert);
      await expect(
        h.store.stage(input(raw, { name: "report.pdf" }))
      ).rejects.toThrow("400");
      expect(() => h.store.get("run-one", "upload-one")).toThrow("404");
    }
  });

  it("records source-to-text conversion hashes and copies only selected verified material bytes", async () => {
    const h = harness(async ({ name, blob }) => ({
      format: "markdown",
      data: `# ${name}\n${blob.size} bytes`,
      mimetype: "application/pdf"
    }));
    const raw = bytes("%PDF-1.7\nfixture");
    await h.store.stage(input(raw, { name: "report.pdf" }));
    await h.store.stage(
      input(bytes("other\n"), { id: "not-selected", name: "other.txt" })
    );
    const staged = h.store.get("run-one", "upload-one");
    const text = bytes("# report.pdf\n16 bytes");
    expect(staged.file).toMatchObject({
      textSha256: hash(text),
      textSize: text.length,
      conversion: {
        service: "workers-ai.toMarkdown",
        sourceSha256: hash(raw),
        outputSha256: hash(text),
        options: { format: "markdown" },
        status: "completed"
      }
    });
    await h.store.copyInto("run-one", ["upload-one"], "/trusted/repo");
    expect(h.files.get(`/trusted/repo/${staged.receipt.textPath}`)).toEqual(
      text
    );
    const selected = await h.store.selection("run-one", ["upload-one"]);
    expect(selected.files.map((f) => f.name)).toEqual(["report.pdf"]);
    expect(
      [...h.files.keys()].filter((p) => p.startsWith("/trusted/repo/"))
    ).toHaveLength(2);
    h.files.set(staged.sourceFile, bytes("tampered"));
    await expect(
      h.store.copyInto("run-one", ["upload-one"], "/trusted/other")
    ).rejects.toThrow("409");
    expect(
      [...h.files.keys()].some((p) => p.startsWith("/trusted/other/"))
    ).toBe(false);
  });

  it("does not publish readiness when storage fails and permits safe retry", async () => {
    const h = harness();
    const write = h.options.fs.writeFile.bind(h.options.fs);
    let first = true;
    h.options.fs.writeFile = async (...args: Parameters<typeof write>) => {
      if (first) {
        first = false;
        throw new Error("disk failed");
      }
      return write(...args);
    };
    await expect(h.store.stage(input())).rejects.toThrow("disk failed");
    expect(() => h.store.get("run-one", "upload-one")).toThrow("404");
    expect((await h.store.stage(input())).status).toBe("ready");
  });

  it("rejects prototype property extensions before invoking document conversion", async () => {
    let conversions = 0;
    const h = harness(async () => {
      conversions++;
      return { format: "markdown", data: "should never convert" };
    });
    await expect(
      h.store.stage(
        input(bytes("PK\x03\x04fixture"), { name: "archive.__proto__" })
      )
    ).rejects.toThrow("400");
    expect(conversions).toBe(0);
  });

  it("serializes overlapping duplicate conversion requests and preserves readiness across re-instantiation", async () => {
    let finish: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let sequence = 0;
    const h = harness(async () => {
      const current = ++sequence;
      entered!();
      await release;
      return { format: "markdown", data: `version ${current}` };
    });
    const raw = bytes("%PDF-1.7\nfixture");
    const first = h.store.stage(input(raw, { name: "report.pdf" }));
    await started;
    const second = h.store.stage(input(raw, { name: "report.pdf" }));
    finish!();
    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
    const restored = new MaterialStore({
      ...h.options,
      convert: async () => ({
        format: "error",
        error: "must reuse successful conversion"
      })
    });
    expect(await restored.stage(input(raw, { name: "report.pdf" }))).toEqual(
      one
    );
    const staged = restored.get("run-one", "upload-one");
    expect(h.files.get(staged.textFile)).toEqual(bytes("version 1"));
  });

  it("accepts the exact raw bound and each supported signed document format", async () => {
    const h = harness(async ({ blob }) => ({
      format: "text",
      data: `derived ${blob.type}`
    }));
    const raw = new Uint8Array(2 * 1024 * 1024).fill(65);
    expect((await h.store.stage(input(raw))).size).toBe(2 * 1024 * 1024);
    for (const [extension, mediaType] of [
      [
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ],
      [
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ],
      ["odt", "application/vnd.oasis.opendocument.text"],
      ["ods", "application/vnd.oasis.opendocument.spreadsheet"]
    ] as const) {
      const receipt = await h.store.stage(
        input(bytes("PK\x03\x04fixture"), {
          id: extension,
          name: `report.${extension}`
        })
      );
      expect(receipt.mediaType).toBe(mediaType);
      const staged = h.store.get("run-one", extension);
      expect(h.files.get(staged.textFile)).toEqual(
        bytes(`derived ${mediaType}`)
      );
    }
  });

  it("rejects altered derived bytes before writing anything into a target checkout", async () => {
    const h = harness(async () => ({ format: "markdown", data: "# original" }));
    await h.store.stage(
      input(bytes("%PDF-1.7\nfixture"), { name: "report.pdf" })
    );
    h.files.set(
      h.store.get("run-one", "upload-one").textFile,
      bytes("# altered!")
    );
    await expect(
      h.store.copyInto("run-one", ["upload-one"], "/trusted/repo")
    ).rejects.toThrow("409");
    expect(
      [...h.files.keys()].some((p) => p.startsWith("/trusted/repo/"))
    ).toBe(false);
  });
});
