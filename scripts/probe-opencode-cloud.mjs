import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {parseArgs} from "node:util";
import {OpenCode} from "@opencode/client";
import {inspectNativeBrowser} from "./lib/opencode-native-browser.mjs";

// Attach to the already booted disposable cloud fixture. The deployment owner
// separately destroys the VM/app/Worker and revokes its upload token.
const {values} = parseArgs({options: {credentials: {type: "string"}, output: {type: "string"}, screenshots: {type: "string"}}});
if (!values.credentials || !values.output) throw new Error("Pass --credentials <0600 JSON file> --output <report.json>");
const {url, controlToken} = JSON.parse(await readFile(values.credentials, "utf8"));
if (typeof controlToken !== "string" || !controlToken || new URL(url).protocol !== "https:") throw new Error("Expected isolated HTTPS cloud fixture credentials");
const clean = value => String(value).replaceAll(controlToken, "[redacted]").replaceAll(Buffer.from("opencode:" + controlToken).toString("base64"), "[redacted]");
const report = {experiment: "pentcloud-full-server-cloud", recordedAt: new Date().toISOString(), url, checks: {}};
const api = async (path, body) => {
  const response = await fetch(new URL(path, url), {method: body === undefined ? "GET" : "POST",
    headers: {Authorization: "Bearer " + controlToken, ...(body === undefined ? {} : {"Content-Type": "application/json"})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(30000)});
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${clean(text).slice(0, 3000)}`);
  return JSON.parse(text);
};
const until = async (read, description, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {const value = await read(); if (value) return value; await delay(250);}
  throw new Error(description + " timed out");
};
try {
  report.host = await api("/__trial/host");
  assert.equal(report.host.phase, "ready");
  assert.equal(report.host.health.version, "2.2.6");
  report.checks.latestFullServerHealthy = report.host.latestVersion === "2.2.6";
  report.before = await api("/__trial/status");
  const headers = {Authorization: "Basic " + Buffer.from("opencode:" + controlToken).toString("base64")};
  const client = OpenCode.make({baseUrl: url, headers});
  await client.session.update({sessionID: "ses_root", title: "PentCloud full-server trial"});
  const accepted = () => until(async () => {
    const state = await api("/__trial/status");
    report.lastState = state;
    const job = state.coordinator.jobs.find(job => job.id === "job-0");
    return job?.status === "completed" && !state.coordinator.active ? state : null;
  }, "Cloud Coordinator acceptance");
  report.browser = await inspectNativeBrowser({url, password: controlToken, clean}, {scenario: "cloud-tool"},
    () => api("/__trial/release", {}), accepted, values.screenshots);
  await api("/__trial/release", {});
  report.finished = await accepted();
  report.native = await api("/__trial/native");
  report.detached = await api("/__trial/detach", {});
  report.hostAfter = await api("/__trial/host");
  const result = report.finished.attempt.execution.result;
  report.checks.nativeBrowserSessionVisible = report.browser.sessionVisible === true && !report.browser.error;
  report.checks.nativeBrowserResultVisible = report.browser.completedAnswerVisible === true;
  report.checks.coordinatorAcceptedCandidate = result.status === "completed" && result.outputCommit === report.finished.acceptedHead &&
    result.outputCommit === report.finished.receivedCandidate;
  report.checks.mcpReadReturnedToModel = report.hostAfter.provider.some(call => call.hasBaselineToolResult);
  report.checks.cliSeesSameSession = JSON.stringify(report.native.cliSessions).includes('"ses_root"');
  report.checks.historySurvivedClientDetach = report.detached.preserved;
  report.checks.serverFilesystemIsSeparate = report.native.serverFilesystemIsSeparate;
  report.auth = {adminWithoutCredential: (await fetch(new URL("/__trial/host", url))).status,
    mcpWithoutCredential: (await fetch(new URL("/mcp", url))).status};
  report.checks.trialRoutesRequireCredential = report.auth.adminWithoutCredential === 401 && report.auth.mcpWithoutCredential === 401;
  for (const [name, passed] of Object.entries(report.checks)) assert.equal(passed, true, name);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = clean(error.stack ?? error);
  report.hostAfterFailure = await api("/__trial/host").catch(error => ({error: clean(error)}));
} finally {
  // Always release fixture requests; leave resource deletion to the owner.
  await api("/__trial/release", {}).catch(() => undefined);
  await mkdir(dirname(values.output), {recursive: true});
  await writeFile(values.output, clean(JSON.stringify(report, null, 2)) + "\n");
}
console.log(JSON.stringify({ok: report.ok, checks: report.checks, error: report.error}));
if (!report.ok) process.exitCode = 1;
