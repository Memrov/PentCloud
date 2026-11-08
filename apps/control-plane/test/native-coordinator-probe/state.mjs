import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AgentClient } from "agents/client";
import {
  withNativeTestHarness,
  rpcResult
} from "../../../../scripts/lib/native-test-harness.mjs";

const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Coordinator State response timed out")),
          5000
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Exercise the production Coordinator's actual State/WebSockets capabilities in workerd. */
export async function verifyReadonlyState(coordinator, url) {
  await coordinator.seed(1, "coder", false);
  let receiveState, receiveError;
  const client = new AgentClient({
    agent: "coordinator",
    name: "global",
    host: new URL(url).host,
    protocol: "ws",
    onStateUpdate: (state, source) => {
      if (source === "server") receiveState?.(state);
    },
    onStateUpdateError: (error) => receiveError?.(error)
  });
  try {
    await bounded(client.ready);
    const published = new Promise((resolve) => {
      receiveState = resolve;
    });
    await coordinator.cancelRun("run-0");
    const state = await bounded(published);
    assert.equal(state.runs[0].id, "run-0");
    assert.equal(state.jobs[0].runId, "run-0");
    assert.ok(
      state.revision > 0,
      "authoritative publication reaches the installed Agent client"
    );
    const records = (await rpcResult(coordinator.snapshot())).records;
    const denied = new Promise((resolve) => {
      receiveError = resolve;
    });
    client.setState({ revision: state.revision + 1000, runs: [], jobs: [] });
    assert.equal(await bounded(denied), "Connection is readonly");
    const reconnect = new AgentClient({
      agent: "coordinator",
      name: "global",
      host: new URL(url).host,
      protocol: "ws"
    });
    try {
      await bounded(reconnect.ready);
      assert.deepEqual(
        reconnect.state.runs,
        state.runs,
        "client mutation cannot change runs seen on reconnect"
      );
      assert.deepEqual(
        reconnect.state.jobs,
        state.jobs,
        "client mutation cannot change jobs seen on reconnect"
      );
      assert.ok(
        reconnect.state.revision >= state.revision &&
          reconnect.state.revision < state.revision + 1000,
        "reconnect retains a server-owned revision"
      );
      assert.deepEqual(
        (await rpcResult(coordinator.snapshot())).records,
        records,
        "State never writes the live admission ledger"
      );
    } finally {
      reconnect.close();
    }
  } finally {
    client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await withNativeTestHarness(
    {
      root: fileURLToPath(new URL("../../", import.meta.url)),
      workers: [{ configPath: "test/native-coordinator-probe/wrangler.jsonc" }]
    },
    async (server, url) => {
      const { COORDINATOR } = await server.getWorker().getEnv();
      await verifyReadonlyState(COORDINATOR.getByName("global"), url);
    }
  );
  console.log(
    "workerd Coordinator: native State broadcast, readonly mutation rejection and reconnect persistence passed"
  );
}
