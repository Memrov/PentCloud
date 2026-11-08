import {
  Banner,
  Button,
  Checkbox,
  Collapsible,
  Input,
  InputArea,
  LayerCard,
  Select,
  Text
} from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { FormAnswer, PendingForm } from "../../native/managed-session";
import {
  answerNativeForm,
  APIError,
  cancelNativeForm,
  getSessionControls,
  replyNativePermission,
  type UISessionControls
} from "../api";
import { ExternalLink } from "./external-link";

/** A view of OpenCode's pending requests, never a second approvals queue. */
export function NativeSessionControls({
  jobId,
  running,
  controlsRevision = 0,
  onAttention
}: {
  jobId: string;
  running: boolean;
  controlsRevision?: number;
  onAttention?: (needed: boolean) => void;
}) {
  const [controls, setControls] = useState<UISessionControls>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await getSessionControls(jobId);
        if (!disposed) {
          setControls(value);
          setError(undefined);
        }
      } catch (caught) {
        if (!disposed && !(caught instanceof APIError && caught.status === 404))
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not read session controls"
          );
      } finally {
        if (!disposed && running)
          timer = setTimeout(() => void refresh(), 10000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, running, controlsRevision]);
  useEffect(() => {
    if (controls)
      onAttention?.(
        running &&
          controls.canReply &&
          (controls.forms.length > 0 || controls.permissions.length > 0)
      );
  }, [controls, running, onAttention]);

  const reply = async (action: () => Promise<void>) => {
    if (!controls?.canReply || !running || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Native reply failed"
      );
    } finally {
      try {
        setControls(await getSessionControls(jobId));
      } catch {
        /* The next refresh can recover if the session just closed. */
      }
      setBusy(false);
    }
  };
  if (!controls)
    return error ? (
      <Banner variant="error" role="status" description={error} />
    ) : null;
  const disabled = busy || !running || !controls.canReply;
  return (
    <section
      className="native-controls grid max-h-[32vh] gap-3 overflow-auto text-base"
      aria-label="Native session controls"
    >
      {running &&
        controls.canReply &&
        (controls.forms.length > 0 || controls.permissions.length > 0) && (
          <Banner
            variant="alert"
            title="Needs your answer"
            description="This agent is waiting for a question or permission below."
          />
        )}
      {controls.forms.map((form) => (
        <NativeQuestion
          key={form.id}
          form={form}
          disabled={disabled}
          onAnswer={(answer) =>
            void reply(() =>
              answerNativeForm(jobId, controls.session, form.id, answer)
            )
          }
          onCancel={() =>
            void reply(() => cancelNativeForm(jobId, controls.session, form.id))
          }
        />
      ))}
      {controls.permissions.map((permission) => (
        <LayerCard
          className="overflow-visible grid gap-3 rounded-lg px-4 py-3 ring ring-kumo-line"
          key={permission.id}
        >
          <Text bold>Permission requested: {permission.action}</Text>
          {permission.message && <p>{permission.message}</p>}
          <ul>
            {permission.resources.map((resource, i) => (
              <li key={i}>
                <code>{resource}</code>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={disabled}
              onClick={() =>
                void reply(() =>
                  replyNativePermission(
                    jobId,
                    controls.session,
                    permission.id,
                    "once"
                  )
                )
              }
            >
              Allow once
            </Button>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                void reply(() =>
                  replyNativePermission(
                    jobId,
                    controls.session,
                    permission.id,
                    "reject"
                  )
                )
              }
            >
              Reject
            </Button>
          </div>
        </LayerCard>
      ))}
      {error && <Banner variant="error" role="alert" description={error} />}
      <Collapsible className="native-usage">
        <Collapsible.DefaultTrigger>Usage</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel className="grid gap-2">
          <p>
            {controls.usage.stats.steps.toLocaleString()} steps ·{" "}
            {controls.usage.stats.tokens.input.toLocaleString()} input /{" "}
            {controls.usage.stats.tokens.output.toLocaleString()} output tokens
          </p>
          <p>
            {controls.usage.stats.tools.mode === "summary"
              ? `${controls.usage.stats.tools.totals.calls} tool calls · ${controls.usage.stats.tools.totals.failed} failed`
              : "Native session statistics"}
          </p>
          <p>
            Cost estimate:{" "}
            {controls.usage.stats.cost > 0
              ? `$${controls.usage.stats.cost.toFixed(4)}`
              : "unavailable for this model configuration"}
            .
          </p>
          {controls.usage.limits?.go ? (
            <p>
              OpenCode Go allowance used: rolling{" "}
              {controls.usage.limits.go.rolling.percent}% · weekly{" "}
              {controls.usage.limits.go.weekly.percent}% · monthly{" "}
              {controls.usage.limits.go.monthly.percent}%.
            </p>
          ) : (
            <p>
              Account allowance{" "}
              {controls.usage.limitsStatus === "unavailable"
                ? "temporarily unavailable"
                : controls.usage.limitsStatus === "available"
                  ? "not supplied for this connection"
                  : "unavailable without an OpenCode Console connection"}
              .
            </p>
          )}
          {controls.usage.limits?.budgets.map((budget, i) => (
            <p key={budget.id}>
              Budget {i + 1}: ${budget.spent.toFixed(2)} of $
              {budget.limit.toFixed(2)} used.
            </p>
          ))}
        </Collapsible.DefaultPanel>
      </Collapsible>
    </section>
  );
}

export function NativeQuestion({
  form,
  disabled,
  onAnswer,
  onCancel
}: {
  form: PendingForm;
  disabled: boolean;
  onAnswer: (answer: FormAnswer) => void;
  onCancel: () => void;
}) {
  const [answer, setAnswer] = useState<FormAnswer>(() =>
    Object.fromEntries(
      form.fields.flatMap((field) =>
        field.type !== "external" && field.default !== undefined
          ? [[field.key, field.default]]
          : []
      )
    )
  );
  const [customFields, setCustomFields] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        form.fields.flatMap((field) =>
          field.type === "string" &&
          field.custom &&
          typeof field.default === "string" &&
          !field.options?.some((option) => option.value === field.default)
            ? [[field.key, true]]
            : []
        )
      )
  );
  const change = (key: string, value: FormAnswer[string] | undefined) =>
    setAnswer((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  return (
    <form
      className="native-request grid gap-3 rounded-lg px-4 py-3 ring ring-kumo-line"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(answerForForm(form, answer));
      }}
    >
      <Text bold>{form.title}</Text>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4">
        {form.fields.map((field) => {
          const label = field.title ?? field.key;
          const value = answer[field.key];
          const selected: string[] = Array.isArray(value) ? value : [];
          if (field.type === "external")
            return (
              <div className="grid gap-2" key={field.key}>
                <ExternalLink href={field.url}>{label}</ExternalLink>
                {field.description && (
                  <Text variant="secondary">{field.description}</Text>
                )}
                <Checkbox
                  label="I completed this step"
                  required
                  checked={value === true}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    change(field.key, checked ? true : undefined)
                  }
                />
              </div>
            );
          if (!fieldShown(field, answer)) return null;
          const id = `${form.id}-${field.key}`;
          let input;
          if (field.type === "boolean")
            input = (
              <Select
                label={label}
                description={field.description}
                required={!!field.required}
                disabled={disabled}
                value={value === undefined ? null : String(value)}
                placeholder="Choose…"
                onValueChange={(next) =>
                  change(field.key, next === null ? undefined : next === "true")
                }
              >
                <Select.Option value="true">Yes</Select.Option>
                <Select.Option value="false">No</Select.Option>
              </Select>
            );
          else if (field.type === "multiselect")
            input = (
              <>
                <Select
                  multiple
                  label={label}
                  description={field.description}
                  required={!!field.required && selected.length === 0}
                  disabled={disabled}
                  value={selected.filter((item) =>
                    field.options.some((option) => option.value === item)
                  )}
                  placeholder="Choose…"
                  onValueChange={(next: string[]) =>
                    change(field.key, [
                      ...next,
                      ...selected.filter(
                        (item) =>
                          !field.options.some((option) => option.value === item)
                      )
                    ])
                  }
                >
                  {field.options.map((option) => (
                    <Select.Option key={option.value} value={option.value}>
                      {option.label}
                    </Select.Option>
                  ))}
                </Select>
                {field.custom && (
                  <InputArea
                    aria-label={`${label} custom choices`}
                    placeholder="Custom choices, one per line"
                    disabled={disabled}
                    value={selected
                      .filter(
                        (item) =>
                          !field.options.some((option) => option.value === item)
                      )
                      .join("\n")}
                    onValueChange={(text) =>
                      change(field.key, [
                        ...selected.filter((item) =>
                          field.options.some((option) => option.value === item)
                        ),
                        ...text.split("\n").filter(Boolean)
                      ])
                    }
                  />
                )}
              </>
            );
          else if (field.type === "number" || field.type === "integer")
            input = (
              <Input
                id={id}
                label={label}
                description={field.description}
                type="number"
                disabled={disabled}
                required={!!field.required}
                step={field.type === "integer" ? 1 : "any"}
                min={
                  typeof field.minimum === "number" ? field.minimum : undefined
                }
                max={
                  typeof field.maximum === "number" ? field.maximum : undefined
                }
                value={typeof value === "number" ? value : ""}
                onChange={(event) =>
                  change(
                    field.key,
                    event.target.value === ""
                      ? undefined
                      : event.target.valueAsNumber
                  )
                }
              />
            );
          else if (field.options) {
            let customValue = "__pentcloud_custom__";
            while (field.options.some((option) => option.value === customValue))
              customValue += "_";
            input = (
              <>
                <Select
                  label={label}
                  description={field.description}
                  required={!!field.required}
                  disabled={disabled}
                  value={
                    customFields[field.key]
                      ? customValue
                      : typeof value === "string"
                        ? value
                        : null
                  }
                  placeholder="Choose…"
                  onValueChange={(next) => {
                    const custom = next === customValue;
                    setCustomFields((current) => ({
                      ...current,
                      [field.key]: custom
                    }));
                    change(
                      field.key,
                      custom || next === null ? undefined : next
                    );
                  }}
                >
                  {field.options.map((option) => (
                    <Select.Option key={option.value} value={option.value}>
                      {option.label}
                    </Select.Option>
                  ))}
                  {field.custom && (
                    <Select.Option value={customValue}>
                      Type your own answer
                    </Select.Option>
                  )}
                </Select>
                {field.custom && customFields[field.key] && (
                  <Input
                    aria-label={`${label} custom answer`}
                    type={
                      field.format === "email"
                        ? "email"
                        : field.format === "uri"
                          ? "url"
                          : field.format === "date"
                            ? "date"
                            : "text"
                    }
                    disabled={disabled}
                    required={!!field.required}
                    placeholder={field.placeholder}
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    pattern={field.pattern}
                    value={typeof value === "string" ? value : ""}
                    onValueChange={(next) => change(field.key, next)}
                  />
                )}
              </>
            );
          } else
            input = (
              <Input
                id={id}
                label={label}
                description={field.description}
                type={
                  field.format === "email"
                    ? "email"
                    : field.format === "uri"
                      ? "url"
                      : field.format === "date"
                        ? "date"
                        : "text"
                }
                required={!!field.required}
                disabled={disabled}
                placeholder={field.placeholder}
                minLength={field.minLength}
                maxLength={field.maxLength}
                pattern={field.pattern}
                value={typeof value === "string" ? value : ""}
                onValueChange={(next) => change(field.key, next)}
              />
            );
          return (
            <div className="grid min-w-0 gap-2" key={field.key}>
              {input}
              {"options" in field &&
                field.options?.some((option) => option.description) && (
                  <ul className="grid gap-1 text-base text-kumo-subtle">
                    {field.options
                      .filter((option) => option.description)
                      .map((option) => (
                        <li key={option.value}>
                          {option.label}: {option.description}
                        </li>
                      ))}
                  </ul>
                )}
            </div>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={disabled}>
          Send answer
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={onCancel}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

export function fieldShown(
  field: PendingForm["fields"][number],
  answer: FormAnswer
): boolean {
  if (field.type === "external") return true;
  return !field.hidden && fieldActive(field, answer);
}
function fieldActive(
  field: Exclude<PendingForm["fields"][number], { type: "external" }>,
  answer: FormAnswer
): boolean {
  return (field.when ?? []).every((condition) => {
    const value = answer[condition.key];
    if (value === undefined) return false;
    const matches = Array.isArray(value)
      ? value.includes(String(condition.value))
      : value === condition.value;
    return condition.op === "eq" ? matches : !matches;
  });
}
export function answerForForm(
  form: PendingForm,
  answer: FormAnswer
): FormAnswer {
  const output: Record<string, FormAnswer[string]> = {};
  for (const field of form.fields) {
    const value = answer[field.key];
    if (
      value !== undefined &&
      (field.type === "external" || fieldActive(field, answer))
    )
      output[field.key] = value;
  }
  return output;
}
