import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {setTimeout as delay} from "node:timers/promises";
import {OpenCode} from "@opencode/client";
import {withNativeTestHarness} from "./lib/native-test-harness.mjs";
import {startTrialServer} from "./lib/opencode-trial-server.mjs";
import {inspectNativeBrowser} from "./lib/opencode-native-browser.mjs";

// A real local workerd Coordinator + NativeAttempt connected to the unmodified
// full OpenCode CLI. Only the model response and remote artifact transport are
// fixtures. No target scans or paid inference are performed.
const {values} = parseArgs({options: {cli: {type: "string"}, output: {type: "string"},
  scenario: {type: "string"}, browser: {type: "boolean", default: false}, screenshots: {type: "string"},
  "probe-direct-followup": {type: "boolean", default: false}}});
if (!values.cli) throw new Error("Pass --cli /absolute/path/to/latest/opencode");
const scenarios = values.scenario ? [values.scenario] : ["advice", "tool", "cancel"];
for (const scenario of scenarios) assert.ok(["advice", "tool", "cancel"].includes(scenario));
const report = {experiment: "pentcloud-full-server-integration", recordedAt: new Date().toISOString(),
  platform: process.platform, architecture: process.arch,
  scope: "Local Cloudflare workerd; full OpenCode process on the test machine; scripted model; fixture Git transport", scenarios: []};
const app = fileURLToPath(new URL("../apps/control-plane/", import.meta.url));

for (const scenario of scenarios) {
  const result = {scenario, provider: [], checks: {}};
  report.scenarios.push(result);
  let opencode, provider;
  try {
    await withNativeTestHarness({root: app, workers: [{configPath: "test/native-opencode-server-probe/wrangler.jsonc"}]}, async (worker, url) => {
      const api = async (path, body) => {
        const response = await fetch(new URL(path, url), {method: body === undefined ? "GET" : "POST",
          ...(body === undefined ? {} : {body: JSON.stringify(body), headers: {"Content-Type": "application/json"}}),
          signal: AbortSignal.timeout(30000)});
        const text = await response.text();
        if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 3000)}`);
        return text ? JSON.parse(text) : null;
      };
      try {
        const prepared = await api("/prepare", {scenario});
        result.prepared = {id: prepared.id, agent: prepared.agent, model: prepared.model, baselineText: prepared.baselineText};
        provider = await scriptedProvider(scenario, result.provider, prepared.baselineText);
        const rules = [{action: "*", resource: "*", effect: "deny"},
          ...(scenario === "tool" ? [{action: "pentcloud_computer_read", resource: "*", effect: "allow"}] : [])];
        const config = {plugins: [], default_agent: prepared.agent,
          model: `${prepared.model.providerID}/${prepared.model.id}`, permissions: rules,
          agents: {build: {permissions: rules}, [prepared.agent]: {mode: "primary", system: prepared.prompt, permissions: rules}},
          providers: {[prepared.model.providerID]: {...prepared.providerConfig,
            settings: {...prepared.providerConfig.settings, baseURL: provider.url + "/v1", apiKey: "local-scripted-model", timeout: 60000}}},
          ...(scenario === "tool" ? {mcp: {servers: {pentcloud: {type: "remote", url: new URL(prepared.mcpPath, url).href,
            oauth: false, codemode: false, protocol: "legacy"}}}} : {})};
        opencode = await startTrialServer(values.cli, config);
        result.cliVersion = opencode.version;
        const client = OpenCode.make({baseUrl: opencode.url, headers: opencode.headers});
        result.health = await client.server.info();
        await api("/configure", {baseUrl: opencode.url, password: opencode.password});
        await api("/start", {});
        await until(async () => result.provider.some(call => call.primary), "Primary model request", 30000);
        result.whileRunning = await api("/status");
        if (scenario === "cancel") {
          await api("/cancel", {});
        } else {
          if (values.browser && scenario === "tool") {
            await client.session.update({sessionID: "ses_root", title: "PentCloud full-server trial"});
            result.browser = await inspectNativeBrowser(opencode, result, provider.release, async () =>
              until(async () => (await api("/status")).attempt?.execution?.result, "UI job completion", 30000), values.screenshots);
          }
          provider.release();
        }
        result.finished = await until(async () => {
          const status = await api("/status");
          result.lastStatus = status;
          if (status.error) throw new Error(status.error);
          return status.attempt?.execution?.result || status.result ? status : null;
        }, "PentCloud attempt settlement", 45000);
        // An attempt result alone is not proof that the Coordinator accepted it.
        result.finished = await until(async () => {
          const status = await api("/status");
          const job = status.coordinator?.jobs?.find(job => job.id === prepared.id);
          return !status.coordinator?.active && job?.status === (scenario === "cancel" ? "interrupted" : "completed") ? status : null;
        }, "Coordinator acceptance", 15000);
        result.checks.coordinatorSettled = true;
        const terminal = result.finished.attempt?.execution?.result ?? result.finished.result;
        if (scenario !== "cancel") result.checks.candidateAccepted = !!terminal?.outputCommit &&
          result.finished.acceptedHead === terminal.outputCommit && result.finished.receivedCandidate === terminal.outputCommit;
        if (scenario === "cancel") {
          result.remoteAfterCancel = await client.session.active();
          result.checks.remoteSessionStopped = !result.remoteAfterCancel.ses_root;
          result.checks.providerRequestAborted = await until(async () => result.provider.some(call => call.primary && call.cancelledBeforeResponse),
            "Remote model request cancellation", 10000);
        }
        const nativeSession = await client.session.get({sessionID: "ses_root"});
        result.nativeSession = {id: nativeSession.id, title: nativeSession.title};
        result.cliSessionList = await opencode.cli(["session", "list", "--format", "json"]);
        result.checks.cliSeesSameSession = result.cliSessionList.stdout.includes('"ses_root"');
        result.detach = await api("/detach", {});
        result.checks.historySurvivedClientDetach = result.detach.preserved;
        const beforeRestart = await client.session.context({sessionID: "ses_root"});
        await api("/detach", {});
        await opencode.restart();
        const afterRestart = await client.session.context({sessionID: "ses_root"});
        result.restart = {beforeMessages: beforeRestart.length, afterMessages: afterRestart.length,
          unchanged: JSON.stringify(beforeRestart) === JSON.stringify(afterRestart)};
        result.nativeFileRead = new TextDecoder().decode(await client.file.read({location: {directory: opencode.workspace}, path: "README.md"}));
        result.checks.serverFilesystemIsSeparate = result.nativeFileRead.includes("Separate full-server filesystem");
        result.provider = provider.observations;
        result.checks.scriptedPrimaryExecuted = result.provider.some(call => call.primary);
        result.checks.sessionSurvivedServerRestart = result.restart.unchanged;
        result.checks.expectedAttemptStatus = terminal?.status === (scenario === "cancel" ? "interrupted" : "completed");
        if (scenario === "tool") result.checks.modelReceivedRealWorkspaceRead = result.provider.some(call => call.hasBaselineToolResult);
        if (values.browser && scenario === "tool") {
          result.checks.nativeBrowserSessionVisible = result.browser?.sessionVisible === true && !result.browser?.error;
          result.checks.nativeBrowserResultVisible = result.browser?.completedAnswerVisible === true;
        }
        if (values["probe-direct-followup"] && scenario === "advice") {
          const receipt = await client.session.prompt({sessionID: "ses_root", text: "Inspector direct-followup trial: reply with a short greeting. Do not call tools."});
          await until(async () => result.provider.some(call => call.directFollowup) && !(await client.session.active()).ses_root,
            "Direct native prompt after completion", 10000);
          const after = await api("/status");
          result.directPromptAfterCompletion = {accepted: !!receipt.id, modelExecuted: result.provider.some(call => call.directFollowup),
            coordinatorJob: after.coordinator.jobs.find(job => job.id === prepared.id)?.status,
            coordinatorOwnsExecution: !!after.coordinator.active, acceptedCommitUnchanged: after.acceptedHead === terminal.outputCommit,
            originalHistoryEntries: result.finished.attempt.history.length, resultingHistoryEntries: after.attempt.history.length};
        }
        result.runtimeErrors = worker.getLogs().filter(entry => /error|failed|exception/i.test(JSON.stringify(entry))).slice(-15);
        for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name);
        result.ok = true;
      } finally {
        await api("/cleanup", {}).catch(error => {result.cleanupError = String(error);});
      }
    });
  } catch (error) {
    result.ok = false;
    result.error = {name: error.name, message: opencode ? opencode.clean(error.message) : error.message};
    result.serverLog = opencode?.logs();
  } finally {
    provider?.release();
    await provider?.close();
    await opencode?.close();
    result.cleanedUp = true;
  }
  console.log(JSON.stringify({scenario, ok: result.ok, checks: result.checks, error: result.error}));
}
const serialized = JSON.stringify(report, null, 2) + "\n";
if (values.output) {await mkdir(dirname(values.output), {recursive: true}); await writeFile(values.output, serialized);}
else console.log(serialized);
if (report.scenarios.some(result => !result.ok)) process.exitCode = 1;

async function until(operation, label, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {const result = await operation(); if (result) return result; await delay(100);}
  throw new Error(label + " did not complete within " + timeout + "ms");
}

async function scriptedProvider(scenario, observations, baselineText) {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const messages = body.messages ?? [];
      const text = JSON.stringify(messages);
      const primary = text.includes("Execute the pinned specialist launch");
      const tools = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name);
      const toolResult = messages.filter(message => message.role === "tool");
      const observation = {path: request.url, model: body.model, stream: body.stream, primary, tools,
        directFollowup: text.includes("Inspector direct-followup trial"),
        toolResultCount: toolResult.length, hasBaselineToolResult: toolResult.some(message => JSON.stringify(message).includes(baselineText.trim())),
        ...(toolResult.length ? {toolResults: toolResult} : {})};
      observations.push(observation);
      response.once("close", () => {if (!response.writableEnded) observation.cancelledBeforeResponse = true;});
      if (primary) await gate;
      if (response.destroyed) {observation.cancelledBeforeResponse = true; return;}
      const tool = tools.find(name => /computer_read$/.test(name));
      const callTool = primary && scenario === "tool" && !toolResult.length && tool;
      const answer = primary ? "PentCloud full-server trial completed: " + baselineText.trim() : "PentCloud full-server trial";
      const delta = callTool ? {role: "assistant", tool_calls: [{index: 0, id: "call_pentcloud_read_trial", type: "function",
        function: {name: tool, arguments: JSON.stringify({path: "README.md"})}}]} : {role: "assistant", content: answer};
      if (body.stream === false) {
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({id: "fixture", object: "chat.completion", model: body.model,
          choices: [{index: 0, message: delta, finish_reason: callTool ? "tool_calls" : "stop"}], usage: {prompt_tokens: 20, completion_tokens: 8, total_tokens: 28}}));
      } else {
        const frame = (delta, finish_reason) => "data: " + JSON.stringify({id: "fixture", object: "chat.completion.chunk", model: body.model,
          choices: [{index: 0, delta, finish_reason}]}) + "\n\n";
        response.writeHead(200, {"Content-Type": "text/event-stream"});
        response.end(frame(delta, null) + frame({}, callTool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
      }
    } catch (error) {response.writeHead(500); response.end(String(error));}
  });
  server.on("connection", socket => {sockets.add(socket); socket.once("close", () => sockets.delete(socket));});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, release, observations,
    close: async () => {release(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));}};
}
