/** Shared scripted HTTP services for the Wrangler and Vitest fixtures. */
export async function fixtureServices(
  request: Request
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const kind = url.pathname.slice(1);
  if (kind === "curl-fixture")
    return Response.json(
      {
        method: request.method,
        header: request.headers.get("X-Curl-Fixture"),
        body: await request.text()
      },
      { status: 207 }
    );
  if (kind === "fake-provider") {
    if (url.searchParams.has("question")) {
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const ask = !body.messages.some((message) => message.role === "tool");
      const delta = ask
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_preparation_question",
                type: "function",
                function: {
                  name: "question",
                  arguments: JSON.stringify({
                    questions: [
                      {
                        header: "Approach",
                        question: "What should we prepare?",
                        options: [
                          {
                            label: "Focused",
                            description: "Review the selected project"
                          },
                          {
                            label: "Broader",
                            description: "Discuss the wider project"
                          }
                        ]
                      }
                    ]
                  })
                }
              }
            ]
          }
        : { role: "assistant", content: "Ready to prepare Focused" };
      const frame = (delta: unknown, finish: string | null) =>
        "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finish }]
        }) +
        "\n\n";
      return new Response(
        frame(delta, null) +
          frame({}, ask ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }
    const chunks = [
      {
        id: "fixture",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "OK" },
            finish_reason: null
          }
        ]
      },
      {
        id: "fixture",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
      }
    ];
    return new Response(
      chunks.map((x) => "data: " + JSON.stringify(x) + "\n\n").join("") +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } }
    );
  }
}
