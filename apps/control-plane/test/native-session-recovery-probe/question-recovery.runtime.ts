/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QuestionRecovery } from "./worker";

const attempts = (
  env as unknown as { ATTEMPTS: DurableObjectNamespace<QuestionRecovery> }
).ATTEMPTS;

/** Leave a question pending, crash the object, then resume the turn. */
async function crashWhileAsking(mode: "continue" | "reask") {
  const before = await attempts.getByName(mode).start(mode);
  expect(before.customAnswerAllowed).toBe(true);
  // A hard crash, like ctx.abort(): in-memory state goes, storage stays.
  await abortAllDurableObjects();
  const after = await attempts.getByName(mode).afterCrash();
  // A form lost in the crash must not accept a late reply.
  expect(after.staleRejected).toBe(true);
  expect(after.pendingForms).toBe(0);
  expect(after.status).toBe("done");
  expect(after.history).toMatch(/Tool execution interrupted: question/);
  return { before, after };
}

describe("a pending question across a crash", () => {
  it("fails the question, and the model continues without an answer", async () => {
    const { after } = await crashWhileAsking("continue");
    expect(after.replacementFormID).toBeUndefined();
    expect(after.text).toMatch(/continues without an answer/);
  });

  it("accepts an answer when the model asks a replacement question", async () => {
    const { before, after } = await crashWhileAsking("reask");
    expect(after.replacementFormID).toBeDefined();
    expect(after.replacementFormID).not.toBe(before.formID);
    expect(after.text).toMatch(/Recovered answer: Focused/);
  });
});
