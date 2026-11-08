import type {
  OpenCodeSession,
  OpenCodeSessionEvent
} from "agents/harness/opencode";

function ended(value: object) {
  const time: unknown = Reflect.get(value, "time");
  return (
    typeof time === "object" &&
    time !== null &&
    "completed" in time &&
    time.completed !== undefined
  );
}

function safePartialText(
  text: string,
  safe: (value: unknown) => unknown,
  secrets: readonly (string | undefined)[],
  final = false
): string {
  let cut = text.length;
  // Inspect the original prefix: whole-string redaction can erase an opening quote.
  const quoted = [
    /\b[A-Za-z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[A-Za-z0-9_]*\s*=\s*(["'])/gi,
    /"(?:password|token|secret|api_key|authorization)"\s*:\s*(")/gi
  ];
  for (const pattern of quoted)
    for (const match of text.matchAll(pattern)) {
      let escaped = false,
        complete = false;
      for (
        let index = match.index + match[0].length;
        index < text.length;
        index++
      ) {
        const character = text[index];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === match[1]) {
          complete = true;
          break;
        }
      }
      if (!complete) cut = Math.min(cut, match.index);
    }
  const clean = String(
    safe(text.slice(0, cut) + (final && cut < text.length ? "[redacted]" : ""))
  );
  if (final) return clean;
  let end = clean.length;
  for (const secret of secrets) {
    if (!secret) continue;
    for (
      let size = Math.min(secret.length - 1, clean.length);
      size > 0;
      size--
    ) {
      if (clean.endsWith(secret.slice(0, size))) {
        end = Math.min(end, clean.length - size);
        break;
      }
    }
  }
  const url = clean.match(/https?:\/\/[^\s/@]+:[^\s/@]*$/i);
  if (url) end = Math.min(end, url.index!);
  return clean.slice(0, end);
}

/** Transport only: OpenCode owns snapshots, live ordering, reconnect state and the host lease. */
export async function liveSessionResponse(
  session: Pick<OpenCodeSession, "events" | "history">,
  options: {
    signal: AbortSignal;
    safe: (value: unknown) => unknown;
    readInbox: () => Promise<unknown[]>;
    secrets: () => readonly (string | undefined)[];
    onClose: () => void;
  }
): Promise<{ response: Response; done: Promise<void> }> {
  const stream = await session.events();
  const encoder = new TextEncoder();
  const spans = new Map<string, string>(),
    protectedSpans = new Set<string>(),
    pendingSpans: string[] = [];
  for (const message of stream.snapshot.messages) {
    if (message.type !== "assistant") continue;
    const ordinals = { text: 0, reasoning: 0 };
    for (const part of message.content)
      if (part.type === "text" || part.type === "reasoning") {
        const key = `${message.id}:${part.type}:${ordinals[part.type]++}`;
        protectedSpans.add(key);
        // OpenCode persists Started as empty and Ended as full text, with no live-delta offset.
        if (!ended(message) && part.text === "") pendingSpans.push(key);
      }
  }
  let closed = false,
    controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      closed = true;
      options.signal.removeEventListener("abort", abort);
      try {
        await stream.stop();
      } finally {
        spans.clear();
        protectedSpans.clear();
        options.onClose();
        resolveDone();
      }
    })());
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    if (error) controller?.error(error);
    else controller?.close();
    void stop().catch(() => {});
  };
  const abort = () => finish();
  const send = (kind: string, value: unknown) => {
    if (!closed)
      controller!.enqueue(
        encoder.encode(
          `event: ${kind}\ndata: ${JSON.stringify(options.safe(value))}\n\n`
        )
      );
  };
  try {
    const inbox = await options.readInbox();
    let queued = Promise.resolve();
    const body = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) {
          finish();
          return;
        }
        const messages = stream.snapshot.messages.map((message) =>
          message.type === "assistant"
            ? {
                ...message,
                content: message.content.map((part) =>
                  part.type === "text" || part.type === "reasoning"
                    ? {
                        ...part,
                        text: safePartialText(
                          part.text,
                          options.safe,
                          options.secrets(),
                          true
                        )
                      }
                    : part
                )
              }
            : message
        );
        send("snapshot", {
          ...stream.snapshot,
          messages,
          pending: inbox,
          pendingSpans,
          cursor: ""
        });
        stream.start((events) => {
          queued = queued
            .then(async () => {
              for (const event of events) {
                if (closed) return;
                let enriched: OpenCodeSessionEvent & Record<string, unknown> = {
                  ...event
                };
                if (
                  event.type === "text_delta" ||
                  event.type === "reasoning_delta"
                ) {
                  const key = `${event.messageId}:${event.type.split("_")[0]}:${event.ordinal}`;
                  if (protectedSpans.has(key)) continue;
                  const text = (spans.get(key) ?? "") + event.delta;
                  spans.set(key, text);
                  enriched = {
                    ...event,
                    delta: "",
                    text: safePartialText(text, options.safe, options.secrets())
                  };
                }
                if (
                  event.type === "text_end" ||
                  event.type === "reasoning_end"
                ) {
                  const key = `${event.messageId}:${event.type.split("_")[0]}:${event.ordinal}`;
                  spans.delete(key);
                  protectedSpans.add(key);
                  enriched = {
                    ...event,
                    text: safePartialText(
                      event.text,
                      options.safe,
                      options.secrets(),
                      true
                    )
                  };
                }
                if (event.type === "message_end")
                  for (const key of spans.keys())
                    if (key.startsWith(event.messageId + ":"))
                      spans.delete(key);
                if (event.type === "operation_queued")
                  enriched.inbox = await options.readInbox();
                if (event.type === "operation_start")
                  enriched.nativeMessage = (await session.history()).find(
                    (message) => message.id === `msg_${event.operationId}`
                  );
                if (event.type === "tool_end") {
                  const message = (await session.history()).find(
                    (message) => message.id === event.messageId
                  );
                  if (message?.type === "assistant")
                    enriched.nativeTool = message.content.find(
                      (part) =>
                        part.type === "tool" && part.id === event.toolCallId
                    );
                }
                send("live", enriched);
                if (event.type === "fault" && event.code === "events_failed") {
                  finish(new Error(event.message));
                  return;
                }
              }
            })
            .catch((error) => finish(error));
        });
      },
      cancel() {
        return stop();
      }
    });
    return {
      response: new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no"
        }
      }),
      done
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
