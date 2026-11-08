import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withNativeTestHarness } from "./lib/native-test-harness.mjs";

// A local scripted provider exercises the pinned native engine. No model API,
// scanner, production Worker, credential or network service is contacted.
const app = fileURLToPath(new URL("../apps/control-plane/", import.meta.url));
const evidence =
  process.env.PENTCLOUD_QUESTION_EVIDENCE_DIR ??
  (await mkdtemp(join(tmpdir(), "pentcloud-question-recovery-")));
const calls = [];
const counts = new Map();
let inFlightProviderRequests = 0;
const provider = createServer(async (request, response) => {
  inFlightProviderRequests++;
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const encoded = JSON.stringify(input.messages);
    const mode = encoded.includes("RECOVERY_MODE=reask") ? "reask" : "continue";
    const count = (counts.get(mode) ?? 0) + 1;
    counts.set(mode, count);
    const toolMessages = input.messages.filter(
      (message) => message.role === "tool"
    );
    const answered = toolMessages.some((message) =>
      JSON.stringify(message.content).includes(
        "User has answered your questions"
      )
    );
    const interrupted = toolMessages.some((message) =>
      JSON.stringify(message.content).includes("Tool execution interrupted")
    );
    calls.push({
      mode,
      count,
      answered,
      interrupted,
      toolMessages,
      toolNames: (input.tools ?? []).map((tool) => tool.function?.name)
    });
    const ask = !answered && (!interrupted || mode === "reask");
    const delta = ask
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_question_${mode}_${count}`,
              type: "function",
              function: {
                name: "question",
                arguments: JSON.stringify({
                  questions: [
                    {
                      header: "Approach",
                      question: "Which approach should continue?",
                      options: [
                        {
                          label: "Focused",
                          description: "Keep the existing scope"
                        },
                        {
                          label: "Broader",
                          description: "Include the optional section"
                        }
                      ]
                    }
                  ]
                })
              }
            }
          ]
        }
      : {
          role: "assistant",
          content: answered
            ? "Recovered answer: Focused"
            : "Question was interrupted; this scripted model continues without an answer."
        };
    const frame = (change, finish) =>
      `data: ${JSON.stringify({ id: `chatcmpl-${mode}-${count}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "question-fixture", choices: [{ index: 0, delta: change, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      frame(delta, null) +
        frame({}, ask ? "tool_calls" : "stop") +
        "data: [DONE]\n\n"
    );
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  } finally {
    inFlightProviderRequests--;
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
let logs = [];
let result;
try {
  await withNativeTestHarness(
    {
      root: app,
      workers: [
        {
          configPath: "test/native-session-recovery-probe/wrangler.jsonc",
          vars: { PROVIDER_URL: providerURL }
        }
      ]
    },
    async (server) => {
      const request = async (path) => {
        const response = await server.fetch(path, {
          signal: AbortSignal.timeout(20000)
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      };
      try {
        const results = {};
        for (const mode of ["continue", "reask"]) {
          const before = await request(`/start?mode=${mode}`);
          assert.equal(before.form.fields[0].custom, true);
          try {
            await server.fetch(`/evict?mode=${mode}`, {
              signal: AbortSignal.timeout(3000)
            });
          } catch {}
          const after = await request(`/after?mode=${mode}`);
          assert.ok(
            after.staleRejected,
            "Lost form IDs must not accept a reply after eviction"
          );
          assert.equal(after.pending.length, 0);
          assert.equal(after.answer.status, "done");
          assert.match(
            JSON.stringify(after.history),
            /Tool execution interrupted: question/
          );
          if (mode === "continue") {
            assert.equal(after.replacement, undefined);
            assert.match(after.answer.text, /continues without an answer/);
          } else {
            assert.notEqual(after.replacement.id, before.form.id);
            assert.match(after.answer.text, /Recovered answer: Focused/);
          }
          results[mode] = { before, after };
        }
        result = {
          passed: true,
          conclusion:
            "Forms are ephemeral. The engine fails an interrupted question and continues the model; a replacement question exists only when that model chooses to ask again.",
          results,
          calls
        };
      } finally {
        logs = server.getLogs();
      }
    }
  );
} finally {
  await new Promise((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve()))
  );
  await writeFile(join(evidence, "runtime.log"), JSON.stringify(logs, null, 2));
  await writeFile(
    join(evidence, "provider-calls.json"),
    JSON.stringify(calls, null, 2)
  );
}
assert.equal(provider.listening, false);
assert.equal(
  inFlightProviderRequests,
  0,
  "No scripted model request remains after runtime shutdown"
);
result.shutdown = {
  workerClosed: true,
  providerClosed: true,
  inFlightProviderRequests
};
await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    passed: true,
    evidence,
    inference: "loopback scripted provider only",
    shutdown: result.shutdown,
    conclusion: result.conclusion
  })
);
