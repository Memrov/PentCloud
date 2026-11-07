import { describe, expect, it } from "vitest";
import { renderMarkdownLaunch } from "../src/native/markdown-launch";

describe("native specialist Markdown launch", () => {
  it("preserves the entire specialist guidance and separates immutable task input", async () => {
    const source = "# Coder\nPreserve methodology, evidence and code quality.\nLiteral {{example}} stays literal.\n";
    const launch = await renderMarkdownLaunch("coder", { question: "work <&> 🐈", z: 2, a: 1 }, source, {
      now: "2026-10-31T00:00:00Z", cwd: "/workspace/repo/attempt-1", lang: "English",
    });
    expect(launch.prompt).toContain(source);
    expect(launch.prompt).toContain('"question":"work <&> 🐈"');
    expect(launch.prompt).toContain("/workspace/repo/attempt-1");
    expect(launch.prompt).toContain("code_result");
    expect(launch.prompt).toContain("never blindly retry");
    expect(launch.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    const reordered = await renderMarkdownLaunch("coder", { a: 1, z: 2, question: "work <&> 🐈" }, source, {
      now: "2026-10-31T00:00:00Z", cwd: "/workspace/repo/attempt-1", lang: "English",
    });
    expect(reordered).toEqual(launch);
  });

  it("hashes substantive instructions and rejects invalid role/source/task inputs", async () => {
    const first = await renderMarkdownLaunch("reporter", {}, "Evaluate actual evidence.");
    const second = await renderMarkdownLaunch("reporter", {}, "Evaluate claims without evidence.");
    expect(first.promptDigest).not.toBe(second.promptDigest);
    expect(first.prompt).toContain("report_result");
    await expect(renderMarkdownLaunch("invalid", {}, "x")).rejects.toThrow("specialist");
    await expect(renderMarkdownLaunch("coder", {}, "")).rejects.toThrow("empty");
    await expect(renderMarkdownLaunch("coder", [] as unknown as Record<string, unknown>, "x")).rejects.toThrow("object");
  });
  it("advertises installed package execution instead of promising a Kali backend",async()=>{
    const launch=await renderMarkdownLaunch("coder",{},"Retain evidence.",{toolBackend:"tool-packs"});
    expect(launch.prompt).toContain("pentcloud_tool");
    expect(launch.prompt).toContain("bounded profiles");
    expect(launch.prompt).not.toContain("existing private stock Kali MCP");
  });
});
