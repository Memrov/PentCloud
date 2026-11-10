import { reset } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vite-plus/test";
import contracts from "../../../../contracts/pentagi-tools.json";
import { probe, roles, nativeNames } from "./runtime-fixture.mjs";

describe("native sessions", () => {
  beforeAll(reset);
  afterAll(reset);
  it.each(roles)("scopes the Codex bridge for %s", async (role) => {
    const result = await probe(`codex-role-${role}`);
    for (const name of nativeNames) expect(result.names).toContain(name);
    expect(result.read.content).toContain("accepted baseline");
    expect(result.crossRoleDenied).toBe(true);
    expect(result.lateCallDenied).toBe(true);
    const resultTool = {
      primary: "done",
      coder: "code_result",
      maintenance: "maintenance_result",
      memorist: "memorist_result",
      pentester: "hack_result",
      searcher: "search_result",
      reporter: "report_result"
    }[role];
    if (resultTool) expect(result.names).toContain(resultTool);
    expect(result.names.includes("pentcloud_tool")).toBe(
      ["coder", "maintenance", "pentester"].includes(role)
    );
  });
  it("streams partial results, redacts secrets and retains terminal snapshots", async () => {
    const v = await probe("sdk-live-transport");
    expect(v).toMatchObject({
      partialBeforeEnd: true,
      evidenceRetained: true,
      stops: 1,
      remainingStreams: 0,
      modelRequests: 0,
      kaliReadies: 0,
      secretLeak: false,
      completedSnapshotRetained: true,
      quotedSecretLeak: false,
      overlapDuplicated: false,
      permittedSummary: true
    });
  });
  it("reads cold terminal history without credentials or restarting work", async () => {
    const v = await probe("sdk-terminal-cold");
    expect(v.before).toBeGreaterThan(0);
    expect(v.after).toBe(v.before);
    expect(v.events).toContain("event: end\n");
    expect(v.events).toContain("Retained terminal conversation");
    expect(v).toMatchObject({
      credentialReads: 0,
      modelRequests: 0,
      kaliReadies: 0,
      canReply: false,
      steerDenied: true,
      activeWorkDenied: true,
      crossRunWorkDenied: true
    });
    expect(v.recorded).toMatchObject({
      messages: v.before,
      historyAvailable: true,
      remote: "unknown"
    });
    expect(v.recorded.pages).toBeGreaterThanOrEqual(4);
    expect(v.recorded.outputLength).toBeGreaterThan(100000);
  });
  it.each([
    "preparation-chat",
    "preparation-stop",
    "preparation-chat?failure=clone",
    "preparation-chat?failure=reload"
  ])("promotes or stops the actual prepared conversation: %s", async (kind) => {
    const v = await probe(kind);
    expect(new Set(v.before.tools.names)).toEqual(
      new Set([
        "computer_read",
        "computer_read_bytes",
        "computer_ls",
        "computer_find",
        "computer_grep",
        "pentcloud_progress",
        "question"
      ])
    );
    expect(v.before).toMatchObject({ users: 1, readies: 0 });
    expect(v.writeDenied).toBeTruthy();
    expect(v.resultDenied).toBeTruthy();
    if (kind.startsWith("preparation-chat")) {
      expect(v.after).toMatchObject({
        session: v.before.session,
        users: 2,
        source: v.expected,
        retained: true,
        discoveryDelivered: true
      });
      expect(v.formAnswered).toBeTruthy();
      expect(v.changedReplayDenied).toBeTruthy();
      expect(v.after.tools.names).toContain("done");
      expect(v.read.content).toContain("accepted baseline");
      if (kind.includes("?failure=")) {
        expect(v.firstFailure).toBeTruthy();
        expect(v.pendingAfterFailure).toBeTruthy();
      }
    } else {
      expect(v.steerDenied).toBeTruthy();
      expect(v.readiness.drained).toBeTruthy();
    }
  });
  it("opens browser live views without starting work or storing credentials", async () => {
    const v = await probe("browser-live-view");
    expect(v.absent).toEqual({ available: false });
    for (const key of [
      "absentNoWrites",
      "created",
      "activeNoWrites",
      "cancelled",
      "cancellationRace",
      "credentialsNotStored",
      "lifecycleNotStarted"
    ])
      expect(v[key]).toBeTruthy();
    expect(v.browserReads).toBe(2);
    expect(v.providerCalls).toBe(2);
    expect(v.options).toEqual({
      mode: "tab",
      targetId: "existing-page",
      expiresInMs: 60000,
      guardrails: { mode: "readonly" }
    });
  });
  it.each(["sdk-managed-specialist", "sdk-managed-specialist-primary"])(
    "uses the pinned managed specialist profile: %s",
    async (kind) => {
      const v = await probe(kind);
      const primary = kind.endsWith("-primary");
      expect(v.profile.id).toBe(
        primary ? "pentcloud-primary" : "pentcloud-coder"
      );
      expect(v.skillLoaded).toBeTruthy();
      expect(v.providerTools.names).toContain("skill");
      if (primary) expect(v.providerTools.names).toContain("question");
      else {
        expect(v.skills.some((s) => s.id === "pentcloud-tools")).toBe(true);
        expect(v.providerTools.names).not.toContain("question");
      }
    }
  );
  it("validates form identity, answer state and native permissions", async () => {
    const v = await probe("sdk-managed-session");
    for (const key of [
      "wrongSessionRejected",
      "invalidAnswerRejected",
      "duplicateRejected",
      "lateRejected",
      "permissionDuplicateRejected"
    ])
      expect(v[key]).toBeTruthy();
    expect(v.answered.state).toEqual({
      status: "answered",
      answer: { continue: true }
    });
    expect(v.cancelled.state).toEqual({
      status: "cancelled",
      message: "Operator declined"
    });
    expect(v.fenced.state.status).toBe("pending");
    expect(v.pending.canReply).toBeTruthy();
    expect(v.pending.forms).toHaveLength(1);
    expect(v.pending.usage.stats.steps).toBe(0);
    expect(v.pending.usage.limits).toBeNull();
    expect(v.nativePermissionList).toEqual([]);
    expect(v.permission.effect).toBe("ask");
    expect(v.permissionPending.permissions[0].id).toBe("per_managed_probe");
  });
  const browserSchema = contracts.tools.find(
    (tool) => tool.name === "browser"
  ).input_schema;
  it.each([
    "sdk-startup",
    "sdk-searcher-tools",
    "sdk-memorist-tools",
    "sdk-pentester-tools",
    ...roles.map((r) => `sdk-role-${r}`)
  ])("exposes the exact native provider boundary: %s", async (kind) => {
    const v = await probe(kind);
    expect(v.terminalEvents).toContain("event: end\n");
    if (kind.startsWith("sdk-role-")) {
      const role = kind.slice(9),
        kali = ["coder", "maintenance", "pentester"].includes(role);
      expect(Boolean(v.toolboxReadies)).toBe(kali);
      const frame = v.terminalEvents.split("\n\n")[0];
      const snapshot = JSON.parse(
        frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6)
      );
      expect(snapshot.result.status).toBe("interrupted");
      const names = v.providerTools.names;
      for (const name of ["file", "terminal", "workspace_javascript"])
        expect(names).not.toContain(name);
      for (const name of nativeNames) expect(names).toContain(name);
      for (const name of [
        "pentcloud_kali_import",
        "pentcloud_kali_files",
        "pentcloud_kali_export"
      ])
        expect(names.includes(name)).toBe(kali);
      expect(names.includes("execute")).toBe(kali);
    } else if (kind === "sdk-startup") {
      expect(v.storedModelSecret).toBeFalsy();
      expect(v.startup.stage).toBe("model.request.ready");
      expect(v.startup.promptCharacters).toBeGreaterThan(1000);
      expect(v.messages).toBe(2);
      expect(v.answer).toMatchObject({
        status: "unanswered",
        reason: "failed"
      });
    } else if (kind === "sdk-searcher-tools") {
      expect(new Set(v.providerTools.names)).toEqual(
        new Set([
          ...nativeNames,
          "browser",
          "memorist",
          "search_answer",
          "search_result",
          "store_answer",
          "web_search"
        ])
      );
      expect(v.providerTools.browser).toEqual(browserSchema);
    } else if (kind === "sdk-memorist-tools") {
      expect(v.providerTools.browser).toBeNull();
      expect(v.providerTools.names).not.toContain("browser");
      expect(v.providerTools.names).not.toContain("web_search");
    } else {
      expect(v.providerTools.browser).toEqual(browserSchema);
      expect(v.providerTools.names).toContain("execute");
      expect(v.providerTools.names).not.toContain("webfetch");
      expect(
        v.providerTools.names.some(
          (n) => n.startsWith("browser.") || n.startsWith("browser_")
        )
      ).toBe(false);
    }
  });
});
