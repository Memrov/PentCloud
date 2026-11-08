import {execFile, spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify, stripVTControlCharacters} from "node:util";

// Isolated test infrastructure. A client disconnect never owns this process.
export async function startTrialServer(cli, config) {
  const directory = await mkdtemp(join(tmpdir(), "pentcloud-opencode-integration-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "Separate full-server filesystem; not the PentCloud Durable Object workspace.\n");
  const password = randomBytes(32).toString("base64url");
  const inherited = ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const env = {...Object.fromEntries(inherited.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"),
    OPENCODE_CONFIG_DIR: join(directory, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), NO_COLOR: "1", TERM: "dumb"};
  const clean = text => stripVTControlCharacters(String(text)).replaceAll(password, "[redacted]");
  const version = clean((await promisify(execFile)(cli, ["--version"], {env, cwd: workspace, timeout: 10000})).stdout).trim();
  let child, closed, output = "";
  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      await closed;
      clearTimeout(force);
    }
  };
  const start = async port => {
    output = "";
    child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"]});
    closed = new Promise(resolve => child.once("close", resolve));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCode did not start: " + clean(output))), 25000);
      const collect = chunk => {
        output = (output + chunk.toString()).slice(-24000);
        const found = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (found) {clearTimeout(timer); resolve(found[1]);}
      };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.once("error", error => {clearTimeout(timer); reject(error);});
      child.once("close", code => {clearTimeout(timer); reject(new Error(`OpenCode exited ${code}: ${clean(output)}`));});
    });
  };
  try {
    const url = await start(0);
    return {url, password, workspace, version, clean, logs: () => clean(output),
      headers: {Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64")},
      cli: async args => {
        const result = await promisify(execFile)(cli, ["--server", url, ...args], {env, cwd: workspace, timeout: 20000});
        return {exitCode: 0, stdout: clean(result.stdout), stderr: clean(result.stderr)};
      },
      restart: async () => {await stop(); await start(Number(new URL(url).port));},
      close: async () => {await stop(); await rm(directory, {recursive: true, force: true});}};
  } catch (error) {await stop(); await rm(directory, {recursive: true, force: true}); throw error;}
}
