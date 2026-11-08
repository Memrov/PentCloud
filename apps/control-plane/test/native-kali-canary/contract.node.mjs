import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  assertCatalog,
  browserEvidence,
  BROWSER_DOCUMENT_EVALUATION
} from "./contract.mjs";

const baseline = [
  {
    name: "nmap_port_scan",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"]
    }
  },
  {
    name: "nmap_get_scan_results",
    inputSchema: {
      type: "object",
      properties: { scan_id: { type: "string" } },
      required: ["scan_id"]
    }
  }
];
test("catalog rejects a missing tool even when the total is unchanged", () => {
  assert.throws(
    () =>
      assertCatalog(
        [baseline[0], { ...baseline[1], name: "another_tool" }],
        baseline
      ),
    /catalog/
  );
});
test("catalog rejects stock argument schema drift before any tool can run", () => {
  assert.throws(
    () =>
      assertCatalog(
        [baseline[0], { ...baseline[1], inputSchema: { type: "object" } }],
        baseline
      ),
    /schema/
  );
});
test("catalog accepts identical schemas independent of object and list order", () => {
  const actual = [
    baseline[1],
    {
      name: "nmap_port_scan",
      inputSchema: {
        required: ["target"],
        properties: { target: { type: "string" } },
        type: "object"
      }
    }
  ];
  assert.deepEqual(assertCatalog(actual, baseline), {
    count: 2,
    exactNames: true,
    exactSchemas: true
  });
});
test("browser evidence preserves an actual tool error instead of replacing it with a document assertion", () => {
  assert.deepEqual(
    browserEvidence({
      isError: true,
      content: [{ type: "text", text: "Navigation started a download" }]
    }),
    {
      isError: true,
      text: "Navigation started a download",
      textCharacters: 29,
      truncated: false,
      contentTypes: ["text"]
    }
  );
});
test("browser evidence bounds text and omits binary payloads", () => {
  const evidence = browserEvidence({
    content: [
      { type: "text", text: "x".repeat(40000) },
      { type: "image", data: "not-a-useful-diagnostic" }
    ]
  });
  assert.equal(evidence.text.length, 32768);
  assert.equal(evidence.textCharacters, 40000);
  assert.equal(evidence.truncated, true);
  assert.deepEqual(evidence.contentTypes, ["text", "image"]);
  assert.equal(
    JSON.stringify(evidence).includes("not-a-useful-diagnostic"),
    false
  );
});
test("fixed browser evaluation returns bounded DOM text, URL and available HTTP metadata", () => {
  const result = runInNewContext(`(${BROWSER_DOCUMENT_EVALUATION})()`, {
    location: { href: "https://developers.cloudflare.com/robots.txt" },
    document: {
      contentType: "text/plain",
      body: { innerText: "User-agent: *\n" + "x".repeat(20000) }
    },
    performance: { getEntriesByType: () => [{ responseStatus: 200 }] }
  });
  assert.equal(result.url, "https://developers.cloudflare.com/robots.txt");
  assert.equal(result.contentType, "text/plain");
  assert.equal(result.navigationStatus, 200);
  assert.equal(result.text.length, 16384);
  assert.equal(result.text.startsWith("User-agent: *\n"), true);
});

test("lifecycle contract uses only four pinned control RPCs and preserves a stopped runtime", async () => {
  const { lifecycleContract } = await import("./contract.mjs");
  const calls = [];
  const result = await lifecycleContract({
    status: async () => {
      calls.push(["status"]);
      return { state: "stopped", inactivityTimeoutMs: 1800000 };
    },
    ready: async (generation) => {
      calls.push(["ready", generation]);
      return { error: "generation_lost" };
    },
    activity: async (generation) => {
      calls.push(["activity", generation]);
      return { error: "generation_lost" };
    },
    fetch: () => {
      throw new Error("Lifecycle acceptance must never call MCP");
    }
  });
  assert.deepEqual(calls, [
    ["status"],
    ["ready", "deliberately-nonmatching-generation"],
    ["activity", "deliberately-nonmatching-generation"],
    ["status"]
  ]);
  assert.equal(result.stateUnchanged, true);
  assert.equal(result.generationUnchanged, true);
  assert.deepEqual(result.before, result.after);
});

test("lifecycle contract refuses successful stale recovery and state or generation changes", async () => {
  const { lifecycleContract } = await import("./contract.mjs");
  for (const scenario of [
    "ready-succeeded",
    "activity-succeeded",
    "state-changed",
    "generation-changed"
  ]) {
    let statuses = 0;
    const initial = {
      state: "running",
      generation: "running-generation",
      inactivityTimeoutMs: 1800000
    };
    await assert.rejects(
      () =>
        lifecycleContract({
          status: async () =>
            ++statuses === 1
              ? initial
              : {
                  ...initial,
                  ...(scenario === "state-changed" ? { state: "stopped" } : {}),
                  ...(scenario === "generation-changed"
                    ? { generation: "replacement-generation" }
                    : {})
                },
          ready: async () =>
            scenario === "ready-succeeded"
              ? { state: "ready", generation: "running-generation" }
              : { error: "generation_lost", generation: "running-generation" },
          activity: async () =>
            scenario === "activity-succeeded"
              ? { state: "running", generation: "running-generation" }
              : { error: "generation_lost", generation: "running-generation" }
        }),
      /generation|state/i,
      scenario
    );
  }
});
