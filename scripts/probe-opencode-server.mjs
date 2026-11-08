import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {parseArgs, promisify, stripVTControlCharacters} from "node:util";
import {OpenCode} from "@opencode/client";

// Positive control for the native `serve` architecture. This deliberately starts
// a separate temporary host; it is not an adapter to PentCloud's Durable Objects.
const {values} = parseArgs({options: {cli: {type: "string"}, output: {type: "string"}}});
if (!values.cli) throw new Error("Pass --cli /absolute/path/to/the/latest/opencode");
const directory = await mkdtemp(join(tmpdir(), "pentcloud-opencode-server-"));
const workspace = join(directory, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "README.md"), "Standalone server control\n");
const password = randomBytes(32).toString("base64url");
const inherited = ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const env = {...Object.fromEntries(inherited.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
  XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"),
  OPENCODE_CONFIG_DIR: join(directory, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify({plugins: []}),
  NO_COLOR: "1", TERM: "dumb",
};
const clean = text => stripVTControlCharacters(text).replaceAll(password, "[redacted]");
const exec = promisify(execFile);
const report = {experiment: "standalone-opencode-server-control", recordedAt: new Date().toISOString()};
let child, closed, output = "";
try {
  report.cliVersion = clean((await exec(values.cli, ["--version"], {env, cwd: workspace, timeout: 5000})).stdout).trim();
  child = spawn(values.cli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"],
  });
  closed = new Promise(resolve => child.once("close", (code, signal) => resolve({code, signal})));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start within 25 seconds: " + clean(output))), 25000);
    const collect = chunk => {
      output = (output + chunk.toString()).slice(-16000);
      const found = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (found) {clearTimeout(timer); resolve(found[1]);}
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", code => {clearTimeout(timer); reject(new Error(`Server exited ${code}: ${clean(output)}`));});
  });
  const requests = [];
  const client = OpenCode.make({baseUrl: url, headers: {Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64")},
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const result = await fetch(request, {signal: AbortSignal.timeout(10000)});
      requests.push({method: request.method, path: new URL(request.url).pathname, status: result.status});
      return result;
    },
  });
  report.health = await client.server.info();
  report.location = await client.location.get({location: {directory: workspace}});
  try { report.embeddedSession = {found: true, value: await client.session.get({sessionID: "ses_root"})}; }
  catch (error) { report.embeddedSession = {found: false, name: error.name, message: error.message}; }
  const created = await client.session.create({title: "Standalone server control", location: {directory: workspace}});
  const loaded = await client.session.get({sessionID: created.id});
  assert.equal(loaded.id, created.id);
  report.ownSession = {created: created.id, loaded: loaded.id, title: loaded.title, sameSession: true};
  const cli = await exec(values.cli, ["--server", url, "session", "list", "--format", "json"], {
    env, cwd: workspace, timeout: 15000,
  });
  report.cliSessionList = {exitCode: 0, stdout: clean(cli.stdout), stderr: clean(cli.stderr)};
  const capture = async operation => {
    try { return {ok: true, value: await operation()}; }
    catch (error) { return {ok: false, name: error.name, message: error.message}; }
  };
  report.fileList = await capture(() => client.file.list({location: {directory: workspace}, path: workspace}));
  report.ptyCreate = await capture(async () => {
    const terminal = await client.pty.create({location: {directory: workspace}, command: "/usr/bin/printf",
      args: ["pentcloud-server-control"], cwd: workspace, title: "Harmless server control"});
    try { await client.pty.remove({location: {directory: workspace}, ptyID: terminal.data?.id ?? terminal.id}); }
    catch { /* A completed short-lived PTY may already be reaped. */ }
    return terminal;
  });
  const page = await fetch(url, {signal: AbortSignal.timeout(10000)});
  const html = await page.text();
  report.webShell = {status: page.status, contentType: page.headers.get("content-type"),
    html: /<html/i.test(html), title: html.match(/<title>(.*?)<\/title>/i)?.[1], bytes: Buffer.byteLength(html)};
  report.requests = requests;
  report.scope = "Separate local OpenCode server; no model prompt, production connection, or migration of PentCloud sessions";
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed;
    clearTimeout(force);
  }
  await rm(directory, {recursive: true, force: true});
  report.cleanedUp = true;
}
const serialized = JSON.stringify(report, null, 2) + "\n";
if (values.output) {await mkdir(dirname(values.output), {recursive: true}); await writeFile(values.output, serialized);}
console.log(serialized);
