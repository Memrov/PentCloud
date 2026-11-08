import { expect, it } from "vite-plus/test";
import {
  assertPinnedModel,
  normalizeCatalog,
  parseByokProviders,
  nativeProvider
} from "../src/native/opencode-models";
const connectionId = "conn_fixture123";
const providers = [{ connectionId, name: "Meta", models: ["muse-spark-1.3"] }];
const raw = {
  data: [
    {
      id: "muse-spark-1.3",
      name: "Muse Spark 1.3",
      type: "chat",
      capabilities: {
        tools: { supported: true },
        reasoning: { effort: ["low", "high"] }
      },
      limit: { context: 1048576, output: 131072 },
      api: {
        responses: { base_url: "https://opencode.ai/inference/openai/v1" }
      }
    }
  ]
};
const pin = (model: any) => ({
  ...model,
  credentialId: "bound-go",
  credentialVersion: 0,
  catalogDigest: "a".repeat(64),
  testedAt: 1
});
it("adds a distinct BYOK choice with native catalog metadata and the exact connection route", () => {
  const models = normalizeCatalog(raw, "console", providers),
    byok = models.find((m) => m.connectionId);
  expect(models).toHaveLength(2);
  expect(byok).toMatchObject({
    id: `opencode:byok/${connectionId}/muse-spark-1.3`,
    provider: "opencode",
    modelId: "muse-spark-1.3",
    connectionId,
    adapter: "responses",
    baseURL: `https://opencode.ai/inference/custom/${connectionId}`,
    contextLength: 1048576
  });
  expect(byok?.name).toContain("Meta BYOK");
  expect(() => assertPinnedModel(pin(byok))).not.toThrow();
  expect(nativeProvider(byok!, "fixture-key").settings).toMatchObject({
    baseURL: `https://opencode.ai/inference/custom/${connectionId}`,
    apiKey: "fixture-key"
  });
  expect(normalizeCatalog(raw, "go", providers)).toEqual([]);
});
it("rejects forged BYOK destinations/identities while preserving existing Console pins", () => {
  const [normal, byok] = normalizeCatalog(raw, "console", providers);
  expect(() => assertPinnedModel(pin(normal))).not.toThrow();
  for (const change of [
    { baseURL: "https://evil.example/" },
    {
      baseURL: `https://opencode.ai/inference/custom/${connectionId}/../openai/v1`
    },
    { connectionId: "conn_other" },
    { id: "opencode:muse-spark-1.3" },
    { route: "go" },
    { package: "arbitrary-package" }
  ])
    expect(() => assertPinnedModel(pin({ ...byok, ...change }))).toThrow();
});
it("validates configuration without accepting URLs, duplicates, empty or unknown model metadata", () => {
  expect(parseByokProviders(undefined)).toEqual([]);
  expect(parseByokProviders(JSON.stringify(providers))).toEqual(providers);
  for (const value of [
    "not-json",
    "{}",
    JSON.stringify([...providers, ...providers]),
    JSON.stringify([{ ...providers[0], connectionId: "https://evil.example" }]),
    JSON.stringify([{ ...providers[0], models: [] }])
  ])
    expect(() => parseByokProviders(value)).toThrow(/configuration/i);
  expect(() =>
    normalizeCatalog(raw, "console", [
      { ...providers[0]!, models: ["missing"] }
    ])
  ).toThrow(/metadata/i);
});

import { OnboardingStore } from "../src/native/onboarding";
function storeFixture() {
  const records = new Map<string, unknown>();
  let configured = providers,
    fail = false,
    probe = async () => {};
  const store = new OnboardingStore({
    get: <T>(k: string) => structuredClone(records.get(k)) as T | undefined,
    put: (k, v) => {
      records.set(k, structuredClone(v));
    },
    remove: (k) => {
      records.delete(k);
    },
    list: <T>(p: string) =>
      [...records]
        .filter(([k]) => k.startsWith(p))
        .map(([, v]) => structuredClone(v) as T),
    byokProviders: () => configured,
    boundGoKey: () => "fixture-key",
    now: () => 1000000,
    probe: () => probe(),
    fetcher: (async () => {
      if (fail) throw Error("offline");
      return Response.json(raw);
    }) as typeof fetch
  });
  return {
    store,
    records,
    configure: (p: typeof providers) => {
      configured = p;
    },
    offline: () => {
      fail = true;
    },
    probe: (p: () => Promise<void>) => {
      probe = p;
    }
  };
}
it("invalidates future catalog/proofs when connection config changes without invalidating an old pin", async () => {
  const f = storeFixture(),
    catalog = await f.store.catalog("console"),
    model = catalog.models.find((m) => m.connectionId)!;
  const choice = {
    model: model.id,
    credentialId: "bound-go",
    credentialVersion: 0
  };
  await f.store.testModel(choice, "test-one", "owner");
  const pinned = f.store.pinnedModel(choice);
  f.configure([{ ...providers[0]!, connectionId: "conn_second" }]);
  expect(() => f.store.pinnedModel(choice)).toThrow(/Refresh/);
  const changed = await f.store.catalog("console");
  expect(changed.models.some((m) => m.connectionId === connectionId)).toBe(
    false
  );
  expect(changed.models.some((m) => m.connectionId === "conn_second")).toBe(
    true
  );
  expect(() => assertPinnedModel(pinned)).not.toThrow();
});
it("refuses stale connection config and never substitutes ordinary Console billing after failure", async () => {
  const f = storeFixture();
  await f.store.catalog("console");
  f.configure([{ ...providers[0]!, connectionId: "conn_second" }]);
  f.offline();
  await expect(f.store.catalog("console")).rejects.toThrow(
    /catalog unavailable/
  );
  expect(() =>
    f.store.pinnedModel({
      model: `opencode:byok/${connectionId}/muse-spark-1.3`,
      credentialId: "bound-go",
      credentialVersion: 0
    })
  ).toThrow();
});
it("rejects a configuration change while the connection test is running", async () => {
  const f = storeFixture(),
    c = await f.store.catalog("console");
  f.probe(async () => {
    f.configure([{ ...providers[0]!, connectionId: "conn_second" }]);
  });
  await expect(
    f.store.testModel(
      {
        model: c.models.find((m) => m.connectionId)!.id,
        credentialId: "bound-go",
        credentialVersion: 0
      },
      "test-race",
      "owner"
    )
  ).rejects.toThrow(/Refresh/);
  expect(
    [...f.records.keys()].some((k) => k.startsWith("onboarding:model-proof:"))
  ).toBe(false);
});
it("rejects a non-string upstream model ID even when its coerced alias would match", () => {
  const byok = normalizeCatalog(raw, "console", providers).find(
    (m) => m.connectionId
  )!;
  expect(() =>
    assertPinnedModel(
      pin({
        ...byok,
        modelId: undefined,
        id: `opencode:byok/${connectionId}/undefined`
      })
    )
  ).toThrow();
});
