import type { UISettingsModel } from "../ui/settings/model";
import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { Plugin } from "@opencode/plugin";
export type OpenCodeRoute = "go" | "console";
export type ModelAdapter =
  | "chat-completions"
  | "responses"
  | "messages"
  | "generate-content";
export interface OpenCodeByokProvider {
  connectionId: string;
  name: string;
  models: string[];
}
const connectionPattern = /^conn_[A-Za-z0-9]{1,80}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,180}$/;
/** Deployment metadata only. Provider credentials remain inside OpenCode. */
export function parseByokProviders(
  raw: string | undefined
): OpenCodeByokProvider[] {
  if (raw === undefined) return [];
  try {
    if (raw.length > 16000) throw new Error();
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 8) throw new Error();
    const ids = new Set<string>();
    return rows.map((row) => {
      if (
        !object(row) ||
        typeof row.connectionId !== "string" ||
        !connectionPattern.test(row.connectionId) ||
        ids.has(row.connectionId) ||
        typeof row.name !== "string" ||
        !row.name.trim() ||
        row.name.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(row.name) ||
        !Array.isArray(row.models) ||
        !row.models.length ||
        row.models.length > 32 ||
        row.models.some(
          (m: unknown) => typeof m !== "string" || !modelPattern.test(m)
        ) ||
        new Set(row.models).size !== row.models.length
      )
        throw new Error();
      ids.add(row.connectionId);
      return {
        connectionId: row.connectionId,
        name: row.name.trim(),
        models: [...row.models]
      };
    });
  } catch {
    throw new Error("503: OpenCode BYOK configuration is invalid");
  }
}
export interface OpenCodeModel extends UISettingsModel {
  modelId: string;
  route: OpenCodeRoute;
  adapter: ModelAdapter;
  package: string;
  baseURL: string;
  outputLimit: number;
  compatibility?: Record<string, unknown>;
  connectionId?: string;
}
export interface PinnedModel extends OpenCodeModel {
  credentialFingerprint?: string;
  credentialId: string;
  credentialVersion: number;
  catalogDigest: string;
  testedAt: number;
}
const adapters: Record<ModelAdapter, { package: string; path: string }> = {
  "chat-completions": {
    package: "@opencode/ai/providers/openai-compatible",
    path: "openai/v1"
  },
  responses: { package: "@opencode/ai/providers/openai", path: "openai/v1" },
  messages: {
    package: "@opencode/ai/providers/anthropic",
    path: "anthropic/v1"
  },
  "generate-content": {
    package: "@opencode/ai/providers/google",
    path: "google/v1beta"
  }
};
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function normalizeCatalog(
  raw: unknown,
  route: OpenCodeRoute,
  byok: OpenCodeByokProvider[] = []
): OpenCodeModel[] {
  if (!object(raw) || !Array.isArray(raw.data))
    throw new Error("503: OpenCode model catalog is invalid");
  const models: OpenCodeModel[] = [];
  for (const row of raw.data) {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._~/-]{0,180}$/.test(row.id) ||
      row.type !== "chat" ||
      row.capabilities?.tools?.supported !== true ||
      !object(row.api)
    )
      continue;
    for (const [adapter, transport] of Object.entries(row.api)) {
      const mapping = adapters[adapter as ModelAdapter];
      if (!mapping || !object(transport)) continue;
      const baseURL =
        "https://opencode.ai/inference/" +
        (route === "go" ? "go/" : "") +
        mapping.path;
      if (transport.base_url !== baseURL) continue;
      const provider = route === "go" ? "opencode-go" : "opencode";
      const effort = Array.isArray(row.capabilities?.reasoning?.effort)
        ? row.capabilities.reasoning.effort.filter((x: unknown) =>
            ["low", "medium", "high", "xhigh", "max", "ultra"].includes(
              String(x)
            )
          )
        : [];
      models.push({
        id: provider + ":" + row.id,
        modelId: row.id,
        name: typeof row.name === "string" ? row.name : row.id,
        provider,
        route,
        adapter: adapter as ModelAdapter,
        package: mapping.package,
        baseURL,
        contextLength: Math.min(
          Math.max(Number(row.limit?.context) || 128000, 1024),
          2000000
        ),
        outputLimit: Math.min(
          Math.max(Number(row.limit?.output) || 8192, 256),
          65536
        ),
        inputModalities: Array.isArray(row.modalities?.input)
          ? row.modalities.input.filter((v: unknown) => typeof v === "string")
          : ["text"],
        outputModalities: ["text"],
        supportedParameters: [],
        reasoningEfforts: ["default", ...effort],
        ...(object(transport.compatibility)
          ? { compatibility: transport.compatibility }
          : {})
      });
      break;
    }
  }
  if (route === "console")
    for (const provider of byok)
      for (const modelId of provider.models) {
        const model = models.find(
          (m) => !m.connectionId && m.modelId === modelId
        );
        if (!model)
          throw new Error(
            "503: Configured OpenCode BYOK model metadata is unavailable"
          );
        models.push({
          ...model,
          id: `opencode:byok/${provider.connectionId}/${modelId}`,
          name: `${provider.name} BYOK · ${model.name}`,
          connectionId: provider.connectionId,
          baseURL: `https://opencode.ai/inference/custom/${provider.connectionId}`
        });
      }
  return models;
}
export function assertPinnedModel(model: PinnedModel): void {
  const mapping = adapters[model.adapter];
  const byok = model.connectionId !== undefined;
  const validConnection =
    !byok ||
    (typeof model.connectionId === "string" &&
      connectionPattern.test(model.connectionId) &&
      model.route === "console");
  const expectedId = byok
    ? `opencode:byok/${model.connectionId}/${model.modelId}`
    : model.provider + ":" + model.modelId;
  const expectedURL = byok
    ? `https://opencode.ai/inference/custom/${model.connectionId}`
    : "https://opencode.ai/inference/" +
      (model.route === "go" ? "go/" : "") +
      mapping?.path;
  if (
    model.credentialFingerprint !== undefined &&
    !/^[a-f0-9]{64}$/.test(model.credentialFingerprint)
  )
    throw new Error("400: Invalid pinned credential fingerprint");
  if (
    !mapping ||
    model.package !== mapping.package ||
    !["go", "console"].includes(model.route) ||
    !validConnection ||
    typeof model.modelId !== "string" ||
    !modelPattern.test(model.modelId) ||
    model.provider !== (model.route === "go" ? "opencode-go" : "opencode") ||
    model.id !== expectedId ||
    model.baseURL !== expectedURL ||
    !Number.isSafeInteger(model.credentialVersion) ||
    !model.credentialId ||
    !/^[a-f0-9]{64}$/.test(model.catalogDigest)
  )
    throw new Error("400: Invalid pinned OpenCode configuration");
}
type NativeProvider = NonNullable<
  OpenCodeWorkerd.Configuration["providers"]
>[string];
type NativeCompatibility = NonNullable<
  NonNullable<NativeProvider["models"]>[string]["compatibility"]
>;
/** Translate the inference catalog's wire names to OpenCode v2 configuration. */
function nativeCompatibility(
  raw: Record<string, unknown> = {}
): NativeCompatibility {
  const value: {
    -readonly [K in keyof NativeCompatibility]: NativeCompatibility[K];
  } = {};
  if (typeof raw.reasoning_field === "string")
    value.reasoningField = raw.reasoning_field;
  if (
    raw.max_tokens_field === "max_tokens" ||
    raw.max_tokens_field === "max_completion_tokens"
  )
    value.maxTokensField = raw.max_tokens_field;
  if (raw.cache_format === "anthropic" || raw.cache_format === "alibaba")
    value.cacheFormat = raw.cache_format;
  if (
    raw.media_input === "assets" ||
    raw.media_input === "state" ||
    raw.media_input === "root"
  )
    value.mediaInput = raw.media_input;
  for (const [wire, key] of Object.entries({
    require_reasoning: "requireReasoning",
    require_finish_reason: "requireFinishReason",
    require_assistant_after_tool: "requireAssistantAfterTool",
    supports_prompt_cache_key: "supportsPromptCacheKey",
    stream_usage: "streamUsage",
    supports_thinking_block_binding: "supportsThinkingBlockBinding",
    supports_effort_updates: "supportsEffortUpdates"
  } as const))
    if (typeof raw[wire] === "boolean")
      (value as Record<string, unknown>)[key] = raw[wire];
  return value;
}
/** One provider configuration for both connection tests and actual attempts. */
export function nativeProvider(
  model: OpenCodeModel,
  key: string
): NativeProvider {
  return {
    name: model.connectionId
      ? "OpenCode Console BYOK"
      : model.route === "go"
        ? "OpenCode Go"
        : "OpenCode Console",
    package: model.package,
    settings: { baseURL: model.baseURL, apiKey: key, timeout: 120000 },
    models: {
      [model.modelId]: {
        name: model.name,
        compatibility: nativeCompatibility(model.compatibility),
        capabilities: { tools: true },
        limit: {
          context: model.contextLength ?? 128000,
          output: model.outputLimit
        }
      }
    }
  };
}
/** Register the pinned provider in the embedded host, without a global catalog. */
export function nativeModelPlugin(model: OpenCodeModel) {
  return Plugin.define({
    id: "pentcloud.pinned-model",
    async setup(ctx) {
      await ctx.provider.transform((providers) => {
        for (const entry of providers.list())
          if (entry.provider.id !== model.provider)
            providers.remove(entry.provider.id);
        providers.update(model.provider, (provider) => {
          provider.activation = "enabled";
        });
        providers.models.update(model.provider, model.modelId, (item) => {
          item.modelID = model.modelId as typeof item.modelID;
          item.type = "chat";
          item.enabled = true;
          item.capabilities = {
            ...item.capabilities,
            input: model.inputModalities,
            output: model.outputModalities
          };
        });
      });
    }
  });
}
/** Native OpenCode session generation, isolated from run/scanner state. */
export async function probeOpenCode(
  model: OpenCodeModel,
  key: string,
  storage: DurableObjectStorage,
  create?: typeof OpenCodeWorkerd.create
): Promise<void> {
  const signal = AbortSignal.timeout(60000);
  const open =
    create ?? (await import("@opencode/sdk/workerd")).OpenCodeWorkerd.create;
  const host = await open({
    storage,
    models: { fetch: false, snapshot: false },
    config: {
      default_agent: "connection-test",
      agents: {
        "connection-test": {
          mode: "primary",
          description: "Connection test",
          system: "Reply OK only. Do not use tools."
        }
      },
      providers: {
        [model.provider]: nativeProvider(
          { ...model, outputLimit: Math.min(model.outputLimit, 8192) },
          key
        )
      }
    },
    plugins: [
      nativeModelPlugin({
        ...model,
        outputLimit: Math.min(model.outputLimit, 8192)
      }),
      Plugin.define({
        id: "pentcloud.connection-test",
        async setup(ctx) {
          await ctx.agent.transform((agents) => {
            agents.update("connection-test", (agent) => {
              agent.system = "Reply OK only. Do not use tools.";
              agent.permissions = [
                { action: "*", resource: "*", effect: "deny" }
              ];
            });
          });
          await ctx.tool.transform((tools) => {
            for (const tool of tools.list()) tools.remove(tool.id);
          });
        }
      })
    ]
  });
  try {
    const session = await host.sessions.create(
      {
        title: "OpenCode connection test",
        agent: "connection-test",
        model: { providerID: model.provider, id: model.modelId }
      },
      { signal }
    );
    const result = await host.sessions.generate(
      { sessionID: session.id, prompt: "Connection test only. Reply OK." },
      { signal }
    );
    if (!result.text.trim())
      throw new Error("OpenCode returned no test response");
  } finally {
    await host.close();
  }
}
