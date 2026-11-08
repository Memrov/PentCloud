// Chat presentation adapted from cloudflare/agents-starter, commit 4ea6a72.
// MIT (c) 2025 Cloudflare Inc. Full notice: docs/third-party-notices.md.
// OpenCode remains the session authority; these are read-only projected parts.
import {
  Badge,
  Banner,
  Collapsible,
  Loader,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  BrainIcon,
  CheckCircleIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type { ChatMessage, ChatPart } from "../presentation";
import type { ChatTurn } from "../chat-transcript";
import { chatActivity, isPublicationFence, toolLabel } from "../chat-activity";
import { ChatMarkdown } from "./chat-markdown";

export function ChatResponse({
  turn,
  name,
  active,
  activity
}: {
  turn: ChatTurn;
  name: string;
  active: boolean;
  activity: ReturnType<typeof chatActivity>;
}) {
  if (turn.role === "user")
    return (
      <article className="message-row message-user flex justify-end">
        <Surface className="message-body max-w-[85%] rounded-xl px-4 py-3 ring ring-kumo-line">
          {turn.messages.flatMap((message) =>
            message.parts.map((part, i) => (
              <PartView key={`${message.id}:${part.id ?? i}`} part={part} />
            ))
          )}
        </Surface>
      </article>
    );
  const prose = turn.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts.filter((part) => part.type === "text"));
  const text = prose
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n\n");
  const streaming =
    active &&
    prose.some((part) => part.type === "text" && part.state === "streaming");
  // Native part IDs are local to a message (for example reasoning:0).
  // Grouping steps into one response must retain that message identity.
  const details = turn.messages.flatMap<{
    key: string;
    message?: ChatMessage;
    part?: ChatPart;
  }>((message) =>
    message.role === "system"
      ? [{ key: `instructions:${message.id}`, message }]
      : message.parts.flatMap((part, index) =>
          part.type === "reasoning" || part.type === "dynamic-tool"
            ? [{ key: `${message.id}:${part.id ?? index}`, part }]
            : []
        )
  );
  const errors = turn.messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "data-status")
  );
  const tools = details.filter(
    (detail) => detail.part?.type === "dynamic-tool"
  ).length;
  const failures = details.filter(
    (detail) =>
      detail.part?.type === "dynamic-tool" &&
      detail.part.state === "output-error" &&
      !isPublicationFence(detail.part.errorText)
  ).length;
  if (!text && !details.length && !errors.length && !active) return null;
  return (
    <article
      className="message-row message-assistant min-w-0 py-2"
      aria-label={`${name} response`}
    >
      <div className="message-body grid min-w-0 gap-2">
        {text && (
          <div className="prose-block">
            <ChatMarkdown streaming={streaming}>{text}</ChatMarkdown>
          </div>
        )}
        {details.length > 0 ? (
          <Collapsible className="response-activity">
            <Collapsible.DefaultTrigger>
              <span className="flex items-center gap-2 text-base">
                {active && <span className="sr-only">Activity: </span>}
                {active && activity.working ? (
                  <Loader size="sm" />
                ) : (
                  <CheckCircleIcon size={15} />
                )}
                <span>{active ? activity.label : "Activity"}</span>
                {tools > 0 && (
                  <Text as="span" variant="secondary">
                    {tools} {tools === 1 ? "tool" : "tools"}
                  </Text>
                )}
                {failures > 0 && (
                  <Badge variant="error" className="text-base">
                    {failures} failed
                  </Badge>
                )}
              </span>
            </Collapsible.DefaultTrigger>
            <Collapsible.DefaultPanel className="grid gap-2">
              {details.map((detail) =>
                detail.message ? (
                  <Collapsible
                    className="reasoning-card instructions-card"
                    key={detail.key}
                  >
                    <Collapsible.DefaultTrigger>
                      Agent instructions
                    </Collapsible.DefaultTrigger>
                    <Collapsible.DefaultPanel>
                      {detail.message.parts.map((part, i) => (
                        <PartView key={i} part={part} />
                      ))}
                    </Collapsible.DefaultPanel>
                  </Collapsible>
                ) : (
                  <PartView key={detail.key} part={detail.part!} />
                )
              )}
            </Collapsible.DefaultPanel>
          </Collapsible>
        ) : (
          active &&
          !text && (
            <div className="flex items-center gap-2">
              <Loader size="sm" />
              <Text variant="secondary">{activity.label}</Text>
            </div>
          )
        )}
        {errors.map((part, index) => (
          <PartView key={index} part={part} />
        ))}
      </div>
    </article>
  );
}

function PartView({ part }: { part: ChatPart }) {
  if (part.type === "text")
    return (
      <div className="prose-block">
        <ChatMarkdown>{part.text}</ChatMarkdown>
      </div>
    );
  if (part.type === "reasoning")
    return (
      <Collapsible className="reasoning-card">
        <Collapsible.DefaultTrigger>
          <span className="flex items-center gap-2 text-base">
            <BrainIcon size={15} /> Reasoning{" "}
            {part.state === "streaming" && <Loader size="sm" />}
          </span>
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <ChatMarkdown>{part.text}</ChatMarkdown>
        </Collapsible.DefaultPanel>
      </Collapsible>
    );
  if (part.type === "dynamic-tool") {
    const complete = part.state === "output-available";
    const failed = part.state === "output-error";
    const settling = failed && isPublicationFence(part.errorText);
    return (
      <Collapsible className="tool-card min-w-0">
        <Collapsible.DefaultTrigger>
          <span className="flex items-center gap-2">
            {complete ? (
              <CheckCircleIcon size={15} />
            ) : settling || !failed ? (
              <Loader size="sm" />
            ) : (
              <WarningCircleIcon size={15} />
            )}
            <Text as="span">
              {toolLabel(part.toolName).replace(/^Using /, "")}
            </Text>
            <Badge
              variant={failed && !settling ? "error" : "secondary"}
              className="text-base"
            >
              {part.recovered
                ? "Accepted"
                : complete
                  ? "Done"
                  : settling
                    ? "Updating status"
                    : failed
                      ? "Error"
                      : "Running"}
            </Badge>
          </span>
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel className="grid min-w-0 gap-3">
          <Text variant="secondary">Tool: {part.toolName}</Text>
          {part.recovered && (
            <Text variant="secondary">
              Result accepted after the tool response was interrupted.
            </Text>
          )}
          {"input" in part && <ToolValue label="Input" value={part.input} />}
          {complete && <ToolValue label="Output" value={part.output} />}
          {complete &&
            part.images?.map((uri, index) => (
              <img
                key={index}
                src={uri}
                alt="Cloudflare browser screenshot"
                style={{ maxWidth: "100%", height: "auto" }}
                loading="lazy"
              />
            ))}
          {failed && <ToolValue label="Error" value={part.errorText} />}
        </Collapsible.DefaultPanel>
      </Collapsible>
    );
  }
  if (part.type === "data-status") {
    const data = part.data as { status?: string; error?: string };
    const settling = isPublicationFence(data.error);
    return (
      <Banner
        variant={settling ? "secondary" : "error"}
        icon={settling ? <Loader size="sm" /> : <WarningCircleIcon size={16} />}
        title={settling ? "Updating agent status" : (data.status ?? "Status")}
        description={
          settling ? "Waiting for the run to reconcile the result." : data.error
        }
      />
    );
  }
  return null;
}

function ToolValue({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="grid min-w-0 gap-1">
      <Text variant="secondary">{label}</Text>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-base text-kumo-subtle">
        {text}
      </pre>
    </div>
  );
}
