import { DurableObject } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import baseline from "../fixtures/stock-kali-catalog.json";
import { remoteResultObject } from "../../src/native/tool-policy";
import {
  assertCatalog,
  browserEvidence,
  BROWSER_DOCUMENT_EVALUATION,
  lifecycleContract
} from "./contract.mjs";

const HEADER = "X-Pentcloud-Toolbox-Generation";
const DOCS = "https://developers.cloudflare.com/robots.txt";
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const digest = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** Temporary fixture only: no model, user job, production credential or protocol parser. */
export class KaliCanary extends DurableObject {
  async ready() {
    const prior = await this.ctx.storage.get("generation");
    const result = await this.env.TOOLBOX.ready(prior);
    assert(
      ["ready", "booting"].includes(result.state) &&
        typeof result.generation === "string",
      "Private readiness refused or generation was lost"
    );
    assert(
      !prior || prior === result.generation,
      "Readiness changed the pinned generation"
    );
    await this.ctx.storage.put("generation", result.generation);
    return result;
  }
  async status() {
    return {
      health: await this.env.TOOLBOX.status(),
      receipt: await this.ctx.storage.get("receipt"),
      scanEvidence: await this.ctx.storage.get("scanEvidence"),
      browserEvidence: await this.ctx.storage.get("browserEvidence"),
      browserCleanup: await this.ctx.storage.get("browserCleanup"),
      wire: [...(await this.ctx.storage.list({ prefix: "wire:" })).values()]
    };
  }
  async withMcp(action) {
    const generation = await this.ctx.storage.get("generation");
    assert(generation, "Readiness must establish a generation first");
    const wire = [];
    const observation = AbortSignal.timeout(180000);
    const transport = new StreamableHTTPClientTransport(
      new URL("https://toolbox.internal/mcp?codemode=false"),
      {
        fetch: async (input, init) => {
          const request = new Request(input, init),
            headers = new Headers(request.headers);
          headers.set(HEADER, generation);
          // Deliberately invalid caller auth must be replaced inside the private gateway.
          headers.set("Authorization", "Bearer invalid-canary-caller-sentinel");
          const response = await this.env.TOOLBOX.fetch(
            new Request(request, {
              headers,
              signal:
                request.method === "DELETE"
                  ? AbortSignal.timeout(15000)
                  : AbortSignal.any([request.signal, observation])
            })
          );
          assert(
            response.headers.get(HEADER) === generation,
            "MCP response lost the pinned private generation"
          );
          const session = request.headers.get("mcp-session-id"),
            responseSession = response.headers.get("mcp-session-id");
          wire.push({
            method: request.method,
            status: response.status,
            generation,
            callerAuthReplaced: true,
            ...(session ? { sessionDigest: await digest(session) } : {}),
            ...(responseSession
              ? { responseSessionDigest: await digest(responseSession) }
              : {}),
            responseGeneration: response.headers.get(HEADER)
          });
          return response;
        }
      }
    );
    const client = new Client(
      { name: "pentcloud-native-kali-canary", version: "1" },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
    );
    let result, failure, teardownError;
    try {
      await client.connect(transport, { timeout: 90000 });
      result = await action(client);
    } catch (error) {
      failure = error;
    } finally {
      try {
        await transport.terminateSession();
      } catch (error) {
        teardownError = String(error);
      }
      await client.close();
      await this.ctx.storage.put("wire:" + crypto.randomUUID(), wire);
    }
    const terminated = wire.some(
      (row) => row.method === "DELETE" && row.status >= 200 && row.status < 300
    );
    if (failure) throw failure;
    assert(
      !teardownError && terminated,
      "MCP session teardown was not positively confirmed"
    );
    const established = wire.find(
      (row) => row.responseSessionDigest
    )?.responseSessionDigest;
    assert(
      established &&
        wire
          .filter((row) => row.sessionDigest)
          .every((row) => row.sessionDigest === established),
      "Opaque MCP session identity changed"
    );
    return {
      ...result,
      generation,
      sessionDigest: established,
      sameSession: true,
      sessionTerminated: terminated,
      wire
    };
  }
  async catalog() {
    return this.withMcp(async (client) => {
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools({ cursor }, { timeout: 90000 });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      try {
        return { matched: true, catalog: assertCatalog(tools, baseline.tools) };
      } catch (error) {
        return { matched: false, count: tools.length, error: String(error) };
      }
    });
  }
  async observeBrowser(client) {
    const startedAt = Date.now();
    let observed;
    try {
      const actual = await client.callTool(
        { name: "playwright_browser_navigate", arguments: { url: DOCS } },
        undefined,
        { timeout: 90000 }
      );
      const navigation = { observedAt: Date.now(), ...browserEvidence(actual) };
      observed = { url: DOCS, startedAt, ...navigation, navigation };
      await this.ctx.storage.put("browserEvidence", observed);
      if (navigation.isError) return { ...observed, retrieved: false };
      // Stock navigation may return only a snapshot-file link. Ask the original
      // browser tool for fixed read-only DOM evidence, without opening any file.
      const actualEvaluation = await client.callTool(
        {
          name: "playwright_browser_evaluate",
          arguments: { function: BROWSER_DOCUMENT_EVALUATION }
        },
        undefined,
        { timeout: 30000 }
      );
      const evaluation = {
        observedAt: Date.now(),
        ...browserEvidence(actualEvaluation)
      };
      observed = { ...observed, evaluation };
      await this.ctx.storage.put("browserEvidence", observed);
      return {
        ...observed,
        retrieved:
          !evaluation.isError &&
          evaluation.text.includes(DOCS) &&
          /User-agent/i.test(evaluation.text)
      };
    } catch (error) {
      await this.ctx.storage.put("browserEvidence", {
        ...observed,
        url: DOCS,
        startedAt,
        observedAt: Date.now(),
        error: String(error).slice(0, 32768)
      });
      throw error;
    } finally {
      try {
        const closed = await client.callTool(
          { name: "playwright_browser_close", arguments: {} },
          undefined,
          { timeout: 15000 }
        );
        await this.ctx.storage.put("browserCleanup", {
          observedAt: Date.now(),
          ...browserEvidence(closed)
        });
        assert(!closed.isError, "Stock browser cleanup failed");
      } catch (error) {
        await this.ctx.storage.put("browserCleanup", {
          observedAt: Date.now(),
          error: String(error).slice(0, 32768)
        });
        throw error;
      }
    }
  }
  async browserOnly() {
    return this.withMcp(async (client) => ({
      browser: await this.observeBrowser(client),
      healthAfter: await this.env.TOOLBOX.status(),
      modelCalls: 0,
      scanMutations: 0
    }));
  }
  async run() {
    assert(
      !(await this.ctx.storage.get("receipt")),
      "Canary already admitted; inspect its original outcome instead of retrying"
    );
    await this.ctx.storage.put("receipt", {
      state: "admitted",
      stage: "catalog",
      at: Date.now()
    });
    return this.withMcp(async (client) => {
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools({ cursor }, { timeout: 90000 });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      assert(baseline.tools.length === 126, "Invalid baseline");
      const catalog = assertCatalog(tools, baseline.tools);
      const healthBefore = await this.env.TOOLBOX.status();
      const generation = await this.ctx.storage.get("generation");
      assert(
        healthBefore.generation === generation &&
          healthBefore.inactivityTimeoutMs === 1800000,
        "Generation or native idle contract changed"
      );
      const stale = await this.env.TOOLBOX.ready(
        "deliberately-stale-canary-generation"
      );
      assert(
        stale.error === "generation_lost",
        "Stale generation did not fail closed"
      );
      await this.ctx.storage.put("receipt", {
        state: "unknown",
        stage: "loopback-scan",
        at: Date.now()
      });
      const scan = remoteResultObject(
        await client.callTool(
          {
            name: "nmap_port_scan",
            arguments: {
              target: "127.0.0.1",
              ports: "8081",
              timing: 4,
              timeout: 30
            }
          },
          undefined,
          { timeout: 90000 }
        )
      );
      await this.ctx.storage.put("scanEvidence", {
        scan,
        observedAt: Date.now()
      });
      assert(
        typeof scan.scan_id === "string",
        "Scan identity unavailable; do not repeat mutation"
      );
      await this.ctx.storage.put("receipt", {
        state: "observing",
        stage: "loopback-scan",
        scanId: scan.scan_id
      });
      let inspection;
      for (let attempt = 0; attempt < 30; attempt++) {
        inspection = remoteResultObject(
          await client.callTool(
            {
              name: "nmap_get_scan_results",
              arguments: { scan_id: scan.scan_id }
            },
            undefined,
            { timeout: 15000 }
          )
        );
        await this.ctx.storage.put("scanEvidence", {
          scan,
          inspection,
          observedAt: Date.now()
        });
        if (
          ["completed", "failed", "error", "cancelled"].includes(
            inspection.status
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert(
        inspection?.scan_id === scan.scan_id &&
          inspection.target === "127.0.0.1" &&
          inspection.status === "completed",
        "Loopback scan did not have a matching terminal inspection"
      );
      assert(
        inspection.scan_type === "port" &&
          inspection.hosts?.some(
            (host) =>
              host.addresses?.some((address) => address.addr === "127.0.0.1") &&
              host.open_ports?.some(
                (port) =>
                  String(port.port) === "8081" && port.protocol === "tcp"
              )
          ),
        "Stock loopback inspector did not confirm TCP 8081 open"
      );
      await this.ctx.storage.put("scanEvidence", {
        scan,
        inspection,
        confirmed: true,
        observedAt: Date.now()
      });
      await this.ctx.storage.put("receipt", {
        state: "unknown",
        stage: "outbound-docs",
        scanId: scan.scan_id,
        scanConfirmed: true
      });
      const browser = await this.observeBrowser(client);
      assert(
        browser.retrieved,
        "Stock browser did not retrieve the fixed official HTTPS document"
      );
      const healthAfter = await this.env.TOOLBOX.status();
      assert(
        healthAfter.generation === generation,
        "Container changed generation during acceptance"
      );
      const result = {
        catalog,
        healthBefore,
        healthAfter,
        staleGenerationRejected: true,
        scan,
        inspection,
        outbound: {
          tool: "playwright_browser_navigate",
          url: DOCS,
          result: browser,
          browserClosed: true
        },
        modelCalls: 0,
        scanMutations: 1
      };
      await this.ctx.storage.put("receipt", {
        state: "completed",
        scanId: scan.scan_id
      });
      return result;
    });
  }
  async clean() {
    await this.ctx.storage.deleteAll();
    return {
      temporaryStorageCleared: (await this.ctx.storage.list()).size === 0
    };
  }
}

export default {
  async fetch(request, env) {
    const actual = new TextEncoder().encode(
        request.headers.get("Authorization") ?? ""
      ),
      expected = new TextEncoder().encode("Bearer " + env.CANARY_TOKEN);
    if (
      !env.CANARY_TOKEN ||
      actual.byteLength !== expected.byteLength ||
      !crypto.subtle.timingSafeEqual(actual, expected)
    )
      return new Response("Unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ready: true });
    try {
      if (path === "/lifecycle-contract" && request.method === "POST")
        return Response.json(await lifecycleContract(env.TOOLBOX));
      const probe = env.PROBE.getByName("only-canary");
      if (path === "/ready") return Response.json(await probe.ready());
      if (path === "/status") return Response.json(await probe.status());
      if (request.method !== "POST")
        return new Response("Not found", { status: 404 });
      if (path === "/catalog") return Response.json(await probe.catalog());
      if (path === "/browser-only")
        return Response.json(await probe.browserOnly());
      if (path === "/run") return Response.json(await probe.run());
      if (path === "/clean") return Response.json(await probe.clean());
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: String(error).replaceAll(env.CANARY_TOKEN, "[redacted]") },
        { status: 500 }
      );
    }
  }
};
