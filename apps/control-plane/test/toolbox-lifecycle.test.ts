import { expect, it, vi } from "vite-plus/test";
import {
  ToolboxGenerationLostError,
  ToolboxPendingError,
  touchToolbox,
  waitForToolbox
} from "../src/native/toolbox-lifecycle";

it("waits for actual RPC readiness and pins the first boot generation before paid setup", async () => {
  const calls: (string | undefined)[] = [];
  let paidSetup = false;
  const gateway = {
    ready: async (generation?: string) => {
      calls.push(generation);
      expect(paidSetup).toBe(false);
      return {
        state: calls.length < 3 ? ("booting" as const) : ("ready" as const),
        generation: "boot-one"
      };
    }
  };
  const generation = await waitForToolbox(gateway, undefined, {
    pollIntervalMs: 0
  });
  paidSetup = true;
  expect(generation).toBe("boot-one");
  expect(calls).toEqual([undefined, "boot-one", "boot-one"]);
});

it("does not retry an RPC generation loss or request permission to replace the pinned runtime", async () => {
  const calls: (string | undefined)[] = [];
  const gateway = {
    ready: async (generation?: string) => {
      calls.push(generation);
      return { error: "generation_lost" as const, generation: "boot-two" };
    }
  };
  await expect(
    waitForToolbox(gateway, "boot-one", { pollIntervalMs: 0 })
  ).rejects.toMatchObject({
    name: "ToolboxGenerationLostError",
    confirmedLost: true
  });
  expect(calls).toEqual(["boot-one"]);
});

it("leaves a cold startup or temporary RPC outage retriable through native scheduling", async () => {
  await expect(
    waitForToolbox(
      { ready: async () => ({ state: "booting", generation: "boot-one" }) },
      undefined,
      { startupWindowMs: 0 }
    )
  ).rejects.toBeInstanceOf(ToolboxPendingError);
  await expect(
    waitForToolbox(
      { ready: async () => ({ error: "unavailable" }) },
      undefined,
      { startupWindowMs: 0 }
    )
  ).rejects.toBeInstanceOf(ToolboxPendingError);
  await expect(
    waitForToolbox(
      {
        ready: async () => {
          throw new Error("transport unavailable");
        }
      },
      "boot-one",
      { startupWindowMs: 0 }
    )
  ).rejects.toBeInstanceOf(ToolboxPendingError);
});

it("touches only the exact generation through RPC and never calls readiness", async () => {
  const calls: string[] = [];
  const gateway = {
    activity: async (generation: string) => {
      calls.push(generation);
      return { state: "running" as const, generation: "boot-one" };
    }
  };
  await touchToolbox(gateway, "boot-one");
  expect(calls).toEqual(["boot-one"]);
});

it("refuses invalid generations before RPC, mismatched replies and lost activity without retry", async () => {
  let calls = 0;
  const unavailable = {
    ready: async () => {
      calls++;
      return { error: "unavailable" as const };
    }
  };
  await expect(
    waitForToolbox(unavailable, "", { startupWindowMs: 0 })
  ).rejects.toBeInstanceOf(ToolboxGenerationLostError);
  expect(calls).toBe(0);
  await expect(
    waitForToolbox(
      { ready: async () => ({ state: "ready", generation: "boot-two" }) },
      "boot-one"
    )
  ).rejects.toBeInstanceOf(ToolboxGenerationLostError);
  await expect(
    touchToolbox(
      {
        activity: async () => {
          calls++;
          return { error: "generation_lost" };
        }
      },
      "boot-one"
    )
  ).rejects.toMatchObject({
    name: "ToolboxGenerationLostError",
    confirmedLost: true
  });
  expect(calls).toBe(1);
});

it("bounds pending RPC readiness and permits cancellation without another readiness call", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const gateway = {
      ready: async () => {
        calls++;
        return new Promise<never>(() => {});
      }
    };
    const pending = expect(
      waitForToolbox(gateway, undefined, { startupWindowMs: 0 })
    ).rejects.toBeInstanceOf(ToolboxPendingError);
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(calls).toBe(1);
    const controller = new AbortController();
    const aborted = expect(
      waitForToolbox(gateway, "boot-one", { signal: controller.signal })
    ).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await aborted;
    expect(calls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
