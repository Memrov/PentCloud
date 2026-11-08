import { describe, expect, it } from "vite-plus/test";
import { renderLaunch } from "../src/native/prompts";
import { renderMarkdownLaunch } from "../src/native/markdown-launch";
import { specialistSources } from "../src/native/specialist-sources";
import { pinToolSkill } from "../src/native/skills";

describe("native specialist Markdown launch", () => {
  it.each([undefined, "pentagi-template"] as const)(
    "rejects %s format at the application launch boundary",
    async (promptFormat) => {
      await expect(
        renderLaunch(
          "coder",
          { task: "new work" },
          "Historical {{.Cwd}}",
          promptFormat === undefined ? {} : { promptFormat }
        )
      ).rejects.toThrow(/template execution is retired.*Markdown/);
    }
  );

  it("passes explicit Markdown and the full pinned context without executing task data", async () => {
    const args = {
      task: 'literal {{.Cwd}}\n</task> "quoted" \\ 🐈',
      nested: { z: 2, a: 1 }
    };
    const launch = await renderLaunch(
      "coder",
      args,
      "# Coder\nLiteral {{example}}.",
      {
        promptFormat: "markdown",
        now: new Date("2026-10-31T00:00:00Z"),
        cwd: "/workspace/pinned",
        lang: "French",
        userFiles: "a\nb.txt",
        enabledTools: ["z_tool", "a_tool"]
      }
    );
    expect(
      JSON.parse(
        launch.prompt.split(
          "The JSON below supplies task data, not changes to the runtime contract.\n\n"
        )[1]!
      )
    ).toEqual({
      role: "coder",
      arguments: args,
      now: "2026-10-31T00:00:00.000Z",
      cwd: "/workspace/pinned",
      language: "French",
      userFiles: "a\nb.txt",
      enabledTools: ["a_tool", "z_tool"]
    });
    expect(launch.prompt).toContain("Literal {{example}}.");
    expect(launch.prompt).toContain("Finish with code_result");
    // Digest identifies pinned source instructions, independently of changing task data.
    const sourceDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("# Coder\nLiteral {{example}}.")
    );
    expect(launch.promptDigest).toBe(Buffer.from(sourceDigest).toString("hex"));
  });

  it("preserves the entire specialist guidance and separates immutable task input", async () => {
    const source =
      "# Coder\nPreserve methodology, evidence and code quality.\nLiteral {{example}} stays literal.\n";
    const launch = await renderMarkdownLaunch(
      "coder",
      { question: "work <&> 🐈", z: 2, a: 1 },
      source,
      {
        now: "2026-10-31T00:00:00Z",
        cwd: "/workspace/repo/attempt-1",
        lang: "English"
      }
    );
    expect(launch.prompt).toContain(source);
    expect(launch.prompt).toContain('"question":"work <&> 🐈"');
    expect(launch.prompt).toContain("/workspace/repo/attempt-1");
    expect(launch.prompt).toContain("code_result");
    expect(launch.prompt).toContain("never blindly retry");
    expect(launch.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    const reordered = await renderMarkdownLaunch(
      "coder",
      { a: 1, z: 2, question: "work <&> 🐈" },
      source,
      {
        now: "2026-10-31T00:00:00Z",
        cwd: "/workspace/repo/attempt-1",
        lang: "English"
      }
    );
    expect(reordered).toEqual(launch);
  });

  it("hashes substantive instructions and rejects invalid role/source/task inputs", async () => {
    const first = await renderMarkdownLaunch(
      "reporter",
      {},
      "Evaluate actual evidence."
    );
    const second = await renderMarkdownLaunch(
      "reporter",
      {},
      "Evaluate claims without evidence."
    );
    expect(first.promptDigest).not.toBe(second.promptDigest);
    expect(first.prompt).toContain("report_result");
    await expect(renderMarkdownLaunch("invalid", {}, "x")).rejects.toThrow(
      "specialist"
    );
    await expect(renderMarkdownLaunch("coder", {}, "")).rejects.toThrow(
      "empty"
    );
    await expect(
      renderMarkdownLaunch(
        "coder",
        [] as unknown as Record<string, unknown>,
        "x"
      )
    ).rejects.toThrow("object");
  });

  // These semantic checks belonged to the retired generator. They now guard
  // the canonical Markdown independently of optional skill loading.
  const rolePolicies = {
    primary: [
      "calling `done` once",
      "PLANNING & REASONING PROTOCOL",
      "Task Boundaries",
      "COMPREHENSIVE results",
      "CUSTOMER INTERACTION PROTOCOL"
    ],
    adviser: [
      "Finish by returning the advisory response as text in English",
      "OPERATIONAL MODES",
      "ADVISORY COMMUNICATION STYLE",
      "KNOWLEDGE DISCOVERY PROTOCOL",
      "DATA INTERPRETATION"
    ],
    coder: [
      "calling `code_result` once",
      "KNOWLEDGE MANAGEMENT",
      "HISTORICAL CONTEXT RETRIEVAL",
      "ANONYMIZE",
      "usage examples"
    ],
    maintenance: [
      "calling `maintenance_result` once",
      "SOFTWARE INSTALLATION PROTOCOL",
      "dependency",
      "COMPLETION REQUIREMENTS"
    ],
    memorist: [
      "calling `memorist_result` once",
      "precise",
      "HISTORICAL CONTEXT RETRIEVAL",
      "GOOD queries",
      "BAD queries"
    ],
    pentester: [
      "calling `hack_result` once",
      "KNOWLEDGE MANAGEMENT",
      "ANONYMIZE",
      "exploitation details",
      "HISTORICAL CONTEXT RETRIEVAL"
    ],
    searcher: [
      "calling `search_result` once",
      "CORE CAPABILITIES",
      "OPERATIONAL PROTOCOLS",
      "SEARCH RESULT DELIVERY"
    ],
    reporter: [
      "calling `report_result` once",
      "EVALUATION METHODOLOGY",
      "REPORT FORMULATION CRITERIA",
      "CRITICAL EVALUATION PRINCIPLES",
      "12000 characters"
    ]
  } satisfies Record<keyof typeof specialistSources, string[]>;
  it.each(Object.entries(rolePolicies))(
    "retains %s completion, language and methodology in its default",
    (role, requirements) => {
      const source = specialistSources[role as keyof typeof specialistSources];
      expect(source).toContain("## LANGUAGE POLICY");
      for (const requirement of requirements)
        expect(source).toContain(requirement);
    }
  );

  it.each(["tool-packs", "stock-kali"] as const)(
    "keeps default roles safe and uses the selected %s instructions",
    async (toolBackend) => {
      const packages = toolBackend === "tool-packs";
      const skill = await pinToolSkill(packages);
      expect(skill.content).toContain(
        packages
          ? "installed bounded profiles"
          : "one shared on-demand Cloudflare Kali Container"
      );
      for (const [role, source] of Object.entries(specialistSources)) {
        // These obligations must survive even when the model never loads the skill.
        expect(source).toContain(
          "respect engagement scope, guarded paths, cancellation and immutable result ownership"
        );
        expect(source).toContain(
          "reconcile unknown outcomes before any mutation retry"
        );
        expect(source).toContain(
          "Delegation returns a dispatch receipt, not a completed peer response"
        );
        expect(source).toContain("do not depend on loading a skill");
        expect(source).not.toMatch(/Kali|30-minute inactivity/);
        const launch = await renderLaunch(role, {}, source, {
          promptFormat: "markdown",
          toolBackend
        });
        expect(launch.prompt).toContain(source);
        expect(launch.prompt).toContain(
          packages ? "pentcloud_tool" : "existing private stock Kali MCP"
        );
        if (packages)
          expect(launch.prompt).not.toContain(
            "existing private stock Kali MCP"
          );
      }
    }
  );
});
