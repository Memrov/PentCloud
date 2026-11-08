import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  withNativeTestHarness,
  rpcResult as rpc
} from "../../../../scripts/lib/native-test-harness.mjs";

const config = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
);
test("built gateway over native service and Durable Object bindings", async (t) =>
  withNativeTestHarness(
    {
      root: fileURLToPath(new URL("../", import.meta.url)),
      workers: [
        {
          config: {
            ...config,
            main: "test/gateway-fixture.mjs",
            secrets: { required: [] },
            vars: { KALI_MCP_TOKEN: "mcp-fixture-long-enough" },
            services: [
              {
                binding: "TOOLBOX",
                service: config.name,
                entrypoint: "ToolboxGateway"
              },
              { binding: "KALI", service: config.name, entrypoint: "Upstream" }
            ],
            durable_objects: {
              bindings: [{ name: "KALI_TOOLBOX", class_name: "FixtureKali" }]
            },
            migrations: [
              { tag: "fixture", new_sqlite_classes: ["FixtureKali"] }
            ]
          }
        }
      ]
    },
    async (server) => {
      const publicWorker = server.getWorker();
      const {
        TOOLBOX: gateway,
        KALI: upstream,
        KALI_TOOLBOX
      } = await publicWorker.getEnv();
      const toolbox = KALI_TOOLBOX.getByName("shared");

      await t.test(
        "private named entrypoint injects bearer, drops operator credentials and preserves MCP request",
        async () => {
          const response = await gateway.fetch("https://toolbox.internal/mcp", {
            method: "POST",
            body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
            headers: {
              authorization: "Bearer caller-token",
              cookie: "credential=fixture",
              "cf-access-client-secret": "access-fixture",
              "mcp-session-id": "session-fixture",
              "mcp-protocol-version": "2025-03-26",
              "content-type": "application/json",
              "X-Pentcloud-Toolbox-Generation": "fixture-generation"
            }
          });
          const forwarded = await response.json();
          assert.equal(forwarded.url, "http://kali.internal/mcp");
          assert.equal(
            forwarded.headers.authorization,
            "Bearer mcp-fixture-long-enough"
          );
          assert.equal(forwarded.headers.cookie, undefined);
          assert.equal(forwarded.headers["cf-access-client-secret"], undefined);
          assert.equal(forwarded.headers["mcp-session-id"], "session-fixture");
          assert.equal(forwarded.headers["mcp-protocol-version"], "2025-03-26");
          assert.equal(JSON.parse(forwarded.body).method, "tools/list");
        }
      );

      await t.test(
        "private capability cannot invoke AWS controls or arbitrary URLs, methods, paths or queries",
        async () => {
          for (const url of [
            "https://outside.example/mcp",
            "http://toolbox.internal/mcp",
            "https://toolbox.internal/host/restart",
            "https://toolbox.internal/toolbox/start",
            "https://toolbox.internal/mcp/",
            "https://toolbox.internal/mcp?url=https://outside.example",
            "https://toolbox.internal/mcp?codemode=true"
          ]) {
            assert.equal(
              (await gateway.fetch(url, { method: "POST" })).status,
              404,
              url
            );
          }
          assert.equal(
            (
              await gateway.fetch("https://toolbox.internal/mcp", {
                method: "PUT"
              })
            ).status,
            405
          );
          assert.equal(
            (
              await gateway.fetch(
                "https://toolbox.internal/mcp?codemode=false",
                {
                  method: "DELETE",
                  headers: {
                    "X-Pentcloud-Toolbox-Generation": "fixture-generation"
                  }
                }
              )
            ).status,
            200
          );
          assert.equal(
            (await gateway.fetch("https://toolbox.internal/health")).status,
            404
          );
        }
      );

      await t.test(
        "MCP SSE remains streamed and session headers survive",
        async () => {
          const response = await gateway.fetch("https://toolbox.internal/mcp", {
            headers: { "X-Pentcloud-Toolbox-Generation": "fixture-generation" }
          });
          assert.equal(
            response.headers.get("content-type"),
            "text/event-stream"
          );
          assert.equal(
            response.headers.get("mcp-session-id"),
            "session-fixture"
          );
          const reader = response.body.getReader();
          const first = await reader.read();
          assert.equal(
            new TextDecoder().decode(first.value),
            "data: first\n\n",
            "first event arrives before the upstream closes"
          );
          let content = new TextDecoder().decode(first.value);
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            content += new TextDecoder().decode(value);
          }
          assert.equal(content, "data: first\n\ndata: second\n\n");
        }
      );

      await t.test(
        "gateway returns redirects without forwarding secret to another destination",
        async () => {
          const response = await gateway.fetch("https://toolbox.internal/mcp", {
            method: "POST",
            headers: {
              "x-redirect": "1",
              "X-Pentcloud-Toolbox-Generation": "fixture-generation"
            },
            redirect: "manual"
          });
          assert.equal(response.status, 307);
        }
      );

      await t.test(
        "public gateway rejects every route even with former operator or MCP credentials",
        async () => {
          for (const path of [
            "/health",
            "/mcp",
            "/toolbox/status",
            "/toolbox/start",
            "/toolbox/restart"
          ])
            for (const token of [
              "",
              "native-operator-fixture",
              "mcp-fixture-long-enough"
            ])
              assert.equal(
                (
                  await publicWorker.fetch("https://public.example" + path, {
                    method: "POST",
                    headers: { Authorization: "Bearer " + token }
                  })
                ).status,
                404
              );
        }
      );

      await t.test(
        "service and DO lifecycle RPC preserve typed outcomes and reject private HTTP lifecycle routes",
        async () => {
          assert.deepEqual(await rpc(gateway.status()), {
            state: "running",
            generation: "fixture-generation",
            inactivityTimeoutMs: 1800000
          });
          assert.deepEqual(await rpc(gateway.ready()), {
            state: "ready",
            generation: "fixture-generation"
          });
          assert.deepEqual(await rpc(gateway.activity("fixture-generation")), {
            state: "running",
            generation: "fixture-generation"
          });
          for (const method of ["ready", "activity"]) {
            assert.deepEqual(await rpc(gateway[method]("stale-generation")), {
              error: "generation_lost",
              generation: "fixture-generation"
            });
          }
          for (const [path, method] of [
            ["/health", "GET"],
            ["/ready", "GET"],
            ["/activity", "POST"]
          ]) {
            assert.equal(
              (
                await gateway.fetch(`https://toolbox.internal${path}`, {
                  method
                })
              ).status,
              404
            );
          }
        }
      );

      await t.test(
        "workerd lifecycle RPC does not wait for an in-flight MCP response",
        async () => {
          const mcp = gateway.fetch("https://toolbox.internal/mcp", {
            method: "POST",
            body: "one-mutation",
            headers: {
              "X-Pentcloud-Toolbox-Generation": "fixture-generation",
              "x-held": "1"
            }
          });
          let timer;
          try {
            const until = Date.now() + 2000;
            while (
              !(
                await (
                  await upstream.fetch("https://kali.test/fixture/state")
                ).json()
              ).waiting
            ) {
              assert.ok(Date.now() < until, "MCP did not reach its upstream");
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
            const replies = await Promise.race([
              Promise.all([
                rpc(gateway.status()),
                rpc(gateway.activity("fixture-generation"))
              ]),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("MCP response held lifecycle RPC")),
                  2000
                );
              })
            ]);
            assert.equal(replies[0].state, "running");
            assert.deepEqual(replies[1], {
              state: "running",
              generation: "fixture-generation"
            });
            assert.equal(
              (
                await (
                  await upstream.fetch("https://kali.test/fixture/state")
                ).json()
              ).waiting,
              true,
              "lifecycle RPC completed before the MCP response"
            );
          } finally {
            clearTimeout(timer);
            const response = await mcp;
            assert.equal(
              response.status,
              200,
              "the held MCP request must complete successfully"
            );
            await response.body.cancel();
          }
        }
      );

      await t.test(
        "workerd RPC cold start shares a generation and retries timeout failure without another start",
        async () => {
          try {
            await rpc(
              toolbox.fixture({
                running: false,
                starts: 0,
                timeouts: [],
                failTimeout: true
              })
            );
            assert.deepEqual(await rpc(gateway.status()), {
              state: "stopped",
              inactivityTimeoutMs: 1800000
            });
            assert.deepEqual(await rpc(gateway.ready("lost-generation")), {
              error: "generation_lost"
            });
            assert.equal(
              (await rpc(toolbox.fixture({}))).starts,
              0,
              "status and pinned recovery cannot start the runtime"
            );
            assert.deepEqual(await rpc(gateway.ready()), {
              error: "unavailable"
            });
            const failed = await rpc(toolbox.fixture({}));
            assert.equal(failed.starts, 1);
            assert.deepEqual(failed.timeouts, [1800000]);
            await rpc(toolbox.fixture({ failTimeout: false }));
            const replies = await Promise.all(
              Array.from({ length: 8 }, () => rpc(gateway.ready()))
            );
            assert.ok(
              replies.every(
                (reply) =>
                  reply.state === "ready" &&
                  reply.generation === failed.generation
              )
            );
            const recovered = await rpc(toolbox.fixture({}));
            assert.equal(recovered.starts, 1);
            assert.deepEqual(recovered.timeouts, [1800000, 1800000]);
            await rpc(toolbox.fixture({ running: false }));
            assert.deepEqual(await rpc(gateway.ready(failed.generation)), {
              error: "generation_lost"
            });
            assert.equal(
              (await rpc(toolbox.fixture({}))).starts,
              1,
              "lost pinned generation cannot restart"
            );
            const cold = await Promise.all(
              Array.from({ length: 8 }, () => rpc(gateway.ready()))
            );
            const next = await rpc(toolbox.fixture({}));
            assert.equal(next.starts, 2);
            assert.notEqual(next.generation, failed.generation);
            assert.ok(
              cold.every(
                (reply) =>
                  reply.generation === next.generation &&
                  ["booting", "ready"].includes(reply.state)
              )
            );
            assert.deepEqual(next.timeouts, [1800000, 1800000, 1800000]);
          } finally {
            await rpc(
              toolbox.fixture({
                running: true,
                generation: "fixture-generation",
                failTimeout: false
              })
            );
          }
        }
      );

      await t.test(
        "private lifecycle status never starts a stopped runtime and a lost generation cannot replace it",
        async () => {
          try {
            await rpc(
              toolbox.fixture({ running: false, starts: 0, failTimeout: false })
            );
            assert.deepEqual(await rpc(gateway.status()), {
              state: "stopped",
              inactivityTimeoutMs: 1800000
            });
            assert.equal((await rpc(toolbox.fixture({}))).starts, 0);
            assert.equal(
              (await rpc(gateway.ready("lost-generation"))).error,
              "generation_lost"
            );
            assert.equal((await rpc(toolbox.fixture({}))).starts, 0);
            assert.equal((await rpc(gateway.ready())).state, "booting");
            assert.equal((await rpc(toolbox.fixture({}))).starts, 1);
          } finally {
            await rpc(
              toolbox.fixture({
                running: true,
                generation: "fixture-generation",
                failTimeout: false
              })
            );
          }
        }
      );
    }
  ));
