import { describe, expect, it } from "vitest";
import { ACTIVE_ROLES, createAgentSettings, defaultAgentSettings, upstreamRoleSettings } from "../src/settings/catalog";

describe("managed specialist defaults", () => {
  it("uses substantive plain Markdown while retaining original template sources", async () => {
    const settings = await defaultAgentSettings("opencode-go:deepseek-v4-pro", "default");
    for (const role of ACTIVE_ROLES) {
      expect(settings.roles[role].promptFormat).toBe("markdown");
      expect(settings.roles[role].promptTemplate).not.toContain("{{.");
      expect(settings.roles[role].promptTemplate).toContain("##");
      expect(settings.roles[role].upstreamPromptDigest).toBe(upstreamRoleSettings(role).upstreamPromptDigest);
    }
    expect(upstreamRoleSettings("coder").promptTemplate).toContain("{{.Cwd}}");
    expect(Object.keys(settings.roles)).toEqual([...ACTIVE_ROLES]);
  });
  it("rejects blank Markdown through the normal client-validation error", async () => {
    const settings = await defaultAgentSettings("opencode-go:deepseek-v4-pro", "default");
    settings.roles.primary.promptTemplate = "  \n\t";
    await expect(createAgentSettings(settings.roles, "operator", new Date(0))).rejects.toThrow("primary prompt template is empty");
  });
});
