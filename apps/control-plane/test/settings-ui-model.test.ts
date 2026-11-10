import { describe, expect, it } from "vite-plus/test";

import {
  SETTINGS_ROLES,
  applyModelToAll,
  cloneRoles,
  filterModels,
  isDraftDirty,
  isRoleDirty,
  resetRole,
  savedModelsCatalog,
  type SettingsRoles
} from "../src/ui/settings/model";

const roles = (): SettingsRoles =>
  Object.fromEntries(
    SETTINGS_ROLES.map(({ id }, index) => [
      id,
      {
        promptTemplate: `prompt-${id}`,
        upstreamPromptDigest: String(index).padStart(64, "a"),
        model: "openai/gpt-6-sol",
        reasoningEffort: "max" as const
      }
    ])
  ) as SettingsRoles;

describe("settings UI model", () => {
  it("tracks role and whole-draft changes without mutating the saved snapshot", () => {
    const saved = roles();
    const draft = cloneRoles(saved);
    draft.coder.promptTemplate = "changed";

    expect(isRoleDirty(draft, saved, "coder")).toBe(true);
    expect(isRoleDirty(draft, saved, "primary")).toBe(false);
    expect(isDraftDirty(draft, saved)).toBe(true);
    expect(saved.coder.promptTemplate).toBe("prompt-coder");
  });

  it("resets one role to upstream and applies a model to all seven roles", () => {
    const draft = roles();
    const upstream = {
      promptTemplate: "upstream coder",
      upstreamPromptDigest: "f".repeat(64)
    };
    const reset = resetRole(draft, "coder", upstream);
    const applied = applyModelToAll(reset, "deepseek/deepseek-v4.1");

    expect(reset.coder).toMatchObject(upstream);
    expect(reset.coder.model).toBe("openai/gpt-6-sol");
    expect(Object.values(applied).map((role) => role.model)).toEqual(
      Array(7).fill("deepseek/deepseek-v4.1")
    );
  });

  it("searches connected models by id, name, or provider", () => {
    const models = [
      {
        id: "openai/gpt-6-sol",
        name: "GPT-6 Sol",
        provider: "openai",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportedParameters: [],
        reasoningEfforts: ["max" as const]
      },
      {
        id: "deepseek/deepseek-v4.1",
        name: "DeepSeek V4.1",
        provider: "deepseek",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportedParameters: [],
        reasoningEfforts: ["high" as const]
      }
    ];

    expect(filterModels(models, "deep").map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4.1"
    ]);
    expect(filterModels(models, "OpenAI").map((model) => model.id)).toEqual([
      "openai/gpt-6-sol"
    ]);
    expect(filterModels(models, "")).toEqual(models);
  });

  it("keeps saved models available when live discovery is unavailable", () => {
    const saved = roles();
    saved.coder.model = "deepseek/deepseek-v4.1";

    expect(savedModelsCatalog(saved, "2026-10-30T00:00:00Z")).toMatchObject({
      stale: true,
      models: [
        { id: "deepseek/deepseek-v4.1", provider: "deepseek" },
        { id: "openai/gpt-6-sol", provider: "openai" }
      ]
    });
  });
  it("tracks per-role search edits and preserves them when resetting instructions or applying a model", () => {
    const saved = roles();
    const draft = cloneRoles(saved);
    draft.searcher.searchProvider = "exa";
    expect(isRoleDirty(draft, saved, "searcher")).toBe(true);
    expect(isRoleDirty(draft, saved, "primary")).toBe(false);
    const reset = resetRole(draft, "searcher", {
      promptTemplate: "upstream",
      upstreamPromptDigest: "f".repeat(64)
    });
    expect(
      applyModelToAll(reset, "opencode-go:deepseek-v4-pro").searcher
        .searchProvider
    ).toBe("exa");
    expect(
      applyModelToAll(reset, "opencode-go:deepseek-v4-pro").searcher
        .reasoningEffort
    ).toBe("max");
    expect(
      applyModelToAll(reset, "opencode-go:other", ["default", "high"]).searcher
        .reasoningEffort
    ).toBe("default");
    expect(saved.searcher.searchProvider).toBeUndefined();
  });
});
