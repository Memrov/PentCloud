import {createTestHarness} from "wrangler";

/** Run real Worker fixtures with isolated storage and deterministic teardown. */
export async function withNativeTestHarness(options, run) {
  process.env.WRANGLER_SEND_METRICS ??= "false";
  const server = createTestHarness(options);
  try {
    const {url} = await server.listen();
    return await run(server, url);
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

/** Copy data across the native Node/workerd RPC proxy for local assertions. */
export async function rpcResult(promise) {
  const value = await promise;
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
