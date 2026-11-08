/** Private byte transfer. Credentials and Git authority never enter Kali. */
export const KALI_FILE_LIMIT = 2 * 1024 * 1024;
export const KALI_FILE_COUNT = 64;
export interface ToolboxFileScope {
  generation: string;
  runId: string;
  attemptId: string;
}
export interface ToolboxStockOutput {
  family: string;
  scanId?: string;
  file?: string;
}
export interface ToolboxFile {
  path: string;
  size: number;
  sha256: string;
}
export interface ToolboxFileList {
  root: string;
  files: ToolboxFile[];
  truncated: boolean;
  unavailable: Array<{ path: string; reason: string }>;
}
export interface ToolboxFileService {
  putFile(
    scope: ToolboxFileScope,
    file: ToolboxFile,
    body: ReadableStream<Uint8Array>
  ): Promise<ToolboxFile>;
  listFiles(
    scope: ToolboxFileScope,
    stock?: ToolboxStockOutput
  ): Promise<ToolboxFileList>;
  getFile(
    scope: ToolboxFileScope,
    path: string,
    stock?: ToolboxStockOutput
  ): Promise<Response>;
}
export function toolboxFileRoot(scope: ToolboxFileScope): string {
  for (const value of [scope?.generation, scope?.runId, scope?.attemptId])
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value)
    )
      throw new Error("400: Invalid transfer identity");
  return `/work/pentcloud/${scope.runId}/${scope.attemptId}`;
}
export function toolboxFilePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 512 ||
    /[\\\x00-\x1f\x7f]/.test(path) ||
    path.startsWith("/")
  )
    throw new Error("400: Invalid transfer path");
  if (
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("400: Invalid transfer path");
  return path;
}
export function toolboxStockRoot(stock: ToolboxStockOutput): string {
  if (
    ![
      "nmap",
      "masscan",
      "whatweb",
      "nuclei",
      "sqlmap",
      "ffuf",
      "waybackurls",
      "binwalk",
      "searchsploit",
      "playwright",
      "payloads"
    ].includes(stock.family) ||
    (!stock.file &&
      (!stock.scanId ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{7,100}$/.test(stock.scanId)))
  )
    throw new Error("400: Invalid stock evidence identity");
  if (stock.file) toolboxFilePath(stock.file);
  return `/opt/kali-mcp/output/${stock.family}`;
}
