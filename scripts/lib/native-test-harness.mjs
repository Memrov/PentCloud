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
