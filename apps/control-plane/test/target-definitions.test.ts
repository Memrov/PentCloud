import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  MaterialStore,
  type MaterialStoreOptions
} from "../src/native/material-store";
import { TargetDefinitions } from "../src/native/target-definitions";
describe("reusable target definitions", () => {
  it("copies exact bytes into a fresh run receipt and protects saved version updates", async () => {
    const records = new Map<string, unknown>(),
      files = new Map<string, Uint8Array>();
    const io = {
      get: <T>(k: string) => structuredClone(records.get(k)) as T | undefined,
      put: (k: string, v: unknown) => {
        records.set(k, structuredClone(v));
      }
    };
    const read = async (path: string) =>
      new Blob([new Uint8Array(files.get(path)!)]).stream();
    const fs = {
      mkdir: async () => {},
      readFile: read,
      writeFile: async (path: string, input: any) => {
        files.set(
          path,
          typeof input === "string"
            ? new TextEncoder().encode(input)
            : input instanceof Uint8Array
              ? input
              : new Uint8Array(await new Response(input).arrayBuffer())
        );
      }
    } as unknown as MaterialStoreOptions["fs"];
    const materials = new MaterialStore({ ...io, fs }),
      library = new MaterialStore({
        ...io,
        fs,
        ownerKind: "target-definition"
      }),
      store = new TargetDefinitions({
        ...io,
        materials: library,
        runMaterials: materials,
        read
      });
    const bytes = new TextEncoder().encode('{"openapi":"3.1.0","paths":{}}'),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const input = () => ({
      name: "openapi.json",
      sha256,
      body: new Blob([bytes]).stream(),
      uploadedBy: "owner"
    });
    const first = await store.save("target-one", 0, input());
    expect(first.version).toBe(1);
    expect(
      library.get(first.stagingRunId, first.uploadId).sourceFile
    ).toContain("/target-definitions/");
    expect(() => materials.get(first.stagingRunId, first.uploadId)).toThrow(
      /not found/
    );
    expect((await store.save("target-one", 0, input())).version).toBe(1);
    const uploadId = await store.copyIntoRun(first, "run-new", "owner"),
      receipt = materials.get("run-new", uploadId);
    expect(receipt.receipt.runId).toBe("run-new");
    expect(receipt.receipt.sha256).toBe(sha256);
    expect(receipt.receipt.id).not.toBe(first.uploadId);
    expect(await (await store.response("target-one", 1)).text()).toBe(
      new TextDecoder().decode(bytes)
    );
    const next = new TextEncoder().encode('{"openapi":"3.1.1"}'),
      hash = createHash("sha256").update(next).digest("hex");
    await expect(
      store.save("target-one", 0, {
        name: "openapi.json",
        sha256: hash,
        body: new Blob([next]).stream(),
        uploadedBy: "owner"
      })
    ).rejects.toThrow(/changed/);
  });
});
