import { describe, expect, it } from "vitest";
import { ACTIVE_ROLES, createAgentSettings, defaultAgentSettings } from "../src/settings/catalog";

describe("managed specialist defaults", () => {
  it("uses substantive plain Markdown while retaining pinned upstream identity", async () => {
    const settings = await defaultAgentSettings("opencode-go:deepseek-v4-pro", "default");
    for (const role of ACTIVE_ROLES) {
      expect(settings.roles[role].promptFormat).toBe("markdown");
      expect(settings.roles[role].promptTemplate).not.toContain("{{.");
      expect(settings.roles[role].promptTemplate).toContain("##");
    }
    expect(settings.roles.coder.upstreamPromptDigest).toBe("20d2920d8b860b723d58da160bf9b63bf317d59dfa5b6a7d3453dc22c6a48807");
    expect(Object.keys(settings.roles)).toEqual([...ACTIVE_ROLES]);
  });
  it.each([undefined, "pentagi-template"] as const)("rejects %s executable format without rewriting the saved role", async (promptFormat) => {
    const settings = await defaultAgentSettings("opencode-go:deepseek-v4-pro", "default");
    settings.roles.primary.promptTemplate = "Historical {{.Cwd}}";
    if (promptFormat === undefined) delete settings.roles.primary.promptFormat;
    else settings.roles.primary.promptFormat = promptFormat;
    const historical = structuredClone(settings);
    await expect(createAgentSettings(settings.roles, "operator", new Date(0)))
      .rejects.toThrow(/primary prompt template.*retired.*Markdown/);
    expect(settings).toEqual(historical);
  });
  it("rejects blank Markdown through the normal client-validation error", async () => {
    const settings = await defaultAgentSettings("opencode-go:deepseek-v4-pro", "default");
    settings.roles.primary.promptTemplate = "  \n\t";
    await expect(createAgentSettings(settings.roles, "operator", new Date(0))).rejects.toThrow("primary prompt template is empty");
  });
});
