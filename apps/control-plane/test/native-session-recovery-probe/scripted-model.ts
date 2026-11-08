/**
 * A scripted OpenAI-compatible chat model for OpenCode's question tool. It
 * answers the Worker's outbound requests in the test runner (Miniflare's
 * `outboundService`), so no model API or network is contacted. The answer
 * depends only on the transcript, so a turn resumed after a crash gets a
 * deterministic answer:
 *
 * - With no tool result yet, the model asks one question.
 * - After a question is answered, it reports the answer.
 * - After a question is interrupted, `RECOVERY_MODE=reask` asks again and
 *   `RECOVERY_MODE=continue` carries on without an answer.
 */
export const SCRIPTED_MODEL_URL = "http://scripted-model.invalid/v1";

export async function scriptedModel(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== new URL(SCRIPTED_MODEL_URL).origin)
    return new Response("Unexpected outbound request", { status: 502 });
  const input = (await request.json()) as {
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  const messages = input.messages ?? [];
  const reask = JSON.stringify(messages).includes("RECOVERY_MODE=reask");
  const results = messages
    .filter((message) => message.role === "tool")
    .map((message) => JSON.stringify(message.content));
  const answered = results.some((result) =>
    result.includes("User has answered your questions")
  );
  const interrupted = results.some((result) =>
    result.includes("Tool execution interrupted")
  );
  const ask = !answered && (!interrupted || reask);
  const delta = ask
    ? { role: "assistant", tool_calls: [questionCall()] }
    : {
        role: "assistant",
        content: answered
          ? "Recovered answer: Focused"
          : "Question was interrupted; this scripted model continues without an answer."
      };
  const frame = (change: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "question-fixture",
      choices: [{ index: 0, delta: change, finish_reason: finish }]
    })}\n\n`;
  return new Response(
    frame(delta, null) +
      frame({}, ask ? "tool_calls" : "stop") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function questionCall() {
  return {
    index: 0,
    id: `call_question_${crypto.randomUUID()}`,
    type: "function",
    function: {
      name: "question",
      arguments: JSON.stringify({
        questions: [
          {
            header: "Approach",
            question: "Which approach should continue?",
            options: [
              { label: "Focused", description: "Keep the existing scope" },
              {
                label: "Broader",
                description: "Include the optional section"
              }
            ]
          }
        ]
      })
    }
  };
}
