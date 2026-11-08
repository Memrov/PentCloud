import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";

type Native = OpenCodeWorkerd.Interface;
/** The embedded native APIs used here; no generic endpoint or credential proxy. */
export interface ManagedSessionAPI {
  sessions: {
    form: Pick<Native["sessions"]["form"], "list" | "reply" | "cancel">;
  };
  permission: Pick<Native["permission"], "list" | "reply">;
  experimental: {
    session: Pick<Native["experimental"]["session"], "stats">;
    usage: Pick<Native["experimental"]["usage"], "limits">;
  };
}
type NativeForm = Awaited<
  ReturnType<Native["sessions"]["form"]["list"]>
>[number];
type NativePermission = Awaited<
  ReturnType<Native["permission"]["list"]>
>[number];
export type PendingForm = Pick<
  NativeForm,
  "id" | "sessionID" | "title" | "fields"
>;
export type PendingPermission = Pick<
  NativePermission,
  "id" | "sessionID" | "action" | "resources" | "message"
>;
export interface SessionPending {
  session: string;
  forms: PendingForm[];
  permissions: PendingPermission[];
}
export interface SessionUsage {
  stats: Awaited<ReturnType<Native["experimental"]["session"]["stats"]>>;
  limits: Awaited<
    ReturnType<Native["experimental"]["usage"]["limits"]>
  >["data"];
  limitsStatus: "available" | "not-connected" | "unavailable";
}
export interface SessionControls extends SessionPending {
  canReply: boolean;
  usage: SessionUsage;
}
export type FormAnswer = Parameters<
  Native["sessions"]["form"]["reply"]
>[0]["answer"];

/** The native SDK owns ephemeral pending/answered state and one-shot replies. */
export class ManagedSession {
  constructor(
    private readonly options: {
      session: string;
      /** Call harness.opencode() afresh: its idle host may have closed. */
      open: () => Promise<ManagedSessionAPI>;
      assertActive: () => Promise<void>;
    }
  ) {}

  async pending(): Promise<SessionPending> {
    const api = await this.options.open();
    const session = this.options.session;
    const [forms, permissions] = await Promise.all([
      api.sessions.form.list({ sessionID: session }),
      api.permission.list({ sessionID: session })
    ]);
    return {
      session,
      forms: forms
        .filter((f) => f.sessionID === session)
        .map(({ id, sessionID, title, fields }) => ({
          id,
          sessionID,
          title,
          fields
        })),
      permissions: permissions
        .filter((p) => p.sessionID === session)
        .map(({ id, sessionID, action, resources, message }) => ({
          id,
          sessionID,
          action,
          resources,
          ...(message === undefined ? {} : { message })
        }))
    };
  }

  async usage(): Promise<SessionUsage> {
    const api = await this.options.open();
    // This host's SQLite belongs to one immutable attempt. No account-wide
    // query options or provider settings are exposed to the operator client.
    const [stats, allowance] = await Promise.all([
      api.experimental.session.stats({ tools: "summary" }),
      api.experimental.usage.limits().then(
        (value) => ({
          limits: value.data,
          limitsStatus: value.data
            ? ("available" as const)
            : ("not-connected" as const)
        }),
        () => ({ limits: null, limitsStatus: "unavailable" as const })
      )
    ]);
    return { stats, ...allowance };
  }

  async replyForm(id: string, raw: unknown): Promise<void> {
    const input = this.input(id, "frm_", raw, ["session", "answer"]);
    if (
      !record(input.answer) ||
      Object.values(input.answer).some(
        (value) =>
          !(
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            (Array.isArray(value) &&
              value.every((item) => typeof item === "string"))
          )
      )
    )
      throw new Error("400: answer must contain native form values");
    const api = await this.form(id);
    await this.mutate(() =>
      api.sessions.form.reply({
        sessionID: this.options.session,
        formID: id,
        answer: input.answer as FormAnswer
      })
    );
  }

  async cancelForm(id: string, raw: unknown): Promise<void> {
    const input = this.input(id, "frm_", raw, ["session", "message"]);
    const message = this.message(input.message);
    const api = await this.form(id);
    await this.mutate(() =>
      api.sessions.form.cancel({
        sessionID: this.options.session,
        formID: id,
        ...(message === undefined ? {} : { message })
      })
    );
  }

  async replyPermission(id: string, raw: unknown): Promise<void> {
    const input = this.input(id, "per", raw, [
      "session",
      "decision",
      "message"
    ]);
    if (input.decision !== "once" && input.decision !== "reject")
      throw new Error("400: decision must be once or reject");
    const decision = input.decision;
    const message = this.message(input.message);
    await this.options.assertActive();
    const api = await this.options.open();
    const pending = await api.permission.list({
      sessionID: this.options.session
    });
    if (
      !pending.some((p) => p.id === id && p.sessionID === this.options.session)
    )
      throw new Error("409: native permission is no longer pending");
    await this.mutate(() =>
      api.permission.reply({
        sessionID: this.options.session,
        requestID: id,
        decision,
        ...(message === undefined ? {} : { message })
      })
    );
  }

  private input(id: string, prefix: string, value: unknown, keys: string[]) {
    if (!new RegExp(`^${prefix}[A-Za-z0-9._~-]{1,250}$`).test(id))
      throw new Error("400: invalid native request identifier");
    if (!record(value) || Object.keys(value).some((key) => !keys.includes(key)))
      throw new Error("400: invalid native reply object");
    if (value.session !== this.options.session)
      throw new Error(
        "409: reply does not match this attempt's native session"
      );
    if (JSON.stringify(value).length > 32000)
      throw new Error("400: native reply exceeds 32000 characters");
    return value;
  }

  private message(value: unknown): string | undefined {
    if (value === undefined) return;
    if (typeof value !== "string" || value.length > 2000)
      throw new Error("400: message must contain at most 2000 characters");
    return value;
  }

  private async form(id: string) {
    await this.options.assertActive();
    const api = await this.options.open();
    if (
      !(await api.sessions.form.list({ sessionID: this.options.session })).some(
        (f) => f.id === id && f.sessionID === this.options.session
      )
    )
      throw new Error("409: native form is no longer pending");
    return api;
  }

  private async mutate(call: () => Promise<void>) {
    // Cancellation may arrive while the native pending lookup is in flight.
    await this.options.assertActive();
    try {
      await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.name : "";
      if (
        /not found|already settled|no longer pending/i.test(message) ||
        /NotFound|AlreadySettled/.test(name)
      )
        throw new Error("409: native request is no longer pending");
      if (
        /invalid.*answer|answer.*invalid/i.test(message) ||
        /FormInvalidAnswer/.test(name)
      )
        throw new Error("400: native form rejected the answer");
      throw error;
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
