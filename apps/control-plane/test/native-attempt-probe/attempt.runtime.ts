/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ProbeAttempt, ProbeModelTest } from "./worker";

const bindings = env as unknown as {
  ATTEMPTS: DurableObjectNamespace<ProbeAttempt>;
  MODEL_TESTS: DurableObjectNamespace<ProbeModelTest>;
};
const origin = "http://attempt-fixture.invalid";
const attempt = () => bindings.ATTEMPTS.getByName(crypto.randomUUID());

describe("native attempt runtime", () => {
  it("redacts target headers from shell, API and retrieval results", async () => {
    const result = JSON.stringify(
      await attempt().probe("header-redaction", origin)
    );
    expect(result).not.toContain("private-header-marker");
    expect(result.toUpperCase()).toContain("[REDACTED]");
  });

  it("replays saved legacy prompts and rejects new template execution", async () => {
    const result = (await attempt().probe("prompt-compatibility", origin)) as {
      results: Array<{
        saved: unknown;
        replayed: unknown;
        error: string;
        created: boolean;
      }>;
      modelRequests: number;
    };
    expect(result.results).toHaveLength(2);
    for (const entry of result.results) {
      expect(entry.replayed).toEqual(entry.saved);
      expect(entry.error).toContain("template execution is retired");
      expect(entry.error).toContain("Markdown");
      expect(entry.created).toBe(false);
    }
    expect(result.modelRequests).toBe(0);
  });

  it("tests the authenticated native model connection and clears its storage", async () => {
    const result = await bindings.MODEL_TESTS.getByName(
      crypto.randomUUID()
    ).check(origin);
    expect(result).not.toHaveProperty("error");
    expect(result.requests).toEqual([
      { native: true, authenticated: true, model: "fixture-console", tools: 0 }
    ]);
    expect(result).toHaveProperty("empty", true);
  });

  it("completes native attempt execution with the pinned model", async () => {
    const result = await attempt().probe("native-pinned-model", origin);
    expect(result).toMatchObject({
      model: "opencode:fixture-console",
      modelRequests: 1,
      request: { model: "fixture-console", authenticated: true },
      result: {
        status: "completed",
        model: "opencode:fixture-console",
        arguments: { result: "OK" }
      }
    });
    expect(result).not.toHaveProperty("result.error");
  });
});
