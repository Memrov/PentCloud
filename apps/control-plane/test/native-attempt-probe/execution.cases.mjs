import { reset } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vite-plus/test";
import { probe } from "./runtime-fixture.mjs";

describe("native execution", () => {
  beforeAll(reset);
  afterAll(reset);

  const checks = {
    "computer-coder": (v) => {
      expect(v.write.content).toContain("bytesWritten");
      expect(v.read.content).toContain("native marker");
      expect(v.edit.content).toContain("editsApplied");
      expect(v.exec.content).toContain("edited marker");
      expect(v.deleted).toBeTruthy();
    },
    computer: (v) => {
      expect(v.read.content).toContain("accepted baseline");
      expect(v.exec.content).toContain("computer native marker");
      expect(v.exec.content).toContain('"exitCode":0');
      expect(v.javascript.content).toContain("42");
      expect(v.source.content).toContain("cannot change source");
      for (const key of ["escape", "git", "symlink", "captured"])
        expect(v[key].content).toContain("error");
      for (const error of Object.values(v.retired))
        expect(error).toContain("retired");
      expect(v).toMatchObject({
        drainedDuring: false,
        rejectedAfterCancel: true,
        drainedAfter: true,
        cwdBlocked: true,
        lateBlocked: true,
        baseline: "accepted baseline\n"
      });
    },
    shell: (v) => {
      expect(v.read).toMatchObject({
        exitCode: 0,
        stdout: "accepted baseline\n"
      });
      expect(v.git.exitCode).toBe(0);
      expect(v.blockGit.exitCode).not.toBe(0);
      expect(v.blockSource.exitCode).not.toBe(0);
      expect(v.baseline).toBe("accepted baseline\n");
      expect(v.evidence.exitCode).toBe(0);
      expect(v.evidence.stdout).toContain("native-shell");
      expect(v.unsupported.exitCode).toBe(127);
      expect(v.timeout).toBeTruthy();
      expect(v.drainedAfterTimeout).toBeTruthy();
      expect(v.outputWindow.exitCode).toBe(0);
      expect(v.outputWindow.stdout).toContain("2500");
      expect(v.outputWindow.stdout).not.toContain("\n1\n");
      expect(v.curl.exitCode).toBe(0);
      expect(
        JSON.parse(
          v.curl.stdout
            .replaceAll("\r\n", "\n")
            .split("\n\n")
            .slice(1)
            .join("\n\n")
        )
      ).toEqual({
        method: "POST",
        header: "native",
        body: "curl fixture body"
      });
      expect(v.curlFile).toBe(v.curl.stdout);
      expect(v.curlFile).toContain("207");
      expect(v.curlFile.toLowerCase()).toContain("application/json");
    },
    javascript: (v) => {
      expect(v.scratch).toMatchObject({
        exitCode: 0,
        stdout: "isolated scratch\n"
      });
      expect(v.memory.exitCode).toBe(0);
      for (const key of [
        "blockEscape",
        "fileWrite",
        "fileRead",
        "invalidArguments"
      ])
        expect(v[key].exitCode).not.toBe(0);
    },
    publish: published,
    replay: (v) => {
      published(v);
      expect(v.replayedHead).toBe(v.head);
      expect(v.replayed.outputCommit).toBe(v.head);
    },
    cancel: (v) => {
      expect(v.lateRejected).toBeTruthy();
      expect(v.published).toEqual([]);
      expect(v.state.result).toMatchObject({
        status: "interrupted",
        runtime: { terminal: { id: "probe-terminal" } }
      });
    },
    drain: (v) => {
      expect(v.before.drained).toBe(false);
      expect(v.lateRejected).toBeTruthy();
      expect(v.after).toMatchObject({ drained: true, state: "cancelled" });
      expect(v.published).toEqual([]);
    },
    "known-running": (v) => {
      expect(v).toMatchObject({
        newCallFenced: true,
        starts: 1,
        before: { drained: false, unresolvedRemote: 1 },
        after: { drained: true, unresolvedRemote: 0 }
      });
    },
    "mcp-schema": (v) => {
      expect(v.initialized).toBeTruthy();
      expect(v.result.structuredContent.ok).toBeTruthy();
    },
    memory: (v) => {
      expect(
        v.committedFiles.some((p) => p.startsWith(".pentagi/memory/code/"))
      ).toBe(true);
      expect(v.found.matches.length).toBeGreaterThan(0);
      expect(
        v.found.matches.some((m) => m.text.includes("native-memory-marker"))
      ).toBe(true);
    },
    "research-policy": (v) => {
      expect(v.scopeRejected).toBeTruthy();
      expect(v.mutationRejected).toBeTruthy();
      expect(v.enabledTools).toContain("web_search");
    },
    "metasploit-owned": (v) => {
      expect(v).toMatchObject({
        newCallFenced: true,
        unownedRejected: true,
        launches: 1,
        stops: 2,
        before: { drained: false },
        afterJob: { drained: false },
        stop: { verified: true, settled: false },
        terminate: { verified: true, settled: true },
        after: { drained: true }
      });
      expect(v.stopDuplicate).toEqual(v.stop);
      for (let i = 0; i < v.inspectOrder.length; i += 2)
        expect(v.inspectOrder.slice(i, i + 2)).toEqual(["jobs", "sessions"]);
    },
    "metasploit-unknown": (v) => {
      expect(v).toMatchObject({
        newCallFenced: true,
        unownedRejected: true,
        unknownControlRejected: true,
        after: { drained: false },
        launches: 1,
        stops: 0
      });
    },
    "metasploit-control-race": (v) => {
      race(v);
      expect(v.requestOutcome).toMatch(/^403:/);
    },
    "metasploit-inspect-race": (v) => {
      race(v);
      expect(v.requestOutcome).toBe("fulfilled");
    },
    "metasploit-stale-inventory": (v) => {
      expect(v.afterStale[0]).toMatchObject({
        owned: { needsSessionInspection: true },
        state: "running"
      });
      expect(v.after.drained).toBe(false);
      expect(v.terminate).toMatchObject({ verified: true, settled: true });
    },
    "session-stateless": (v) => {
      expect(v).toMatchObject({ initializes: 2, deletes: 0 });
      expect(v.saved).toBeFalsy();
    },
    "session-cleanup-failure": (v) => {
      expect(v).toMatchObject({
        savedBeforeMutation: true,
        initializes: 1,
        deletesBefore: 0,
        before: { drained: false, sessionCleanupPending: true },
        after: { drained: true },
        deletes: 1
      });
      for (const item of v.refused) {
        expect(item.saved).toBeTruthy();
        expect(item.execution.drained).toBe(false);
      }
      expect(v.savedAfter).toBeFalsy();
    }
  };
  function published(v) {
    expect(v.main).toBe(v.base);
    expect(v.head).not.toBe(v.base);
    expect(v.terminal.outputCommit).toBe(v.head);
    for (const push of v.published)
      expect(push).toEqual({
        ref: "attempts/local-attempt",
        remoteRef: "attempts/local-attempt"
      });
    expect(v.result).toMatchObject({
      input_commit: v.base,
      role: "primary"
    });
    expect(v.result.runtime_provenance).toEqual({
      initialized: { id: "probe-initialized", tag: "fixture" },
      terminal: { id: "probe-terminal", tag: "fixture" }
    });
    expect(v.terminal.runtime).toEqual(v.result.runtime_provenance);
  }
  function race(v) {
    expect(v).toMatchObject({
      during: { drained: false },
      closesDuring: 0,
      after: { drained: true },
      closes: 1,
      opensAfterClose: 0,
      stops: 0,
      retiredControlRejected: true,
      retiredInspectionRejected: true
    });
  }
  // Seven concurrent DOs preserve the original cross-object Git/SQLite isolation check.
  it.concurrent.each(Object.entries(checks))(
    "native execution: %s",
    async (kind, assertCase) => assertCase(await probe(kind))
  );

  it("runs package tools without warming Kali", async () => {
    const v = await probe("package-only");
    expect(v.tools).toContain("pentcloud_tool");
    expect(v.tools.some((n) => n.startsWith("pentcloud_kali_"))).toBe(false);
    expect(v).toMatchObject({
      runs: 1,
      stops: 1,
      readies: 0,
      initializes: 0,
      execution: { drained: true, sessionCleanupPending: false },
      shell: { exitCode: 0, stdout: "owned\n" }
    });
    expect(v.prompt).toContain("bounded profiles");
    expect(v.skill).toContain("pentcloud_tool");
    expect(v.skill).toContain("Kali tools are unavailable");
  });
  it("retains memory schemas and scopes without model or scanner calls", async () => {
    const v = await probe("memory-contract");
    expect(
      v.sameAttempt.matches.some((m) => m.text === "same-attempt-needle")
    ).toBe(true);
    expect(v.wrongLanguage.matches).toEqual([]);
    expect(v.wrongAnswerType.matches).toEqual([]);
    for (const [result, key] of [
      ["guides", "install"],
      ["answers", "answer"],
      ["scoped", "scoped"],
      ["argumentScoped", "argumentScoped"]
    ])
      expect(new Set(v[result].matches.map((m) => m.path))).toEqual(
        new Set([v.paths[key].path])
      );
    expect(v.mappedButNoMatch.matches).toEqual([]);
    expect(v.unmapped).toContain("Cannot map");
    expect(v.unmappedSubtask).toContain("Cannot map");
    expect(new Set(v.legacy.matches.map((m) => m.path))).toEqual(
      new Set([".pentagi/memory/code/legacy.md"])
    );
    expect(v.noModel).toBe(0);
    expect(v.noScanner).toBe(0);
  });
  it.each([
    "native-discovery",
    "native-discovery-failed",
    "native-discovery-empty",
    "native-discovery-legacy"
  ])("discovery without a model: %s", async (kind) => {
    const v = await probe(kind);
    expect(v.modelRequests).toBe(0);
    expect(v.modelKeyConfigured).toBeFalsy();
    expect(v.result.model).toBeNull();
    expect(v.record.model).toBeNull();
    expect(v.record.execution_kind).toBe("discovery");
    expect(v.result.status).toBe(
      kind.endsWith("failed") || kind.endsWith("empty") ? "failed" : "completed"
    );
    expect(v.scannerArguments).toEqual({
      target: "http://127.0.0.1/",
      aggression: kind.endsWith("legacy") ? "polite" : "stealthy",
      timeout: 60
    });
    if (kind.endsWith("empty"))
      expect(v.result.arguments.scanStatus).toBe("no-http-response");
  });
  it("validates finding references before proposal admission", async () => {
    const v = await probe("finding-contract");
    expect(v.proposalAfterMissing).toBe(false);
    expect(v.version).toBe(1);
    expect(v.modelRequests).toBe(0);
    expect(v.outputCommit).toHaveLength(40);
  });
});
