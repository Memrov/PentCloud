import { expect, it } from "vite-plus/test";
import { z } from "zod";
import { openCodeTool } from "../src/native/cloudflare-tools";

it.each(["returned error", "error-text", "error-json"] as const)(
  "surfaces %s as an OpenCode tool failure",
  async (format) => {
    const tool = await openCodeTool("computer_write", {
      inputSchema: z.object({}),
      execute: async () =>
        format === "returned error"
          ? { error: "Write denied by workspace policy" }
          : {},
      ...(format === "returned error"
        ? {}
        : {
            toModelOutput: () =>
              format === "error-text"
                ? { type: "error-text" as const, value: "Write denied" }
                : {
                    type: "error-json" as const,
                    value: { message: "Write denied" }
                  }
          })
    });
    await expect(
      tool.execute({}, "call", new AbortController().signal)
    ).rejects.toThrow("Write denied");
  }
);

it("preserves a command's nonzero exit status for the model to interpret", async () => {
  const tool = await openCodeTool("computer_exec", {
    inputSchema: z.object({}),
    execute: async () => ({ exitCode: 1, stdout: "", stderr: "No matches" })
  });
  expect(
    (await tool.execute({}, "call", new AbortController().signal)).content
  ).toContain('"exitCode":1');
});

it("validates SDK input, applies defaults and settles streaming tools", async () => {
  const tool = await openCodeTool("computer_exec", {
    inputSchema: z.object({ value: z.number().default(42) }),
    execute: async function* (input) {
      yield { running: true };
      yield { value: input.value };
    }
  });
  expect(
    (await tool.execute({}, "call", new AbortController().signal)).content
  ).toContain('"value":42');
  await expect(
    tool.execute({ value: "wrong" }, "call", new AbortController().signal)
  ).rejects.toThrow("Invalid");
});
it("keeps browser images in UI metadata and out of text model output", async () => {
  const tool = await openCodeTool("cloudflare_browser", {
    inputSchema: z.object({}),
    execute: async () => ({
      result: {
        type: "browser_screenshot",
        mediaType: "image/png",
        data: "aGVsbG8="
      }
    }),
    toModelOutput: () => ({
      type: "text" as const,
      value: "Screenshot captured"
    })
  });
  const result = await tool.execute({}, "call", new AbortController().signal);
  expect(result.content).toBe("Screenshot captured");
  expect(result.metadata?.cloudflareImages).toEqual([
    "data:image/png;base64,aGVsbG8="
  ]);
});
it("does not serialize binary file output into the text model prompt", async () => {
  const tool = await openCodeTool("computer_read", {
    inputSchema: z.object({}),
    execute: async () => ({}),
    toModelOutput: () => ({
      type: "content" as const,
      value: [
        { type: "text" as const, text: "Image file" },
        { type: "file-data" as const, mediaType: "image/png", data: "aGVsbG8=" }
      ]
    })
  });
  const result = await tool.execute({}, "call", new AbortController().signal);
  expect(result.content).toContain("Image file");
  expect(result.content).not.toContain("aGVsbG8=");
});
