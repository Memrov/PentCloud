import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LogPanel } from "../src/ui/components/log-panel";
import { sessionLogEntries } from "../src/ui/dashboard/agent-log";
import type { ChatMessage } from "../src/ui/presentation";

describe("agent log panel", () => {
  it("flattens prompts, text, tool calls, results and failures into ordered rows", () => {
    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Scan the target", state: "done" }]
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Plan the scan", state: "done" },
          {
            type: "dynamic-tool",
            toolCallId: "c1",
            toolName: "pentcloud__terminal",
            state: "output-available",
            input: { command: "nmap -sV host" },
            output: ["22/tcp open ssh"]
          },
          {
            type: "dynamic-tool",
            toolCallId: "c2",
            toolName: "web_search",
            state: "output-error",
            input: { q: "cve" },
            errorText: "rate limited"
          },
          {
            type: "dynamic-tool",
            toolCallId: "c3",
            toolName: "computer.read",
            state: "input-available",
            input: { path: "/etc/hosts" }
          },
          { type: "text", text: "  ", state: "streaming" },
          { type: "text", text: "Found SSH", state: "streaming" },
          { type: "data-status", data: { status: "failed", error: "boom" } },
          {
            type: "data-status",
            data: { status: "failed", error: "Attempt has settled" }
          }
        ]
      }
    ];
    const rows = sessionLogEntries(messages);
    expect(rows.map((row) => [row.direction, row.type, row.data])).toEqual([
      ["out", "prompt", "Scan the target"],
      ["info", "thinking", "Plan the scan"],
      ["out", "terminal", '{"command":"nmap -sV host"}'],
      ["in", "terminal result", "22/tcp open ssh"],
      ["out", "web_search", '{"q":"cve"}'],
      ["error", "web_search failed", "rate limited"],
      ["out", "read", '{"path":"/etc/hosts"}'],
      ["in", "message", "Found SSH"],
      ["error", "status failed", "boom"]
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("clips very long payloads to keep rows compact", () => {
    const [row] = sessionLogEntries([
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "text", text: "x".repeat(2_000), state: "done" }]
      }
    ]);
    expect(row?.data?.length).toBe(601);
    expect(row?.data?.endsWith("…")).toBe(true);
  });

  it("renders rows as a labelled log with history and live timestamps", () => {
    const html = renderToStaticMarkup(
      createElement(LogPanel, {
        title: "Live output",
        logs: [
          { id: "1", direction: "out", type: "terminal", data: "ls" },
          {
            id: "2",
            direction: "error",
            type: "terminal failed",
            data: "denied",
            timestamp: Date.UTC(2026, 0, 1)
          }
        ],
        onClear: () => undefined
      })
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Live output"');
    expect(html).toContain("history");
    expect(html).toContain("log-entry-error");
    expect(html).toContain("denied");
    expect(
      renderToStaticMarkup(
        createElement(LogPanel, { logs: [], emptyText: "Nothing yet" })
      )
    ).toContain("Nothing yet");
  });
});
