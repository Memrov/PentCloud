import { describe, expect, it, vi } from "vitest";
import {
  emptySessionProjection,
  projectSessionSnapshot,
  projectSessionEvent,
  projectLiveSessionEvent,
  sessionMessagesForJob,
} from "../src/ui/session-projection";
import {
  connectNativeSession,
} from "../src/ui/native-stream";

// Shapes verified against @opencode/schema 2.2.5 session-message.js/session-event.js.
const snapshot = {
  messages: [
    {
      id: "msg_user",
      type: "user",
      text: "Inspect target",
      time: { created: 1 },
    },
    {
      id: "msg_answer",
      type: "assistant",
      agent: "primary",
      model: { providerID: "opencode", id: "deepseek-v4-pro" },
      time: { created: 2 },
      content: [
        {
          type: "reasoning",
          text: "Consider scope",
          time: { created: 2, completed: 3 },
        },
        { type: "text", text: "Hello" },
        {
          type: "tool",
          id: "call-1",
          name: "terminal",
          time: { created: 2 },
          state: { status: "running", input: { command: "pwd" }, metadata: {} },
        },
      ],
    },
  ],
  busy: true,
  pending: [],
  cursor: "10",
};
const event = (
  type: string,
  data: Record<string, unknown>,
  seq?: number,
  id = `evt_${seq ?? "ephemeral"}`,
) => ({
  id,
  created: 4,
  type,
  data: { sessionID: "ses_1", ...data },
  ...(seq === undefined
    ? {}
    : { durable: { aggregateID: "ses_1", seq, version: 1 } }),
});
const ended = event(
  "session.text.ended",
  { assistantMessageID: "msg_answer", ordinal: 1, text: "Hello world" },
  11,
);

describe("native session projection", () => {
  it("retains browser screenshots in history and live events without putting binary data in output text", () => {
    const image = "data:image/png;base64,aGVsbG8=";
    let state = projectSessionSnapshot(emptySessionProjection(), snapshot);
    state = projectSessionEvent(state, event("session.tool.success", {
      assistantMessageID:"msg_answer", id:"call-1", content:[{type:"text",text:"Screenshot captured"}],
      metadata:{cloudflareImages:[image,"data:text/html;base64,aGVsbG8="]},
    }, 11), "11");
    expect(state.messages[1]?.parts[2]).toMatchObject({images:[image],output:["Screenshot captured"]});
    const restored = projectSessionSnapshot(emptySessionProjection(), {messages:state.native,busy:false,pending:[]});
    expect(restored.messages[1]?.parts[2]).toMatchObject({images:[image]});
  });
  it("projects actual SDK history and durable text/tool/step events with stable IDs", () => {
    let state = projectSessionSnapshot(emptySessionProjection(), snapshot);
    expect(state.messages.map((message) => message.id)).toEqual([
      "msg_user",
      "msg_answer",
    ]);
    expect(state.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "Inspect target",
      state: "done",
    });
    expect(state.messages[1]?.parts[0]).toMatchObject({
      type: "reasoning",
      state: "done",
    });
    state = projectSessionEvent(state, ended, "11");
    state = projectSessionEvent(
      state,
      event(
        "session.tool.success",
        {
          assistantMessageID: "msg_answer",
          id: "call-1",
          executed: true,
          content: [{ type: "text", text: "/workspace" }],
        },
        12,
      ),
      "12",
    );
    expect(state.messages[1]?.parts).toHaveLength(3);
    expect(state.messages[1]?.parts[1]).toMatchObject({
      text: "Hello world",
      state: "done",
      id: "text:1",
    });
    expect(state.messages[1]?.parts[2]).toMatchObject({
      toolCallId: "call-1",
      state: "output-available",
      output: ["/workspace"],
    });
    state = projectSessionEvent(
      state,
      event(
        "session.step.ended",
        {
          assistantMessageID: "msg_answer",
          finish: "stop",
          cost: 0,
          tokens: {},
        },
        13,
      ),
      "13",
    );
    expect(state.messages[1]?.parts[1]).toMatchObject({ state: "done" });
  });

  it("reconnect replaces the snapshot and ignores replayed or pre-snapshot durable events", () => {
    const first = projectSessionSnapshot(emptySessionProjection(), snapshot);
    const live = projectSessionEvent(first, ended, "11");
    expect(projectSessionEvent(live, ended, "11")).toBe(live);
    const history = structuredClone(snapshot);
    history.cursor = "15";
    history.messages[1]!.content![1]!.text = "Hello world";
    let restored = projectSessionSnapshot(live, history);
    restored = projectSessionEvent(restored, ended, "11");
    restored = projectSessionEvent(
      restored,
      event(
        "session.text.ended",
        { assistantMessageID: "msg_answer", ordinal: 1, text: "Hello world!" },
        16,
      ),
      "16",
    );
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[1]?.parts[1]).toMatchObject({
      text: "Hello world!",
    });
    expect(restored.cursor).toBe("16");
  });

  it("renders new assistant text/reasoning and deduplicates ephemeral deltas without advancing durable cursors", () => {
    let state = projectSessionEvent(
      emptySessionProjection(),
      event(
        "session.step.started",
        { assistantMessageID: "msg_new", started: 1 },
        1,
      ),
      "1",
    );
    state = projectSessionEvent(
      state,
      event(
        "session.reasoning.started",
        { assistantMessageID: "msg_new", ordinal: 0 },
        2,
      ),
      "2",
    );
    state = projectSessionEvent(
      state,
      event(
        "session.reasoning.ended",
        { assistantMessageID: "msg_new", ordinal: 0, text: "Plan" },
        3,
      ),
      "3",
    );
    state = projectSessionEvent(
      state,
      event(
        "session.text.started",
        { assistantMessageID: "msg_new", ordinal: 1 },
        4,
      ),
      "4",
    );
    const delta = event("session.text.delta", {
      assistantMessageID: "msg_new",
      ordinal: 1,
      delta: "Hello",
    });
    state = projectSessionEvent(state, delta, "4"); // EventSource retains the previous durable id on ephemeral frames.
    expect(projectSessionEvent(state, delta, "4")).toBe(state);
    expect(state.cursor).toBe("4");
    state = projectSessionEvent(
      state,
      event(
        "session.text.ended",
        { assistantMessageID: "msg_new", ordinal: 1, text: "Hello world" },
        5,
      ),
      "5",
    );
    expect(state.messages[0]?.parts).toMatchObject([
      { type: "reasoning", text: "Plan", state: "done" },
      { type: "text", text: "Hello world", state: "done" },
    ]);
    expect(state.busy).toBe(true);
  });

  it("projects queued/delivered/cancelled input, failed tool results and native interruption", () => {
    let state = projectSessionEvent(
      emptySessionProjection(),
      event(
        "session.inbox.enqueued",
        {
          inboxID: "msg_input",
          item: {
            type: "user",
            delivery: "steer",
            payload: { text: "Continue" },
          },
        },
        1,
      ),
      "1",
    );
    expect(state.messages[0]?.parts).toMatchObject([
      { text: "Continue" },
      { type: "data-status", data: { status: "Queued" } },
    ]);
    state = projectSessionEvent(
      state,
      event("session.inbox.delivered", { inboxID: "msg_input" }, 2),
      "2",
    );
    expect(state.messages).toHaveLength(1);
    expect(state.pending).toEqual([]);
    state = projectSessionEvent(
      state,
      event(
        "session.tool.input.started",
        { assistantMessageID: "msg_new", id: "call", name: "terminal" },
        3,
      ),
      "3",
    );
    state = projectSessionEvent(
      state,
      event(
        "session.tool.failed",
        {
          assistantMessageID: "msg_new",
          id: "call",
          executed: true,
          error: { type: "Error", message: "Remote outcome unknown" },
        },
        4,
      ),
      "4",
    );
    expect(state.messages[1]?.parts[0]).toMatchObject({
      state: "output-error",
      errorText: "Remote outcome unknown",
    });
    state = projectSessionEvent(
      state,
      event("session.execution.interrupted", { reason: "user" }, 5),
      "5",
    );
    expect(state.busy).toBe(false);
    expect(state.messages[2]?.parts[0]).toMatchObject({
      type: "data-status",
      data: { status: "interrupted" },
    });
    state = projectSessionEvent(
      state,
      event(
        "session.inbox.enqueued",
        {
          inboxID: "msg_cancel",
          item: {
            type: "user",
            delivery: "queue",
            payload: { text: "Cancel me" },
          },
        },
        6,
      ),
      "6",
    );
    state = projectSessionEvent(
      state,
      event("session.inbox.cancelled", { inboxID: "msg_cancel" }, 7),
      "7",
    );
    expect(state.messages.some((message) => message.id === "msg_cancel")).toBe(
      false,
    );
  });

  it("accepts normalized presentation snapshots and clears them on empty history", () => {
    let state = projectSessionSnapshot(emptySessionProjection(), {
      messages: [
        {
          id: "m",
          role: "assistant",
          parts: [{ type: "text", text: "Saved", state: "done" }],
          privateMetadata: "ignored",
        },
      ],
    });
    expect(state.messages).toEqual([
      {
        id: "m",
        role: "assistant",
        parts: [{ type: "text", text: "Saved", state: "done" }],
      },
    ]);
    state = projectSessionSnapshot(state, { messages: [] });
    expect(state.messages).toEqual([]);
  });

  it("shows native live text before completion and replaces it on reconnect", () => {
    const listeners = new Map<string, EventListener>();
    const source={onopen:null,onerror:null,addEventListener:(name:string,listener:EventListener)=>listeners.set(name,listener),close:vi.fn()};
    const onProjection=vi.fn(),onError=vi.fn(),onControlsChanged=vi.fn();
    const stop=connectNativeSession("live",{onProjection,onConnection:vi.fn(),onError,onControlsChanged},()=>source as unknown as EventSource);
    const send=(kind:string,data:unknown)=>listeners.get(kind)?.({data:JSON.stringify(data),lastEventId:""} as unknown as Event);
    send("snapshot",{messages:[],busy:true,pending:[]});
    send("live",{type:"message_start",messageId:"answer",agent:"primary",model:{providerID:"opencode-go",id:"fixture"}});
    send("live",{type:"text_delta",messageId:"answer",ordinal:0,delta:"I am inspecting"});
    expect(onProjection.mock.lastCall?.[0].messages[0]?.parts[0]).toMatchObject({text:"I am inspecting",state:"streaming"});
    send("live",{type:"text_delta",messageId:"answer",ordinal:0,delta:" the target."});
    expect(onProjection.mock.lastCall?.[0].messages[0]?.parts[0].text).toBe("I am inspecting the target.");
    send("snapshot",{messages:[{id:"answer",type:"assistant",content:[{type:"text",text:"I am inspecting the target."}]}],busy:true,pending:[]});
    send("live",{type:"text_end",messageId:"answer",ordinal:0,text:"I am inspecting the target."});
    send("live",{type:"message_end",messageId:"answer",finish:"stop"});
    expect(onProjection.mock.lastCall?.[0].messages).toHaveLength(1);
    expect(onProjection.mock.lastCall?.[0].messages[0]?.parts[0]).toMatchObject({text:"I am inspecting the target.",state:"done"});
    expect(onControlsChanged).toHaveBeenCalledTimes(2); // Snapshots only, never text deltas.
    send("live",{type:"permission_asked",permission:{id:"permission"}});
    send("live",{type:"permission_replied",permissionId:"permission",reply:"reject"});
    send("live",{type:"tool_start",messageId:"question",toolCallId:"q",name:"question",input:{}});
    expect(onControlsChanged).toHaveBeenCalledTimes(5);
    expect(onError).not.toHaveBeenCalled();stop();
  });

  it("keeps live spans on both sides of a tool and preserves queued inputs and screenshot evidence", () => {
    let state=projectSessionSnapshot(emptySessionProjection(),{messages:[],busy:true,pending:[]});
    const live=(value:unknown)=>{state=projectLiveSessionEvent(state,value);};
    live({type:"operation_queued",operationId:"steer",inbox:[{id:"msg_steer",type:"user",payload:{text:"Check authorization"}}]});
    expect(state.messages[0]?.parts[0]).toMatchObject({text:"Check authorization"});
    live({type:"operation_start",operationId:"steer",nativeMessage:{id:"msg_steer",type:"user",text:"Check authorization"}});
    live({type:"message_start",messageId:"answer",agent:"primary",model:{providerID:"opencode-go",id:"fixture"}});
    live({type:"text_delta",messageId:"answer",ordinal:0,delta:"First observation."});
    live({type:"text_end",messageId:"answer",ordinal:0,text:"First observation."});
    live({type:"tool_start",messageId:"answer",toolCallId:"browser",name:"cloudflare_browser",input:{action:"screenshot"}});
    live({type:"tool_end",messageId:"answer",toolCallId:"browser",name:"cloudflare_browser",error:false,output:"Captured",nativeTool:{type:"tool",id:"browser",name:"cloudflare_browser",state:{status:"completed",input:{action:"screenshot"},content:[{type:"text",text:"Captured"}],metadata:{cloudflareImages:["data:image/png;base64,aGVsbG8="]}}}});
    live({type:"text_delta",messageId:"answer",ordinal:1,delta:"Second observation."});
    live({type:"text_end",messageId:"answer",ordinal:1,text:"Second observation."});
    expect(state.messages).toHaveLength(2);expect(state.pending).toEqual([]);
    expect(state.messages[1]?.parts.flatMap(p=>p.type==="text"?[p.text]:[])).toEqual(["First observation.","Second observation."]);
    expect(state.messages[1]?.parts.find(p=>p.type==="dynamic-tool")).toMatchObject({images:["data:image/png;base64,aGVsbG8="],input:{action:"screenshot"}});
  });

  it("does not restart completed text when SDK events repeat the reconnect snapshot", () => {
    let state=projectSessionSnapshot(emptySessionProjection(),{messages:[{id:"done",type:"assistant",time:{completed:1},content:[{type:"text",text:"Committed response"}]}],busy:true,pending:[]});
    state=projectLiveSessionEvent(state,{type:"message_start",messageId:"done",agent:"primary",model:{providerID:"opencode",id:"fixture"}});
    state=projectLiveSessionEvent(state,{type:"text_delta",messageId:"done",ordinal:0,delta:"",text:"Committed"});
    expect(state.messages[0]?.parts[0]).toMatchObject({text:"Committed response",state:"done"});
  });

  it("retains displayed prose while a reconnect waits for native unfinished-span completion", () => {
    let state=projectSessionSnapshot(emptySessionProjection(),{messages:[],busy:true,pending:[]});
    state=projectLiveSessionEvent(state,{type:"text_delta",messageId:"answer",ordinal:0,delta:"",text:"Already displayed prose"});
    state=projectSessionSnapshot(state,{messages:[{id:"answer",type:"assistant",time:{created:1},content:[{type:"text",text:""}]}],pending:[],busy:true,pendingSpans:["answer:text:0"]});
    expect(state.messages[0]?.parts[0]).toMatchObject({text:"Already displayed prose",state:"done"});
    state=projectLiveSessionEvent(state,{type:"text_delta",messageId:"answer",ordinal:0,delta:"suffix without prefix"});
    expect(state.messages[0]?.parts[0]).toMatchObject({text:"Already displayed prose"});
    state=projectLiveSessionEvent(state,{type:"text_end",messageId:"answer",ordinal:0,text:"Already displayed prose and its completion"});
    expect(state.messages[0]?.parts[0]).toMatchObject({text:"Already displayed prose and its completion",state:"done"});
  });

  it("uses one EventSource through reconnect, deduplicates replay and closes on cleanup", () => {
    const listeners = new Map<string, EventListener>();
    const source = {
      onopen: null,
      onerror: null,
      addEventListener: (name: string, listener: EventListener) =>
        listeners.set(name, listener),
      close: vi.fn(),
    };
    const factory = vi.fn(() => source as unknown as EventSource);
    const onProjection = vi.fn();
    const onConnection = vi.fn();
    const onError = vi.fn();
    const stop = connectNativeSession(
      "job/1",
      { onProjection, onConnection, onError },
      factory,
    );
    const send = (kind: string, data: unknown, lastEventId: string) =>
      listeners.get(kind)!({
        data: JSON.stringify(data),
        lastEventId,
      } as unknown as Event);
    send("snapshot", snapshot, "10");
    send("session", ended, "11");
    (source.onerror as unknown as () => void)();
    (source.onopen as unknown as () => void)();
    send("session", ended, "11");
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith("/v1/ui/jobs/job%2F1/events");
    expect(onConnection.mock.calls).toEqual([[false], [true]]);
    expect(onProjection.mock.lastCall?.[0].messages[1].parts[1].text).toBe(
      "Hello world",
    );
    expect(onError).not.toHaveBeenCalled();
    listeners.get("end")!({} as Event);
    expect(source.close).toHaveBeenCalledOnce();
    stop();
    expect(source.close).toHaveBeenCalledTimes(2);
  });

  it("omits only the exact native settlement fence after accepted completed/waiting output", () => {
    const state = projectSessionSnapshot(emptySessionProjection(), { messages: [
      { id: "msg_report", type: "assistant", content: [{ type: "text", text: "Accepted report" }], error: { type: "Error", message: "Attempt has settled" }, time: { completed: 4 } },
      { id: "msg_stop", type: "idle", outcome: "failed", error: { type: "Error", message: "Attempt has settled" } },
    ] });
    for (const status of ["completed", "waiting"] as const) {
      expect(sessionMessagesForJob(state, { status, outputCommit: "a".repeat(40) })).toEqual([
        { id: "msg_report", role: "assistant", parts: [{ id: "msg_report:0", type: "text", text: "Accepted report", state: "done" }] },
      ]);
    }
    // The native history remains intact; this is solely a browser view selection.
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.parts).toHaveLength(2);
  });

  it("uses the latest accepted job after a live fence arrives without another message event", () => {
    let state = projectSessionEvent(emptySessionProjection(), event("session.step.started", { assistantMessageID: "msg_report", started: 1 }, 1));
    state = projectSessionEvent(state, event("session.text.ended", { assistantMessageID: "msg_report", ordinal: 0, text: "Published result" }, 2));
    state = projectSessionEvent(state, event("session.execution.failed", { error: { type: "Error", message: "Attempt has settled" } }, 3));
    expect(sessionMessagesForJob(state, { status: "running" })).toBe(state.messages);
    expect(sessionMessagesForJob(state, { status: "completed", outputCommit: "b".repeat(40) })).toHaveLength(1);
    for (const job of [{ status: "completed" }, { status: "waiting", outputCommit: "main" }, { status: "failed", outputCommit: "b".repeat(40) }, { status: "interrupted", outputCommit: "b".repeat(40) }] as const) {
      expect(sessionMessagesForJob(state, job)).toBe(state.messages);
    }
  });

  it("preserves real research errors, near-match messages and failed tool output", () => {
    const state = projectSessionSnapshot(emptySessionProjection(), { messages: [
      { id: "research", type: "idle", outcome: "failed", error: { type: "Error", message: "Public web search is unavailable" } },
      { id: "near", type: "idle", outcome: "failed", error: { type: "Error", message: "Attempt has settled while reading a result" } },
      { id: "tool", type: "assistant", content: [{ type: "tool", id: "call-1", name: "web_search", state: { status: "error", input: {}, error: { type: "Error", message: "Attempt has settled" } } }], time: { completed: 4 } },
    ] });
    expect(sessionMessagesForJob(state, { status: "completed", outputCommit: "c".repeat(40) })).toBe(state.messages);
    expect(state.messages[0]?.parts[0]).toMatchObject({ data: { error: "Public web search is unavailable" } });
    expect(state.messages[2]?.parts[0]).toMatchObject({ type: "dynamic-tool", state: "output-error" });
  });

  it("does not rewrite normalized historical messages without native SDK provenance", () => {
    const state = projectSessionSnapshot(emptySessionProjection(), { messages: [{ id: "archive", role: "assistant", parts: [{ type: "data-status", data: { status: "failed", error: "Attempt has settled" } }] }] });
    expect(sessionMessagesForJob(state, { status: "completed", outputCommit: "d".repeat(40) })).toBe(state.messages);
  });

  it("shows a recovered terminal result only when its receipt matches the accepted job and exact native call", () => {
    const input = {success: true, result: "Actual accepted report"};
    const receipt = {id: "reporter", status: "completed", outputCommit: "e".repeat(40), tool: "report_result", arguments: input};
    const state = projectSessionSnapshot(emptySessionProjection(), {result: receipt, messages: [
      {id: "report", type: "assistant", content: [{type: "tool", id: "call_report", name: "report_result", state: {status: "error", input: {result: input.result, success: true}, error: {message: "An internal error occurred."}}}]},
      {id: "fence", type: "idle", outcome: "failed", error: {message: "Terminal publication has started"}},
    ]});
    const job = {id: "reporter", status: "completed", outputCommit: receipt.outputCommit} as const;
    const selected = sessionMessagesForJob(state, job);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.parts[0]).toMatchObject({toolName: "report_result", state: "output-available", recovered: true, output: {outputCommit: receipt.outputCommit, arguments: input}});
    expect(state.messages[0]?.parts[0]).toMatchObject({state: "output-error"});
    expect(state.messages).toHaveLength(2);
    for (const changed of [{...job, id: "other"}, {...job, outputCommit: "f".repeat(40)}, {...job, status: "running"}, {...job, status: "failed"}] as const)
      expect(sessionMessagesForJob(state, changed)).toBe(state.messages);
    const updated = projectSessionEvent(state, event("session.execution.failed", {error: {message: "Terminal publication has started"}}, 4));
    expect(sessionMessagesForJob(updated, job)).toHaveLength(1);
    expect(projectSessionSnapshot(state, {messages: []})).not.toHaveProperty("result");
  });

  it("does not turn unrelated or ambiguous failed tools into accepted results", () => {
    const receipt = {id: "reporter", status: "completed" as const, outputCommit: "e".repeat(40), tool: "report_result", arguments: {success: true, result: "Accepted"}};
    const failed = (id: string, name: string, input: unknown) => ({id, type: "assistant", content: [{type: "tool", id, name, state: {status: "error", input, error: {message: "An internal error occurred."}}}]});
    for (const messages of [
      [failed("different", "report_result", {success: true, result: "Different"})],
      [failed("research", "web_search", receipt.arguments)],
      [failed("first", "report_result", receipt.arguments), failed("second", "report_result", receipt.arguments)],
    ]) {
      const state = projectSessionSnapshot(emptySessionProjection(), {result: receipt, messages});
      expect(sessionMessagesForJob(state, {...receipt})).toBe(state.messages);
    }
    const state = projectSessionSnapshot(emptySessionProjection(), {messages: [{id: "unaccepted", type: "idle", outcome: "failed", error: {message: "Terminal publication has started"}}]});
    expect(sessionMessagesForJob(state, receipt)).toBe(state.messages);
  });

});
