import { expect, it } from "vite-plus/test";
import { chatTurns } from "../src/ui/chat-transcript";
import type { ChatMessage } from "../src/ui/presentation";
it("keeps native launch/finalization instructions in activity and shows the saved customer objective once", () => {
  const message = (
    id: string,
    role: ChatMessage["role"],
    text: string
  ): ChatMessage => ({
    id,
    role,
    parts: [{ type: "text", text, state: "done" }]
  });
  const input = [
    message("msg_prepare-job", "user", "Internal preparation"),
    message("a1", "assistant", "Preparing"),
    message("msg_job", "user", "Internal native launch"),
    message("a2", "assistant", "Reviewing"),
    message("msg_finalize-job", "user", "Internal finalization"),
    message("a3", "assistant", "Results"),
    message("msg_customer", "user", "Focus on authorization"),
    message("a4", "assistant", "Follow-up")
  ];
  const turns = chatTurns(input, { id: "job", task: "Assess my project" });
  expect(turns.map((turn) => turn.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant"
  ]);
  expect(turns[0]?.messages[0]?.parts[0]).toMatchObject({
    text: "Assess my project"
  });
  expect(
    turns[1]?.messages.filter((message) => message.role === "system")
  ).toHaveLength(3);
  expect(turns[2]?.messages[0]?.parts[0]).toMatchObject({
    text: "Focus on authorization"
  });
  expect(input[0]?.role).toBe("user");
});
