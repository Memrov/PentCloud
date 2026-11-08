import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPicker } from "../src/ui/settings/model-picker";
import { PromptEditor } from "../src/ui/settings/prompt-editor";
import { ThemeControl } from "../src/ui/components/theme-control";

const model = {
  id: "openai/gpt-6-sol",
  name: "GPT-6 Sol",
  provider: "openai",
  contextLength: 1_048_576,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools", "reasoning_effort"],
  reasoningEfforts: ["max" as const]
};

describe("settings components", () => {
  it("renders an accessible native prompt editor with revision context and a disabled reset while locked", () => {
    const html = renderToStaticMarkup(
      createElement(PromptEditor, {
        roleLabel: "Coder",
        value: "Pinned prompt",
        upstreamDigest: "a".repeat(64),
        revision: "b".repeat(64),
        disabled: true,
        canReset: true,
        onChange: () => undefined,
        onReset: () => undefined
      })
    );

    expect(html).toContain('aria-label="Coder prompt template"');
    expect(html).toContain("Pinned prompt");
    expect(html).toContain("13 characters");
    expect(html).toContain("Upstream aaaaaaaa");
    expect(html).toContain("Revision bbbbbbbb");
    expect(html).toContain("disabled");
  });

  it("renders searchable connected model metadata and a stale-catalog state", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        models: [model],
        selectedId: model.id,
        stale: true,
        disabled: false,
        onSelect: () => undefined
      })
    );

    expect(html).toContain('aria-label="Search connected models"');
    expect(html).toContain("GPT-6 Sol");
    expect(html).toContain("openai/gpt-6-sol");
    expect(html).toContain("1.0M context");
    expect(html).toContain("Cached catalog");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="GPT-6 Sol"');
    expect(html).toContain('aria-label="Selected model"');
  });

  it("keeps a saved model visible when it disappears from the connected catalog", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        models: [model],
        selectedId: "retired/saved-model",
        stale: false,
        disabled: true,
        onSelect: () => undefined
      })
    );

    expect(html).toContain('value="retired/saved-model"');
    expect(html).toContain("Saved selection is not in the connected catalog");
    expect(html).toMatch(/role="combobox"[^>]*disabled/);
  });

  it("preserves whitespace and template delimiters without rewriting the prompt", () => {
    const prompt =
      "\t{{- if .Task }}\r\n  original guidance  \r\n{{ end -}}\r\n\r\n";
    const html = renderToStaticMarkup(
      createElement(PromptEditor, {
        roleLabel: "Primary",
        value: prompt,
        upstreamDigest: "a".repeat(64),
        revision: "b".repeat(64),
        disabled: false,
        canReset: false,
        onChange: () => undefined,
        onReset: () => undefined
      })
    );

    expect(html.match(/<textarea[^>]*>([\s\S]*)<\/textarea>/)?.[1]).toBe(
      prompt
    );
    expect(html).toContain('spellCheck="false"');
  });

  it("provides one accessible Kumo theme control for each application shell", () => {
    const html = renderToStaticMarkup(
      createElement(ThemeControl, { className: "dashboard-icon-button" })
    );
    expect(html).toContain('aria-label="Toggle theme"');
    expect(html).toContain('data-kumo-component="Button"');
    expect(html).toContain("dashboard-icon-button");
  });
});
