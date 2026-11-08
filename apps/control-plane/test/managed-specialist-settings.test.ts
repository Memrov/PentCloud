import { describe, expect, it } from "vitest";
import {
  ACTIVE_ROLES,
  createAgentSettings,
  defaultAgentSettings
} from "../src/settings/catalog";
import { SEARCH_PROVIDERS } from "../../../shared/search-providers";

describe("managed specialist defaults", () => {
  it("uses substantive plain Markdown while retaining pinned upstream identity", async () => {
    const settings = await defaultAgentSettings(
      "opencode-go:deepseek-v4-pro",
      "default"
    );
    for (const role of ACTIVE_ROLES) {
      expect(settings.roles[role].promptFormat).toBe("markdown");
      expect(settings.roles[role].searchProvider).toBe("tinyfish");
      expect(settings.roles[role].promptTemplate).not.toContain("{{.");
      expect(settings.roles[role].promptTemplate).toContain("##");
    }
    expect(settings.roles.coder.upstreamPromptDigest).toBe(
      "20d2920d8b860b723d58da160bf9b63bf317d59dfa5b6a7d3453dc22c6a48807"
    );
    expect(Object.keys(settings.roles)).toEqual([...ACTIVE_ROLES]);
  });
  it.each([undefined, "pentagi-template"] as const)(
    "rejects %s executable format without rewriting the saved role",
    async (promptFormat) => {
      const settings = await defaultAgentSettings(
        "opencode-go:deepseek-v4-pro",
        "default"
      );
      settings.roles.primary.promptTemplate = "Historical {{.Cwd}}";
      if (promptFormat === undefined)
        delete settings.roles.primary.promptFormat;
      else settings.roles.primary.promptFormat = promptFormat;
      const historical = structuredClone(settings);
      await expect(
        createAgentSettings(settings.roles, "operator", new Date(0))
      ).rejects.toThrow(/primary prompt template.*retired.*Markdown/);
      expect(settings).toEqual(historical);
    }
  );
  it("rejects blank Markdown through the normal client-validation error", async () => {
    const settings = await defaultAgentSettings(
      "opencode-go:deepseek-v4-pro",
      "default"
    );
    settings.roles.primary.promptTemplate = "  \n\t";
    await expect(
      createAgentSettings(settings.roles, "operator", new Date(0))
    ).rejects.toThrow("primary prompt template is empty");
  });
  it("defaults historical search settings and pins each role's choice in the revision", async () => {
    const initial = await defaultAgentSettings(
      "opencode-go:deepseek-v4-pro",
      "default"
    );
    const roles = structuredClone(initial.roles);
    delete roles.searcher.searchProvider;
    expect(
      (await createAgentSettings(roles, "operator", new Date(0))).revision
    ).toBe(initial.revision);
    for (const { id } of SEARCH_PROVIDERS) {
      roles.searcher.searchProvider = id;
      const saved = await createAgentSettings(roles, "operator", new Date(0));
      expect(saved.roles.searcher.searchProvider).toBe(id);
      expect(saved.roles.primary.searchProvider).toBe("tinyfish");
      expect(saved.revision === initial.revision).toBe(id === "tinyfish");
    }
    expect(initial.roles.searcher.searchProvider).toBe("tinyfish");
  });
  it.each(["random", "opencode", "unknown", null])(
    "rejects unsupported search provider %s",
    async (searchProvider) => {
      const settings = await defaultAgentSettings(
        "opencode-go:deepseek-v4-pro",
        "default"
      );
      Object.assign(settings.roles.searcher, { searchProvider });
      await expect(
        createAgentSettings(settings.roles, "operator", new Date(0))
      ).rejects.toThrow("searcher search provider is invalid");
    }
  );
});
