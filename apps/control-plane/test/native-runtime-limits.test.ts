import { describe, expect, it } from "vitest";
import { budgetLoader } from "../src/native/runtime-limits";

describe("native Dynamic Worker budgets", () => {
  it("caps SDK-created named and anonymous worker code while preserving lower limits and capabilities", async () => {
    const seen: Array<{ name?: string | null; code: WorkerLoaderWorkerCode }> = [];
    const stub = Object.create(null) as WorkerStub;
    const loader: WorkerLoader = {
      get: (name, code) => {
        void Promise.resolve(code()).then(code => { seen.push({ name, code }); });
        return stub;
      },
      load: code => { seen.push({ code }); return stub; },
    };
    const bounded = budgetLoader(loader, { cpuMs: 30000, subRequests: 256 });
    const code: WorkerLoaderWorkerCode = {
      compatibilityDate: "2026-10-31", mainModule: "index.js", modules: { "index.js": "export default {}" },
      env: { HOST: "host capability" }, globalOutbound: null,
      limits: { cpuMs: 10000, subRequests: 1000 },
    };
    bounded.get("shell", async () => code);
    bounded.load({ ...code, limits: { cpuMs: 50000 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen[0]!.code.limits).toEqual({ cpuMs: 30000, subRequests: 256 });
    expect(seen[1]!.code.limits).toEqual({ cpuMs: 10000, subRequests: 256 });
    expect(seen[1]!.name).toContain("shell");
    expect(seen[1]!.code.env).toEqual({ HOST: "host capability" });
    expect(seen[1]!.code.globalOutbound).toBeNull();
    expect(code.limits).toEqual({ cpuMs: 10000, subRequests: 1000 });
  });
});
