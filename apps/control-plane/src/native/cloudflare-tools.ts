import { asSchema, type Tool, type ToolSet } from "ai";

/** Adapt the public SDK tool surface without copying its schemas or executors. */
export async function openCodeTool(name: string, entry: ToolSet[string]) {
  // ToolSet is a union of typed-input tools; execution follows schema validation.
  const tool = entry as Tool;
  const schema = asSchema(tool.inputSchema);
  return {
    name,
    description: typeof tool.description === "function" ? tool.description({ context: {} }) : tool.description ?? name,
    input: { ...await schema.jsonSchema },
    async execute(raw: unknown, id: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const parsed = schema.validate ? await schema.validate(raw) : { success: true as const, value: raw };
      if (!parsed.success) throw new Error(`Invalid ${name} arguments: ${parsed.error.message}`);
      if (!tool.execute) throw new Error(`No executor for ${name}`);
      const pending = await tool.execute(parsed.value, { toolCallId: id, messages: [], context: {}, abortSignal: signal });
      let output: unknown = pending;
      if (pending && typeof pending === "object" && Symbol.asyncIterator in pending)
        for await (const value of pending) output = value;
      signal.throwIfAborted();
      // The SDK's model conversion bounds file reads and summarizes screenshots;
      // binary image data must never become a giant text prompt.
      const model = tool.toModelOutput
        ? await tool.toModelOutput({ input: parsed.value, output, toolCallId: id })
        : { type: "json" as const, value: output };
      const content = model.type === "content"
        ? model.value.map(part => part.type === "text" ? part.text : "[Binary file omitted from text model context]").join("\n")
        : model.type === "text" || model.type === "error-text" ? model.value : JSON.stringify(model);
      const result = output && typeof output === "object" && "result" in output ? output.result : undefined;
      const images = name === "cloudflare_browser" && result && typeof result === "object" &&
        "type" in result && result.type === "browser_screenshot" && "mediaType" in result &&
        (result.mediaType === "image/png" || result.mediaType === "image/jpeg") &&
        "data" in result && typeof result.data === "string" && result.data.length <= 1_000_000 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(result.data)
        ? [`data:${result.mediaType};base64,${result.data}`] : [];
      return { content, ...(images.length ? { metadata: { cloudflareImages: images } } : {}) };
    },
  };
}
export type CloudflareTool = Awaited<ReturnType<typeof openCodeTool>>;
