import type {
  OpenCodeOperationResult,
  OpenCodeReceipt,
  OpenCodeSession
} from "agents/harness/opencode";

/** Observe admission before it can finish; native wait owns the operation result, not session drain. */
export async function submitAndWaitForOperation(
  session: OpenCodeSession,
  operationId: string,
  submit: () => Promise<OpenCodeReceipt>,
  signal: AbortSignal
): Promise<OpenCodeOperationResult> {
  signal.throwIfAborted();
  const stream = await session.events();
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const ended = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void ended.catch(() => undefined); // A duplicate admission uses native wait directly.
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    stream.start((events) => {
      for (const event of events) {
        if (
          event.type === "fault" ||
          (event.type === "operation_end" &&
            event.result.operationId === operationId) ||
          (event.type === "operation_withdrawn" &&
            event.operationId === operationId)
        )
          resolve();
      }
    });
    signal.throwIfAborted();
    const receipt = await submit();
    if (receipt.accepted) await ended;
    return await session.wait(operationId, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    await stream.stop();
  }
}
