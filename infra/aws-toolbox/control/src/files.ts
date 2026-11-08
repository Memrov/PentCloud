import { FILE_HELPER } from "./file-helper";
import {
  KALI_FILE_LIMIT,
  toolboxFileRoot,
  toolboxFilePath,
  toolboxStockRoot,
  type ToolboxFileScope,
  type ToolboxStockOutput,
  type ToolboxFile,
  type ToolboxFileList
} from "../../../../shared/toolbox-files";

export class KaliFiles {
  constructor(
    private readonly container: () => Container,
    private readonly verify: (scope: ToolboxFileScope) => Promise<void>
  ) {}
  private command(
    scope: ToolboxFileScope,
    mode: string,
    extra: Record<string, unknown> = {},
    stock?: ToolboxStockOutput
  ) {
    const root = stock ? toolboxStockRoot(stock) : toolboxFileRoot(scope);
    return [
      "/opt/venv/bin/python3",
      "-c",
      FILE_HELPER,
      JSON.stringify({
        root,
        mode,
        ...extra,
        ...(stock?.scanId ? { scanId: stock.scanId } : {}),
        ...(stock?.file ? { allowedPath: stock.file } : {})
      })
    ];
  }
  private async metadata<T>(
    scope: ToolboxFileScope,
    mode: string,
    extra: Record<string, unknown> = {},
    stock?: ToolboxStockOutput,
    body?: ReadableStream<Uint8Array>
  ): Promise<T> {
    await this.verify(scope);
    const process = await this.container().exec(
      this.command(scope, mode, extra, stock),
      { ...(body ? { stdin: body } : {}), signal: AbortSignal.timeout(30_000) }
    );
    const output = await process.output();
    if (output.exitCode !== 0 || output.stdout.byteLength > 65536)
      throw new Error(
        "409: File transfer rejected; verify path, size, hash and existing bytes"
      );
    await this.verify(scope);
    return JSON.parse(new TextDecoder().decode(output.stdout)) as T;
  }
  async put(
    scope: ToolboxFileScope,
    file: ToolboxFile,
    body: ReadableStream<Uint8Array>
  ): Promise<ToolboxFile> {
    const root = toolboxFileRoot(scope);
    toolboxFilePath(file.path);
    if (
      !file.path.startsWith("inputs/") ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > KALI_FILE_LIMIT ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("400: Invalid input file metadata");
    const result = await this.metadata<ToolboxFile>(
      scope,
      "put",
      { ...file },
      undefined,
      body
    );
    return { ...result, path: `${root}/${file.path}` };
  }
  async list(
    scope: ToolboxFileScope,
    stock?: ToolboxStockOutput
  ): Promise<ToolboxFileList> {
    toolboxFileRoot(scope);
    const value = await this.metadata<Omit<ToolboxFileList, "root">>(
      scope,
      "list",
      {},
      stock
    );
    return {
      ...value,
      root: stock ? toolboxStockRoot(stock) : toolboxFileRoot(scope)
    };
  }
  async get(
    scope: ToolboxFileScope,
    path: string,
    stock?: ToolboxStockOutput
  ): Promise<Response> {
    toolboxFileRoot(scope);
    toolboxFilePath(path);
    const file = await this.metadata<ToolboxFile>(
      scope,
      "stat",
      { path },
      stock
    );
    await this.verify(scope);
    const process = await this.container().exec(
      this.command(scope, "get", { ...file }, stock),
      { signal: AbortSignal.timeout(30_000) }
    );
    const reader = process.stdout?.getReader();
    if (!reader) throw new Error("503: File stream unavailable");
    let size = 0;
    const verify = this.verify;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if ((await process.exitCode) !== 0 || size !== file.size)
              throw new Error("File stream incomplete");
            await verify(scope);
            controller.close();
            return;
          }
          size += chunk.value.byteLength;
          if (size > file.size || size > KALI_FILE_LIMIT)
            throw new Error("File stream exceeds expected size");
          controller.enqueue(chunk.value);
        } catch {
          process.kill(15);
          await reader.cancel().catch(() => undefined);
          controller.error(new Error("File transfer interrupted"));
        }
      },
      async cancel() {
        process.kill(15);
        await reader.cancel().catch(() => undefined);
      }
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-SHA256": file.sha256,
        "X-Content-Size": String(file.size)
      }
    });
  }
}
