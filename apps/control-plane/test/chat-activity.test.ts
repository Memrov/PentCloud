import { expect, it } from "vitest";
import {
  chatActivity,
  isPublicationFence,
  toolLabel
} from "../src/ui/chat-activity";
import type { UIJob } from "../src/ui/api";
const job: UIJob = {
  id: "j",
  runId: "r",
  role: "primary",
  status: "running",
  revision: 1
};
it("distinguishes queued/preparing/waiting work from active inference", () => {
  expect(
    chatActivity({ ...job, status: "created" }, [], false, true).label
  ).toBe("Queued");
  expect(
    chatActivity(
      { ...job, status: "created", preparingConversation: true },
      [],
      false,
      true
    ).label
  ).toBe("Preparing assessment");
  expect(
    chatActivity({ ...job, status: "waiting" }, [], false, true).label
  ).toBe("Waiting for specialists");
  expect(chatActivity(job, [], true, true).label).toBe("Working");
});
it("does not show a terminal publication fence as a failure or accepted completion", () => {
  const messages = [
    {
      id: "m",
      role: "assistant" as const,
      parts: [
        {
          type: "data-status" as const,
          data: { status: "failed", error: "Attempt has settled" }
        }
      ]
    }
  ];
  expect(chatActivity(job, messages, false, true).label).toBe(
    "Updating agent status"
  );
  expect(isPublicationFence("Network failed")).toBe(false);
  expect(isPublicationFence("Terminal publication has started")).toBe(true);
  expect(
    chatActivity({ ...job, status: "failed" }, messages, false, true).label
  ).toBe("Failed");
});
it("uses native tool activity without disclosing tool arguments in the summary", () => {
  const messages = [
    {
      id: "m",
      role: "assistant" as const,
      parts: [
        {
          type: "dynamic-tool" as const,
          toolName: "browser",
          toolCallId: "t",
          state: "input-available" as const,
          input: { secret: "do-not-display" }
        }
      ]
    }
  ];
  expect(chatActivity(job, messages, true, true).label).toBe("Using browser");
  expect(JSON.stringify(chatActivity(job, messages, true, true))).not.toContain(
    "do-not-display"
  );
  expect(toolLabel("functions__terminal")).toBe("Using terminal");
});
