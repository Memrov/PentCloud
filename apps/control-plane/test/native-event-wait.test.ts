import { describe, expect, it } from "vitest";
import type {
  OpenCodeOperationResult,
  OpenCodeSession,
  OpenCodeSessionEvent
} from "agents/harness/opencode";
import { submitAndWaitForOperation } from "../src/native/native-event-wait";

const operationId = "operation-one";
const receipt = { operationId, session: "ses_fixture", accepted: true };
const terminal: OpenCodeOperationResult = {
  operationId,
  session: "ses_fixture",
  status: "done",
  text: "durable answer"
};
function fixture(
  wait: (signal?: AbortSignal) => Promise<OpenCodeOperationResult> = async () =>
    terminal
) {
  let listener: (events: readonly OpenCodeSessionEvent[]) => void = () => {};
  const order: string[] = [];
  const session = {
    async events() {
      order.push("subscribed");
      return {
        start(next: typeof listener) {
          order.push("started");
          listener = next;
        },
        async stop() {
          order.push("stopped");
        }
      };
    },
    async wait(id: string, signal?: AbortSignal) {
      expect(id).toBe(operationId);
      order.push("native wait");
      return wait(signal);
    }
  } as unknown as OpenCodeSession;
  return {
    session,
    order,
    emit: (event: OpenCodeSessionEvent) => listener([event])
  };
}

describe("native operation completion", () => {
  it("subscribes before durable admission and returns the authoritative native result", async () => {
    const f = fixture();
    const result = await submitAndWaitForOperation(
      f.session,
      operationId,
      async () => {
        f.order.push("submitted");
        f.emit({
          type: "operation_end",
          result: { ...terminal, text: "projected answer" }
        });
        return receipt;
      },
      new AbortController().signal
    );
    expect(result).toEqual(terminal);
    expect(f.order).toEqual([
      "subscribed",
      "started",
      "submitted",
      "native wait",
      "stopped"
    ]);
  });

  it("ignores another operation ending and waits for the selected operation", async () => {
    const f = fixture();
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const work = submitAndWaitForOperation(
      f.session,
      operationId,
      async () => {
        f.emit({
          type: "operation_end",
          result: { ...terminal, operationId: "other-operation" }
        });
        admitted();
        return receipt;
      },
      new AbortController().signal
    );
    await admission;
    await Promise.resolve();
    expect(f.order).not.toContain("native wait");
    f.emit({ type: "operation_end", result: terminal });
    await expect(work).resolves.toEqual(terminal);
    expect(f.order.at(-1)).toBe("stopped");
  });

  it("reads a duplicate operation without waiting for an event that was already emitted", async () => {
    const f = fixture();
    await expect(
      submitAndWaitForOperation(
        f.session,
        operationId,
        async () => ({ ...receipt, accepted: false }),
        new AbortController().signal
      )
    ).resolves.toEqual(terminal);
    expect(f.order.at(-1)).toBe("stopped");
  });

  it("checks the native result when admitted queued work is withdrawn", async () => {
    const cancelled: OpenCodeOperationResult = {
      operationId,
      session: "ses_fixture",
      status: "unanswered",
      reason: "not_found"
    };
    const f = fixture(async () => cancelled);
    await expect(
      submitAndWaitForOperation(
        f.session,
        operationId,
        async () => {
          f.emit({ type: "operation_withdrawn", operationId });
          return receipt;
        },
        new AbortController().signal
      )
    ).resolves.toEqual(cancelled);
    expect(f.order.at(-1)).toBe("stopped");
  });

  it("uses native waiting if the event subscription fails", async () => {
    const f = fixture();
    await expect(
      submitAndWaitForOperation(
        f.session,
        operationId,
        async () => {
          f.emit({
            type: "fault",
            code: "events_failed",
            message: "subscription closed"
          });
          return receipt;
        },
        new AbortController().signal
      )
    ).resolves.toEqual(terminal);
    expect(f.order.at(-1)).toBe("stopped");
  });

  it("releases the event stream when starting delivery fails", async () => {
    const f = fixture();
    const events = f.session.events.bind(f.session);
    f.session.events = async () => {
      const stream = await events();
      stream.start = () => {
        throw new Error("stream start failed");
      };
      return stream;
    };
    await expect(
      submitAndWaitForOperation(
        f.session,
        operationId,
        async () => receipt,
        new AbortController().signal
      )
    ).rejects.toThrow("stream start failed");
    expect(f.order).toEqual(["subscribed", "stopped"]);
  });

  it("does not admit new work if cancellation arrives while the subscription opens", async () => {
    const f = fixture();
    const stream = await f.session.events();
    let opened!: (value: typeof stream) => void;
    f.session.events = () =>
      new Promise((resolve) => {
        opened = resolve;
      });
    const abort = new AbortController();
    let submitted = false;
    const work = submitAndWaitForOperation(
      f.session,
      operationId,
      async () => {
        submitted = true;
        return receipt;
      },
      abort.signal
    );
    const checked = expect(work).rejects.toBe("cancelled before admission");
    abort.abort("cancelled before admission");
    opened(stream);
    await checked;
    expect(submitted).toBe(false);
    expect(f.order.at(-1)).toBe("stopped");
  });

  it("releases the event stream when submission fails", async () => {
    const f = fixture();
    await expect(
      submitAndWaitForOperation(
        f.session,
        operationId,
        async () => {
          throw new Error("admission fenced");
        },
        new AbortController().signal
      )
    ).rejects.toThrow("admission fenced");
    expect(f.order).toEqual(["subscribed", "started", "stopped"]);
  });

  it("aborts a new operation wait and releases its subscription", async () => {
    const f = fixture();
    const abort = new AbortController();
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const work = submitAndWaitForOperation(
      f.session,
      operationId,
      async () => {
        admitted();
        return receipt;
      },
      abort.signal
    );
    const checked = expect(work).rejects.toBe("cancelled attempt");
    await admission;
    abort.abort("cancelled attempt");
    await checked;
    expect(f.order).not.toContain("native wait");
    expect(f.order.at(-1)).toBe("stopped");
  });

  it("aborts native duplicate waiting without an unhandled event-wait rejection", async () => {
    const abort = new AbortController();
    let waiting!: () => void;
    const nativeWait = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const f = fixture(
      (signal) =>
        new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true
          });
          waiting();
        })
    );
    const work = submitAndWaitForOperation(
      f.session,
      operationId,
      async () => ({ ...receipt, accepted: false }),
      abort.signal
    );
    const checked = expect(work).rejects.toBe("cancelled duplicate");
    await nativeWait;
    abort.abort("cancelled duplicate");
    await checked;
    expect(f.order.at(-1)).toBe("stopped");
  });
});
