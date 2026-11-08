import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { Plugin } from "@opencode/plugin";
import { Lifecycle } from "agents/lifecycle";
import { OpenCodeHarness } from "agents/harness/opencode";
import { ManagedSession } from "../../src/native/managed-session";

interface ProbeEnv {
  PROVIDER_URL: string;
  ATTEMPTS: DurableObjectNamespace<QuestionRecovery>;
}
interface ProbeReceipt {
  operationId: string;
  formID: string;
  mode: string;
}

/** Real native engine; inference is exclusively a loopback scripted test server. */
export class QuestionRecovery extends DurableObject<ProbeEnv> {
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
                baseURL: this.env.PROVIDER_URL,
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
    throw new Error("Scripted question did not become pending");
  }
  async start(mode: string): Promise<object> {
    if (mode !== "continue" && mode !== "reask")
      throw new Error("Unknown probe mode");
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
    return { form, history: await this.harness.session().history() };
  }
  async afterEviction(): Promise<object> {
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
    return {
      oldFormID: receipt.formID,
      staleRejected,
      replacement,
      answer,
      pending,
      history
    };
  }
  async evict() {
    this.ctx.abort();
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    const mode = url.searchParams.get("mode") ?? "continue";
    const attempt = env.ATTEMPTS.getByName(mode);
    try {
      if (url.pathname === "/start")
        return Response.json(await attempt.start(mode));
      if (url.pathname === "/after")
        return Response.json(await attempt.afterEviction());
      if (url.pathname === "/evict") {
        await attempt.evict();
        return new Response("evicted");
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.stack : String(error) },
        { status: 500 }
      );
    }
  }
};
