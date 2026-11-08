/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ProbeAttempt, ProbeModelTest } from "./worker";

// Outbound requests to this origin reach the probe's fake services.
const ORIGIN = "http://attempt-probe.invalid";
const bindings = env as unknown as {
  ATTEMPTS: DurableObjectNamespace<ProbeAttempt>;
  MODEL_TESTS: DurableObjectNamespace<ProbeModelTest>;
};

/** Run one probe scenario in a fresh Attempt, as the harness route does. */
async function probe<T>(kind: string): Promise<T> {
  const attempt = bindings.ATTEMPTS.getByName(`${kind}-${crypto.randomUUID()}`);
  return (await attempt.probe(kind, ORIGIN)) as T;
}

describe("native tool packs and prompts", () => {
  it("offers bounded tool packs without Kali tools", async () => {
    const packages = await probe<{
      tools: string[];
      runs: number;
      stops: number;
      readies: number;
      initializes: number;
      execution: { drained: boolean; sessionCleanupPending: boolean };
      prompt: string;
      skill: string;
      shell: { exitCode: number; stdout: string };
    }>("package-only");
    expect(packages.tools).toContain("pentcloud_tool");
    expect(
      packages.tools.some((name) => name.startsWith("pentcloud_kali_"))
    ).toBe(false);
    expect([packages.runs, packages.stops]).toEqual([1, 1]);
    expect([packages.readies, packages.initializes]).toEqual([0, 0]);
    expect(packages.execution.drained).toBe(true);
    expect(packages.execution.sessionCleanupPending).toBe(false);
    expect(packages.prompt).toContain("bounded profiles");
    expect(packages.skill).toContain("pentcloud_tool");
    expect(packages.skill).toContain("Kali tools are unavailable");
    expect(packages.shell).toMatchObject({ exitCode: 0, stdout: "owned\n" });
  });

  it("rejects retired prompt templates without calling a model", async () => {
    const compatibility = await probe<{
      results: Array<{
        saved: unknown;
        replayed: unknown;
        error: string;
        created: boolean;
      }>;
      modelRequests: number;
    }>("prompt-compatibility");
    for (const result of compatibility.results) {
      expect(result.saved).toEqual(result.replayed);
      expect(result.error).toContain("template execution is retired");
      expect(result.error).toContain("Markdown");
      expect(result.created).toBeFalsy();
    }
    expect(compatibility.modelRequests).toBe(0);
  });
});

describe("native model connection", () => {
  it("tests a model with native, authenticated requests and keeps no state", async () => {
    const result = await bindings.MODEL_TESTS.getByName(
      crypto.randomUUID()
    ).check(ORIGIN);
    expect(result).toMatchObject({
      requests: [
        {
          native: true,
          authenticated: true,
          model: "fixture-console",
          tools: 0
        }
      ],
      empty: true
    });
  });

  it("runs an attempt on its pinned model", async () => {
    const pinned = await probe<{ model: string; modelRequests: number }>(
      "native-pinned-model"
    );
    expect(pinned.model).toBe("opencode:fixture-console");
    expect(pinned.modelRequests).toBe(1);
  });
});
