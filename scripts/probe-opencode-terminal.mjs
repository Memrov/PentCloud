import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs, promisify, stripVTControlCharacters} from "node:util";
import {OpenCode} from "@opencode/client";
import {withNativeTestHarness} from "./lib/native-test-harness.mjs";

// An opt-in compatibility experiment, not a production route or a CI assertion
// that upstream limitations should remain forever. The Worker fixture subclasses
// PentCloud's real NativeAttempt and uses the installed, unmodified OpenCode SDK.
const {values} = parseArgs({options: {cli: {type: "string"}, output: {type: "string"}}});
const app = fileURLToPath(new URL("../apps/control-plane/", import.meta.url));
const packageVersion = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")).version;
const report = {experiment: "upstream-opencode-terminal", recordedAt: new Date().toISOString(), versions: {
  node: process.version,
  agents: await packageVersion("../apps/control-plane/node_modules/agents/package.json"),
  sdk: await packageVersion("../node_modules/@opencode/sdk/package.json"),
  plugin: await packageVersion("../node_modules/@opencode/plugin/package.json"),
  client: await packageVersion("../node_modules/@opencode/client/package.json"),
}};

await withNativeTestHarness({
  root: app,
  workers: [{configPath: "test/native-attempt-probe/wrangler.jsonc"}],
}, async (server, url) => {
  const response = await fetch(new URL("/sdk-opencode-terminal?name=terminal-trial", url), {
    signal: AbortSignal.timeout(60000),
  });
  const native = await response.json();
  assert.equal(response.status, 200, JSON.stringify(native));
  assert.equal(native.health.ok, true, "The existing embedded host must be healthy");
  assert.equal(native.root.id, native.root.storedID);
  assert.ok(native.root.historyCount > 0, "Probe must attach to an existing native session with history");
  assert.equal(native.root.nativeHistoryMatches, true);
  for (const [name, preserved] of Object.entries(native.preserved)) {
    assert.equal(preserved, true, `${name} changed during inspection`);
  }
  for (const [name, count] of Object.entries(native.activity)) {
    assert.equal(count, 0, `${name} must not be invoked by this passive trial`);
  }
  report.native = native;

  const baseUrl = new URL("/opencode-attach/terminal-trial", url).href;
  const requests = [];
  const client = OpenCode.make({baseUrl, fetch: async (input, init) => {
    const request = new Request(input, init);
    const result = await fetch(request);
    requests.push({method: request.method, path: new URL(request.url).pathname,
      status: result.status, contentType: result.headers.get("content-type"),
      ...(!result.ok ? {body: (await result.clone().text()).slice(0,2000)} : {})});
    return result;
  }});
  report.stockClient = {};
  for (const [name, operation] of [
    ["serverInfo", () => client.server.info({signal: AbortSignal.timeout(10000)})],
    ["existingSession", () => client.session.get({sessionID: native.root.id}, {signal: AbortSignal.timeout(10000)})],
  ]) {
    try { report.stockClient[name] = {ok: true, value: await operation()}; }
    catch (error) { report.stockClient[name] = {ok: false, name: error.name, message: error.message,
      reason: error.reason}; }
  }
  report.requests = requests;

  if (values.cli) report.cli = await runCLI(values.cli, ["--server", baseUrl, "--session", native.root.id]);
  else report.cli = {tested: false, reason: "Pass --cli /absolute/path/to/opencode for a real terminal-client attempt"};

  // Also try the exact handler in the user-supplied Cloudflare SDK example.
  // It returns server.info() for every path; a 200 is not proof of a session API.
  const documentedUrl = new URL("/opencode-docs-attach/terminal-trial", url).href;
  const documentedRequests = [];
  const documentedClient = OpenCode.make({baseUrl: documentedUrl, fetch: async (input, init) => {
    const request = new Request(input, init);
    const result = await fetch(request);
    documentedRequests.push({method: request.method, path: new URL(request.url).pathname,
      status: result.status, body: await result.clone().json()});
    return result;
  }});
  report.documentedHandler = {requests: documentedRequests};
  for (const [name, operation, matches] of [
    ["serverInfo", () => documentedClient.server.info({signal: AbortSignal.timeout(10000)}), value => typeof value?.version === "string"],
    ["existingSession", () => documentedClient.session.get({sessionID: native.root.id}, {signal: AbortSignal.timeout(10000)}), value => value?.id === native.root.id],
    ["location", () => documentedClient.location.get({}, {signal: AbortSignal.timeout(10000)}), value => typeof value?.project?.id === "string"],
  ]) {
    try {
      const value = await operation();
      report.documentedHandler[name] = {httpOk: true, payloadMatchesEndpoint: matches(value), value: value ?? null};
    } catch (error) {
      report.documentedHandler[name] = {httpOk: false, name: error.name, message: error.message};
    }
  }
  if (values.cli) report.documentedHandler.cli = await runCLI(values.cli, ["--server", documentedUrl, "session", "list", "--format", "json"]);

  // Keep only messages relevant to this attachment experiment. These contain
  // fixture data, not production conversations, credentials, or target output.
  const logs = server.getLogs();
  report.runtimeErrors = logs.filter(entry => /Pty\.create|FileSystem\.list|fetch\(\).*not|fetch.*handler|does not implement|did not implement/i.test(JSON.stringify(entry))).slice(-12);
});

const formatted = JSON.stringify(report, null, 2) + "\n";
if (values.output) {
  await mkdir(dirname(values.output), {recursive: true});
  await writeFile(values.output, formatted);
}
console.log(formatted);

async function runCLI(binary, args) {
  const directory = await mkdtemp(join(tmpdir(), "pentcloud-opencode-terminal-"));
  const env = {...process.env,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"),
    NO_COLOR: "1", TERM: "dumb",
  };
  try {
    const version = stripVTControlCharacters((await promisify(execFile)(binary, ["--version"], {
      cwd: directory, env, timeout: 5000,
    })).stdout).trim();
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, args, {cwd: directory, env, stdio: ["ignore", "pipe", "pipe"]});
      let output = "", timedOut = false;
      const collect = chunk => { output = (output + chunk.toString()).slice(-16000); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      let forceKill;
      const timer = setTimeout(() => {
        timedOut = true; child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, 20000);
      child.once("error", error => {clearTimeout(timer); clearTimeout(forceKill); reject(error);});
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer); clearTimeout(forceKill);
        const recordedArgs = args.map((arg, index) => args[index - 1] === "--server" ? "<local-worker>" + new URL(arg).pathname : arg);
        resolve({tested: true, version, args: recordedArgs,
          exitCode, signal, timedOut, output: stripVTControlCharacters(output)});
      });
    });
  } finally { await rm(directory, {recursive: true, force: true}); }
}
