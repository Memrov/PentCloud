import { digest } from "./domain";
import type { APIRequest } from "./api-access";
interface Receipt {
  name: string;
  state: string;
  fingerprint: string;
  startedAt?: number;
  arguments?: Record<string, unknown>;
  result?: unknown;
}
/** The exact operation is reserved inside the transaction before any HTTP send. */
export async function journalAPIRequest(
  storage: DurableObjectStorage,
  key: string,
  input: APIRequest,
  send: () => Promise<unknown>
): Promise<unknown> {
  const fingerprint = await digest(input),
    mutating = !["GET", "HEAD"].includes(input.method);
  const reservation = await storage.transaction(async (tx) => {
    const attempt = await tx.get<{ result?: unknown; proposal?: unknown }>(
      "attempt"
    );
    if (attempt?.result || attempt?.proposal || (await tx.get("cancelled")))
      throw new Error("409: Attempt stopped");
    const current = await tx.get<Receipt>(key);
    if (current) {
      if (current.fingerprint !== fingerprint)
        throw new Error("409: API operation identity changed");
      if (["completed", "reconciled"].includes(current.state))
        return { dispatch: false as const, result: current.result };
      if (mutating)
        throw new Error(
          "409: API mutation is already started or its outcome is unknown; reconcile before continuing"
        );
    }
    const calls = await tx.list<Receipt>({ prefix: "remote:" });
    if (
      [...calls].some(
        ([k, r]) =>
          k !== key && ["started", "unknown", "running"].includes(r.state)
      )
    )
      throw new Error("409: Another remote operation is unresolved");
    await tx.put(key, {
      name: "pentcloud_api_request",
      state: "started",
      fingerprint,
      startedAt: Date.now(),
      arguments: { method: input.method, url: input.path }
    } satisfies Receipt);
    return { dispatch: true as const };
  });
  if (!reservation.dispatch) return reservation.result;
  try {
    const result = await send(),
      receipt = (await storage.get<Receipt>(key))!;
    await storage.put(key, { ...receipt, state: "completed", result });
    return result;
  } catch {
    const receipt = await storage.get<Receipt>(key);
    if (receipt?.state !== "completed")
      await storage.put(key, {
        ...receipt!,
        state: mutating ? "unknown" : "completed",
        result: {
          error: mutating
            ? "API mutation outcome unknown"
            : "API request failed"
        }
      });
    throw new Error(
      mutating
        ? "409: API mutation outcome is unknown; do not automatically retry"
        : "503: API request failed"
    );
  }
}
