import { parseJob, type UIJob } from "./api";
import type { ChatMessage, ChatPart } from "./presentation";
import { canonical } from "../native/domain";

type RecordValue = Record<string, unknown>;
interface NativeMessage extends RecordValue { id: string; type: string }
interface TerminalReceipt {
  id: string;
  status: "completed" | "waiting";
  outputCommit: string;
  tool: string;
  arguments: RecordValue;
}
export interface SessionProjection {
  messages: ChatMessage[];
  busy: boolean;
  pending: unknown[];
  job?: UIJob;
  cursor?: string;
  seenEventIds: ReadonlySet<string>;
  native: NativeMessage[];
  pendingSpans?: string[];
  result?: TerminalReceipt;
}
export function emptySessionProjection(): SessionProjection {
  return { messages: [], busy: false, pending: [], seenEventIds: new Set(), native: [] };
}

/** OpenCodeHarness live events use native message/call IDs; reconnect starts with a new snapshot. */
export function projectLiveSessionEvent(current: SessionProjection, value: unknown): SessionProjection {
  if (!record(value) || typeof value.type !== "string") throw new Error("invalid live session event");
  const eventType=value.type;
  let type: string | undefined, data: RecordValue = {};
  const messageId = value.messageId;
  if (typeof messageId === "string") data.assistantMessageID = messageId;
  const existing=typeof messageId==='string'?current.native.find(message=>message.id===messageId):undefined;
  // The SDK may repeat events already represented in its reconnect snapshot.
  if(existing&&record(existing.time)&&existing.time.completed!==undefined&&['message_start','text_delta','reasoning_delta','tool_start'].includes(eventType))return current;
  if(existing&&(eventType==='text_delta'||eventType==='reasoning_delta')){
    const kind=eventType.split('_')[0];
    const part=contents(existing).filter(part=>part.type===kind)[value.ordinal as number];
    if(current.pendingSpans?.includes(`${messageId}:${kind}:${value.ordinal}`)||part?.streaming===false||(part&&record(part.time)&&part.time.completed!==undefined))return current;
  }
  if(typeof messageId==="string"&&/^(text|reasoning)_(delta|end)$/.test(eventType)&&Number.isSafeInteger(value.ordinal)){
    const kind=eventType.split("_")[0]!,partID=`${kind}:${value.ordinal}`;
    const message=current.native.find(m=>m.id===messageId),parts=message?contents(message):[];
    if(!parts.some(part=>part.uiPartID===partID)){
      const snapshotPart=parts.filter(part=>part.type===kind)[value.ordinal as number];
      if(snapshotPart&&snapshotPart.uiPartID===undefined){
        current={...current,native:current.native.map(m=>m.id===messageId?{...m,content:parts.map(part=>part===snapshotPart?{...part,uiPartID:partID}:part)}:m)};
      }else current=projectSessionEvent(current,{type:`session.${kind}.started`,data:{assistantMessageID:messageId,ordinal:value.ordinal}});
    }
  }
  switch (eventType) {
    case "run_start": type="session.execution.started"; break;
    case "run_end": type=`session.execution.${value.outcome}`; if(typeof value.error==="string")data.error={message:value.error}; break;
    case "message_start": type="session.step.started"; data.started=0; break;
    case "message_end": type=value.error?"session.step.failed":"session.step.ended"; if(typeof value.error==="string")data.error={message:value.error}; break;
    case "text_delta": case "reasoning_delta": case "text_end": case "reasoning_end": {
      const [kind,operation]=eventType.split("_");
      const replacement=operation==="delta"&&typeof value.text==="string";
      type=`session.${kind}.${operation==="end"||replacement?"ended":"delta"}`;
      data={...data,ordinal:value.ordinal,...(operation==="end"||replacement?{text:value.text}:{delta:value.delta})};break;
    }
    case "tool_start": type="session.tool.called"; data={...data,id:value.toolCallId,name:value.name,input:value.input};break;
    case "tool_end": type=value.error?"session.tool.failed":"session.tool.success";data={...data,id:value.toolCallId,name:value.name,...(value.error?{error:{message:value.output}}:{content:[{type:"text",text:value.output}]})};break;
    case "operation_withdrawn": type="session.inbox.cancelled";data.inboxID=`msg_${value.operationId}`;break;
    case "operation_start": type="session.inbox.delivered";data.inboxID=`msg_${value.operationId}`;break;
    case "fault": type="session.execution.failed";data.error={message:value.message};break;
  }
  let next=type?projectSessionEvent(current,{type,data}):current;
  if(eventType==='text_end'||eventType==='reasoning_end')next={...next,pendingSpans:next.pendingSpans?.filter(key=>key!==`${messageId}:${eventType.split('_')[0]}:${value.ordinal}`)??[]};
  if(eventType==='message_end')next={...next,pendingSpans:next.pendingSpans?.filter(key=>!key.startsWith(messageId+':'))??[]};
  if(eventType==='run_end'||eventType==='fault')next={...next,pendingSpans:[]};
  if((eventType==="text_delta"||eventType==="reasoning_delta")&&typeof value.text==="string"){
    const partID=`${eventType.split('_')[0]}:${value.ordinal}`;
    next={...next,native:next.native.map(message=>message.id===messageId?{...message,content:contents(message).map(part=>part.uiPartID===partID?{...part,streaming:true}:part)}:message)};
  }
  if(Array.isArray(value.inbox))next={...next,pending:value.inbox};
  if(isNativeMessage(value.nativeMessage)){
    const message=value.nativeMessage;
    const native=next.native.some(m=>m.id===message.id)?next.native.map(m=>m.id===message.id?message:m):[...next.native,message];
    next={...next,native};
  }
  if(typeof messageId==="string"&&record(value.nativeTool)&&value.nativeTool.type==="tool"){
    const tool=value.nativeTool;
    next={...next,native:next.native.map(message=>message.id===messageId?{...message,content:contents(message).map(part=>part.type==="tool"&&part.id===tool.id?tool:part)}:message)};
  }
  return {...next,messages:[...next.native.flatMap(projectMessage),...pendingMessages(next.pending)]};
}

/** A readable view of the exact Coordinator-accepted terminal payload, never generated prose. */
export function acceptedOutcome(projection:SessionProjection,job:Pick<UIJob,"id"|"status"|"outputCommit">):string|undefined {
  const receipt=projection.result;
  if(!receipt||receipt.id!==job.id||receipt.status!==job.status||receipt.outputCommit!==job.outputCommit)return;
  const text=receipt.arguments.message??receipt.arguments.result;
  return typeof text==="string"&&text.trim()?text:undefined;
}

/** Hide the SDK's deliberate post-commit inference fence only after accepted job state arrives. */
export function sessionMessagesForJob(projection: SessionProjection, job: Pick<UIJob, "status" | "outputCommit"> & Partial<Pick<UIJob, "id">>): ChatMessage[] {
  if (!["completed", "waiting"].includes(job.status) || !/^[a-f0-9]{40}$/.test(job.outputCommit ?? "")) return projection.messages;
  // A local candidate is insufficient: Coordinator must have accepted this exact
  // attempt/commit/status before the browser reconciles its interrupted reply.
  const receipt = projection.result?.id === job.id && projection.result?.outputCommit === job.outputCommit && projection.result?.status === job.status ? projection.result : undefined;
  const matches = receipt ? projection.native.flatMap(message => contents(message).filter(part =>
    part.type === "tool" && part.name === receipt.tool && record(part.state) && part.state.status === "error" && record(part.state.input) && canonical(part.state.input) === canonical(receipt.arguments),
  ).map(part => ({messageID: message.id, callID: part.id}))) : [];
  const recovered = matches.length === 1 ? matches[0] : undefined;
  const isFence = (error: string | undefined) => error === "Attempt has settled" || (!!receipt && error === "Terminal publication has started");
  const fenced = new Set(projection.native.filter(message =>
    (message.type === "assistant" || (message.type === "idle" && message.outcome === "failed"))
    && isFence(errorText(message.error)),
  ).map(message => message.id));
  if (!fenced.size && !recovered) return projection.messages;
  let changed = false;
  const messages = projection.messages.flatMap(message => {
    const parts = message.parts.flatMap((part): ChatPart[] => {
      if (fenced.has(message.id) && part.type === "data-status" && part.data.status === "failed" && isFence(part.data.error)) { changed = true; return []; }
      if (receipt && recovered?.messageID === message.id && part.type === "dynamic-tool" && part.toolCallId === recovered.callID) {
        changed = true;
        const {errorText: _error, ...retained} = part;
        return [{...retained, state: "output-available", recovered: true, output: {status: receipt.status, outputCommit: receipt.outputCommit, arguments: receipt.arguments}}];
      }
      return [part];
    });
    return parts.length ? [{ ...message, parts }] : [];
  });
  return changed ? messages : projection.messages;
}

/** OpenCode 2.2 history uses {id,type,content}, independently of UI presentation messages. */
export function projectSessionSnapshot(current: SessionProjection, value: unknown, cursor = ""): SessionProjection {
  if (!record(value) || !Array.isArray(value.messages)) throw new Error("invalid session snapshot");
  const pendingSpans=Array.isArray(value.pendingSpans)?value.pendingSpans.filter((key):key is string=>typeof key==='string'):[];
  const native = value.messages.filter(isNativeMessage).map(message=>{
    if(message.type!=='assistant')return message;
    const ordinals={text:0,reasoning:0};
    const old=current.native.find(previous=>previous.id===message.id);
    return {...message,content:contents(message).map(part=>{
      if(part.type!=='text'&&part.type!=='reasoning')return part;
      const kind=part.type,ordinal=ordinals[kind]++;
      const previous=old?contents(old).filter(candidate=>candidate.type===kind)[ordinal]:undefined;
      const text=part.text===''&&pendingSpans.includes(`${message.id}:${kind}:${ordinal}`)&&typeof previous?.text==='string'?previous.text:part.text;
      return {...part,text,streaming:false};
    })};
  });
  const pending = Array.isArray(value.pending) ? value.pending : [];
  const normalized = value.messages.flatMap(message => normalizedMessage(message) ?? []);
  const snapshotCursor = typeof value.cursor === "string" || typeof value.cursor === "number" ? String(value.cursor) : cursor;
  const {result: _oldResult, ...base} = current;
  const result = terminalReceipt(value.result);
  return remember({ ...base, native, pending, pendingSpans, messages: [...native.flatMap(projectMessage), ...normalized, ...pendingMessages(pending)], busy: value.busy === true, ...(result ? {result} : {}), ...(value.job ? { job: parseJob(value.job) } : {}) }, snapshotCursor);
}

/** Native durable/ephemeral envelope: {id,created,type,data,durable?:{seq}}. */
export function projectSessionEvent(current: SessionProjection, value: unknown, cursor = ""): SessionProjection {
  if (!record(value) || typeof value.type !== "string" || !record(value.data)) throw new Error("invalid session event");
  const sequence = record(value.durable) && typeof value.durable.seq === "number" ? String(value.durable.seq) : typeof value.id === "string" ? "" : cursor;
  if (sequence && olderCursor(sequence, current.cursor)) return current;
  if (typeof value.id === "string" && current.seenEventIds.has(value.id)) return current;
  const data = value.data;
  const type = value.type;
  let native = current.native;
  let pending = current.pending;
  let busy = current.busy;
  const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
  const eventMessageID = typeof value.id === "string" ? value.id.replace(/^evt_/, "msg_") : `event:${sequence}`;
  const upsert = (message: NativeMessage) => { native = native.some(item => item.id === message.id) ? native.map(item => item.id === message.id ? message : item) : [...native, message]; };
  const updateAssistant = (update: (message: NativeMessage) => NativeMessage) => {
    if (!messageID) return;
    const existing = native.find(item => item.id === messageID) ?? { id: messageID, type: "assistant", content: [] };
    upsert(update(existing));
  };
  if (type === "session.inbox.enqueued" && typeof data.inboxID === "string" && record(data.item)) {
    pending = [...pending.filter(item => !record(item) || item.id !== data.inboxID), { ...data.item, id: data.inboxID }];
  } else if (type === "session.inbox.delivered" && typeof data.inboxID === "string") {
    const item = pending.find(item => record(item) && item.id === data.inboxID);
    if (record(item) && record(item.payload) && typeof item.payload.text === "string") upsert({ id: data.inboxID, type: item.type === "user" ? "user" : "synthetic", text: item.payload.text });
    pending = pending.filter(item => !record(item) || item.id !== data.inboxID);
  } else if (type === "session.inbox.cancelled") {
    pending = pending.filter(item => !record(item) || item.id !== data.inboxID);
  } else if (type === "session.execution.started") {
    busy = true;
  } else if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)) {
    busy = false;
    upsert({ id: eventMessageID, type: "idle", outcome: type.split(".").at(-1), ...(record(data.error) ? { error: data.error } : {}) });
  } else if (type === "session.step.started") {
    busy = true;
    updateAssistant(message => ({ ...message, time: { created: data.started } }));
  } else if (type === "session.step.ended" || type === "session.step.failed") {
    updateAssistant(message => ({ ...message, time: { ...(record(message.time) ? message.time : {}), completed: value.created ?? 0 }, ...(record(data.error) ? { error: data.error } : {}) }));
  } else if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(type)) {
    const kind = type.split(".")[1]!;
    const operation = type.split(".")[2]!;
    const partID = `${kind}:${String(data.ordinal)}`;
    updateAssistant(message => {
      const content = contents(message);
      let index = content.findIndex(part => part.uiPartID === partID);
      // A snapshot has no ordinal IDs, but native events reference the latest matching span.
      if (index < 0 && operation !== "started") index = content.findLastIndex(part => part.type === kind);
      if (index < 0) return { ...message, content: [...content, { type: kind, uiPartID: partID, text: operation === "ended" ? data.text : operation === "delta" ? data.delta : "", streaming: operation !== "ended" }] };
      const previous = content[index]!;
      const text = operation === "ended" ? data.text : operation === "delta" ? `${typeof previous.text === "string" ? previous.text : ""}${typeof data.delta === "string" ? data.delta : ""}` : previous.text;
      return { ...message, content: content.map((part, i) => i === index ? { ...part, uiPartID: partID, text, streaming: operation !== "ended" } : part) };
    });
  } else if (type.startsWith("session.tool.") && typeof data.id === "string") {
    updateAssistant(message => {
      const content = contents(message);
      const index = content.findIndex(part => part.type === "tool" && part.id === data.id);
      const previous = index < 0 ? { type: "tool", id: data.id, name: typeof data.name === "string" ? data.name : "Tool", state: { status: "streaming", input: "" } } : content[index]!;
      const state = record(previous.state) ? previous.state : { status: "streaming", input: "" };
      let next = previous;
      if (type === "session.tool.input.started") next = { ...previous, name: data.name };
      else if (type === "session.tool.input.delta") next = { ...previous, state: { ...state, input: `${typeof state.input === "string" ? state.input : ""}${typeof data.delta === "string" ? data.delta : ""}` } };
      else if (type === "session.tool.input.ended") next = { ...previous, state: { ...state, input: data.text } };
      else if (type === "session.tool.called") next = { ...previous, state: { status: "running", input: data.input } };
      else if (type === "session.tool.success") next = { ...previous, state: { status: "completed", input: state.input, content: data.content, metadata: data.metadata } };
      else if (type === "session.tool.failed") next = { ...previous, state: { status: "error", input: state.input, error: data.error } };
      return { ...message, content: index < 0 ? [...content, next] : content.map((part, i) => i === index ? next : part) };
    });
  } else if (type === "session.message.content.updated" && typeof data.messageID === "string" && Array.isArray(data.content)) {
    native = native.map(message => message.id === data.messageID ? { ...message, content: data.content } : message);
  } else if ((type === "session.synthetic" || type === "session.instructions.updated") && typeof data.text === "string") {
    upsert({ id: eventMessageID, type: "system", text: data.text });
  }
  const next = { ...current, native, pending, busy, messages: [...native.flatMap(projectMessage), ...pendingMessages(pending)] };
  // Ephemeral IDs also deduplicate live delivery, without advancing the durable reconnect cursor.
  if (typeof value.id === "string" && !sequence) next.seenEventIds = new Set([...current.seenEventIds, value.id]);
  return remember(next, sequence);
}

function projectMessage(message: NativeMessage): ChatMessage[] {
  if (["user", "system", "synthetic", "skill"].includes(message.type) && typeof message.text === "string") return [{ id: message.id, role: message.type === "user" ? "user" : "system", parts: [{ id: `${message.id}:text`, type: "text", text: message.text, state: "done" }] }];
  if (message.type === "idle") {
    if (message.outcome === "succeeded") return [];
    return [{ id: message.id, role: "assistant", parts: [{ type: "data-status", data: { status: String(message.outcome), ...(errorText(message.error) ? { error: errorText(message.error)! } : {}) } }] }];
  }
  if (message.type !== "assistant") return [];
  const complete = record(message.time) && message.time.completed !== undefined;
  const parts = contents(message).flatMap((part, index): ChatPart[] => {
    const id = typeof part.uiPartID === "string" ? part.uiPartID : `${message.id}:${index}`;
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") return [{ id, type: part.type, text: part.text, state: complete || part.streaming === false || (record(part.time) && part.time.completed !== undefined) ? "done" : "streaming" }];
    if (part.type === "tool" && typeof part.id === "string" && typeof part.name === "string" && record(part.state)) {
      const state = part.state;
      return [{ id: part.id, type: "dynamic-tool", toolCallId: part.id, toolName: part.name, state: state.status === "completed" ? "output-available" : state.status === "error" ? "output-error" : "input-available", input: state.input,
        ...(state.status === "completed" ? { output: toolOutput(state.content), images: toolImages(state.metadata) } : {}),
        ...(state.status === "error" ? { errorText: errorText(state.error) ?? "Tool failed" } : {}),
      }];
    }
    return [];
  });
  if (errorText(message.error)) parts.push({ type: "data-status", data: { status: "failed", error: errorText(message.error)! } });
  return [{ id: message.id, role: "assistant", parts }];
}
function pendingMessages(pending: unknown[]): ChatMessage[] {
  return pending.flatMap(item => record(item) && typeof item.id === "string" && record(item.payload) && typeof item.payload.text === "string" ? [{ id: item.id, role: "user", parts: [{ type: "text", text: item.payload.text, state: "done" }, { type: "data-status", data: { status: "Queued" } }] }] : []);
}
function normalizedMessage(value: unknown): ChatMessage[] | undefined {
  if (!record(value) || typeof value.id !== "string" || !["user", "assistant", "system"].includes(String(value.role)) || !Array.isArray(value.parts)) return undefined;
  const parts = value.parts.flatMap((part): ChatPart[] => {
    if (!record(part)) return [];
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") return [{ type: part.type, text: part.text, state: part.state === "streaming" ? "streaming" : "done" }];
    if (part.type === "dynamic-tool" && typeof part.toolCallId === "string" && typeof part.toolName === "string" && ["input-available", "output-available", "output-error"].includes(String(part.state))) return [{ type: "dynamic-tool", toolCallId: part.toolCallId, toolName: part.toolName, state: part.state as "input-available" | "output-available" | "output-error", input: part.input, ...(part.output === undefined ? {} : { output: part.output }), ...(typeof part.errorText === "string" ? { errorText: part.errorText } : {}) }];
    if (part.type === "data-status" && record(part.data) && typeof part.data.status === "string") return [{ type: "data-status", data: { status: part.data.status, ...(typeof part.data.error === "string" ? { error: part.data.error } : {}) } }];
    return [];
  });
  return [{ id: value.id, role: value.role as ChatMessage["role"], parts }];
}
function contents(message: NativeMessage): RecordValue[] { return Array.isArray(message.content) ? message.content.filter(record) : []; }
function terminalReceipt(value: unknown): TerminalReceipt | undefined {
  return record(value) && typeof value.id === "string" && (value.status === "completed" || value.status === "waiting") && typeof value.outputCommit === "string" && /^[a-f0-9]{40}$/.test(value.outputCommit) && typeof value.tool === "string" && record(value.arguments)
    ? {id: value.id, status: value.status, outputCommit: value.outputCommit, tool: value.tool, arguments: value.arguments} : undefined;
}
function errorText(value: unknown): string | undefined { return typeof value === "string" ? value : record(value) && typeof value.message === "string" ? value.message : undefined; }
function toolOutput(value: unknown): unknown { return Array.isArray(value) ? value.filter(record).map(part => part.type === "text" ? part.text : part.type === "file" ? { uri: part.uri, mime: part.mime, name: part.name } : undefined).filter(part => part !== undefined) : undefined; }
function isNativeMessage(value: unknown): value is NativeMessage { return record(value) && typeof value.id === "string" && typeof value.type === "string"; }
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function olderCursor(incoming: string, current?: string): boolean { return !!current && /^\d+$/.test(incoming) && /^\d+$/.test(current) && BigInt(incoming) <= BigInt(current); }
function remember(state: SessionProjection, cursor: string): SessionProjection { return cursor ? { ...state, cursor } : state; }

function toolImages(metadata: unknown): string[] {
  return record(metadata) && Array.isArray(metadata.cloudflareImages)
    ? metadata.cloudflareImages.filter((uri): uri is string => typeof uri === "string" && uri.length <= 1_000_030 && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]*={0,2}$/.test(uri))
    : [];
}
