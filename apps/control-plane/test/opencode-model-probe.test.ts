import { afterEach, expect, it, vi } from "vitest";
// No paid model/network requests: emulate only the embedded SDK boundary.
const calls = vi.hoisted(() => ({
  options: undefined as any,
  prompt: undefined as any,
  closed: false,
  reject: false,
  signals: [] as AbortSignal[]
}));
vi.mock("@opencode/ai", () => ({
  make: () => {
    throw new Error("Legacy provider path bypasses the embedded SDK");
  }
}));
vi.mock("@opencode/sdk/workerd", () => ({
  OpenCodeWorkerd: {
    create: async (options: unknown) => {
      calls.options = options;
      return {
        sessions: {
          create: async (_input: unknown, options: { signal: AbortSignal }) => {
            calls.signals.push(options.signal);
            return { id: "ses_connection" };
          },
          generate: async (
            input: unknown,
            options: { signal: AbortSignal }
          ) => {
            calls.prompt = input;
            calls.signals.push(options.signal);
            if (calls.reject) throw new Error("Provider rejected test");
            return { text: "OK" };
          }
        },
        close: async () => {
          calls.closed = true;
        }
      };
    }
  }
}));
import { probeOpenCode } from "../src/native/opencode-models";
afterEach(() => {
  calls.closed = false;
  calls.reject = false;
  calls.signals = [];
});
const model = {
  id: "opencode-go:test",
  modelId: "test",
  provider: "opencode-go",
  route: "go" as const,
  name: "Test",
  adapter: "chat-completions" as const,
  package: "@opencode/ai/providers/openai-compatible",
  baseURL: "https://opencode.ai/inference/go/openai/v1",
  contextLength: 128000,
  outputLimit: 8192,
  compatibility: { reasoning_field: "reasoning_content" },
  reasoningEfforts: ["default" as const],
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: []
};
it("validates a connection through the embedded OpenCode session with the pinned protocol", async () => {
  await probeOpenCode(model, "fake-key", {} as DurableObjectStorage);
  expect(calls.options.models).toEqual({ fetch: false, snapshot: false });
  expect(
    calls.options.config.providers["opencode-go"].models.test.compatibility
  ).toMatchObject({ reasoningField: "reasoning_content" });
  expect(calls.prompt.sessionID).toBe("ses_connection");
  expect(calls.closed).toBe(true);
});

it("propagates one cancellation scope and closes the host after a rejected model request", async () => {
  calls.reject = true;
  await expect(
    probeOpenCode(model, "fake-key", {} as DurableObjectStorage)
  ).rejects.toThrow(/Provider rejected/);
  expect(calls.signals).toHaveLength(2);
  expect(calls.signals[0]).toBeInstanceOf(AbortSignal);
  expect(calls.signals[1]).toBe(calls.signals[0]);
  expect(calls.closed).toBe(true);
});
