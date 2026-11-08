import { renderMarkdownLaunch } from "./markdown-launch";

export interface LaunchContext {
  toolBackend?: "tool-packs" | "stock-kali";
  promptFormat?: "markdown" | "pentagi-template";
  now?: string | Date;
  cwd?: string;
  dockerImage?: string;
  lang?: string;
  userFiles?: string;
  enabledTools?: string[];
}
export function assertMarkdownPromptFormat(
  format: LaunchContext["promptFormat"]
): void {
  if (format !== "markdown")
    throw new Error(
      "Legacy prompt template execution is retired; migrate the role to Markdown instructions before launching new work"
    );
}

/** New launches require explicit Markdown; historical prompts and digests stay stored verbatim. */
export async function renderLaunch(
  role: string,
  args: Record<string, unknown>,
  source: string,
  context: LaunchContext = {}
): Promise<{ prompt: string; promptDigest: string }> {
  assertMarkdownPromptFormat(context.promptFormat);
  return renderMarkdownLaunch(role, args, source, context);
}
