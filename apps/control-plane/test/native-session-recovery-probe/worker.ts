import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { Plugin } from "@opencode/plugin";
import { Lifecycle } from "agents/lifecycle";
import { OpenCodeHarness } from "agents/harness/opencode";
import { ManagedSession } from "../../src/native/managed-session";
import { SCRIPTED_MODEL_URL } from "./scripted-model";

/** Plain results, so tests do not depend on the SDK's deep form types. */
export interface QuestionStarted {
  formID: string;
  customAnswerAllowed: boolean;
}
export interface QuestionRecovered {
  staleRejected: boolean;
  replacementFormID?: string;
  status: string;
  text: string;
  pendingForms: number;
  history: string;
}

interface ProbeReceipt {
  operationId: string;
  formID: string;
  mode: "continue" | "reask";
}

/** Real native engine; the test runner answers inference with a scripted model. */
export class QuestionRecovery extends DurableObject<Cloudflare.Env> {
  readonly plugin = Plugin.define({
    id: "test.question-recovery",
    setup: async (ctx) => {
      await ctx.agent.transform((editor) =>
        editor.update("build", (agent) => {
          agent.system =
            "This is a local question recovery test. Use only the question tool.";
          agent.permissions = [
            { action: "*", resource: "*", effect: "deny" },
            { action: "question", resource: "*", effect: "allow" }
          ];
        })
      );
      await ctx.tool.transform((editor) => {
        for (const tool of editor.list())
          if (tool.name !== "question") editor.remove(tool.id);
      });
      await ctx.session.hook("title", (request) => {
        request.result = "Local question recovery probe";
      });
    }
  });
  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({
        storage,
        models: { fetch: false, snapshot: false },
        plugins: [this.plugin],
        config: {
          default_agent: "build",
          providers: {
            fixture: {
              package: "@opencode/ai/providers/openai-compatible",
              settings: {
                baseURL: SCRIPTED_MODEL_URL,
                apiKey: "local-scripted-fixture"
              },
              models: {
                "question-fixture": {
                  name: "Local scripted question fixture",
                  capabilities: { tools: true },
                  limit: { context: 128000, output: 1024 }
                }
              }
            }
          }
        }
      }),
    defaults: {
      agent: "build",
      model: { providerID: "fixture", id: "question-fixture" }
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  private managed() {
    return new ManagedSession({
      session: this.harness.session().id,
      open: () => this.harness.opencode(),
      assertActive: async () => {}
    });
  }
  private async forms() {
    return (await this.harness.opencode()).sessions.form.list({
      sessionID: this.harness.session().id
    });
  }
  private async question() {
    for (let i = 0; i < 300; i++) {
      const forms = await this.forms();
      if (forms.length) return forms[0]!;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Scripted question did not become pending: ${JSON.stringify({
        pending: await this.harness.pending(),
        history: await this.harness.session().history()
      }).slice(0, 4000)}`
    );
  }

  /** Submit a turn and return once its question is pending. */
  async start(mode: ProbeReceipt["mode"]): Promise<QuestionStarted> {
    await this.lifecycle.start();
    const receipt = await this.harness.submit(
      `RECOVERY_MODE=${mode}. Ask for the missing approach.`,
      { operationId: "question-recovery" }
    );
    const form = await this.question();
    // Test evidence only: never used as a substitute for native pending state.
    await this.ctx.storage.put("probe-receipt", {
      operationId: receipt.operationId,
      formID: form.id,
      mode
    } satisfies ProbeReceipt);
    const [field] = form.fields as Array<{ custom?: boolean }>;
    return { formID: form.id, customAnswerAllowed: field?.custom === true };
  }

  /** After a crash: reply to the lost form, then let the turn finish. */
  async afterCrash(): Promise<QuestionRecovered> {
    const receipt = await this.ctx.storage.get<ProbeReceipt>("probe-receipt");
    if (!receipt) throw new Error("Missing probe evidence");
    await this.lifecycle.start();
    let staleRejected = false;
    try {
      await this.managed().replyForm(receipt.formID, {
        session: this.harness.session().id,
        answer: { q0: "Focused" }
      });
    } catch (error) {
      staleRejected = String(error).includes("409:");
    }
    let replacement;
    if (receipt.mode === "reask") {
      replacement = await this.question();
      await this.managed().replyForm(replacement.id, {
        session: this.harness.session().id,
        answer: { q0: "Focused" }
      });
    }
    const answer = await this.harness.wait(receipt.operationId, {
      signal: AbortSignal.timeout(10000)
    });
    const pending = await this.forms();
    const history = await this.harness.session().history();
    await this.harness.dispose();
    await this.ctx.storage.deleteAlarm();
    const { status, text } = answer as { status: string; text?: string };
    return {
      staleRejected,
      ...(replacement ? { replacementFormID: replacement.id } : {}),
      status,
      text: text ?? "",
      pendingForms: pending.length,
      history: JSON.stringify(history)
    };
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 })
} satisfies ExportedHandler;
