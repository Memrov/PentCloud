import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verificationTasks } from "./verification-tasks.ts";
const read = async (path) =>
  JSON.parse(await readFile(new URL("../" + path, import.meta.url), "utf8"));
test("deployment button includes the Computer pilot and all eleven native tool images", async () => {
  const config = await read("wrangler.jsonc"),
    packs = await read("infra/tool-packs/wrangler.jsonc"),
    pkg = await read("package.json");
  assert.equal(config.main, "apps/control-plane/src/customer/worker.ts");
  assert.equal(config.account_id, undefined);
  assert.equal(config.services, undefined);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.containers.length, 12);
  const computer = config.containers.find(
    (container) => container.class_name === "NativeAttempt"
  );
  assert.equal(
    computer?.images.computer.dockerfile,
    "infra/computer/Dockerfile"
  );
  assert.equal(config.vars.PENTCLOUD_COMPUTER_BACKEND, "container");
  assert.deepEqual(
    config.containers
      .filter((c) => c.class_name !== "NativeAttempt")
      .map((c) => c.class_name),
    packs.durable_objects.bindings.map((b) => b.class_name)
  );
  const classes = new Set(
    config.migrations.flatMap((m) => m.new_sqlite_classes ?? [])
  );
  for (const c of config.containers) {
    assert(classes.has(c.class_name));
    assert.equal(c.scheduling_policy, "durable_object");
    assert.equal(Object.keys(c.images).length, 1);
    assert(!JSON.stringify(c).includes("Kali"));
  }
  assert.equal(config.vars.ACCESS_AUD, undefined);
  assert.equal(config.vars.ACCESS_TEAM_DOMAIN, undefined);
  assert.equal(config.secrets, undefined);
  assert.equal(pkg.scripts.build, "node scripts/build-customer.mjs");
  assert.equal(
    verificationTasks["gate:customer:build"].command,
    "node scripts/build-customer.mjs"
  );
  assert.equal(verificationTasks["gate:customer:build"].cache, false);
  assert.equal(
    pkg.scripts.deploy,
    verificationTasks["gate:customer:deploy"].command
  );
  assert.equal(verificationTasks["gate:customer:deploy"].cache, false);
  assert.match(
    verificationTasks["gate:customer:deploy"].command,
    /--config apps\/control-plane\/dist-customer\/worker\/wrangler.json$/
  );
});

test("selected Worker names isolate Artifacts and wizard metadata for each installation", async () => {
  const { customerConfig } = await import("./build-customer.mjs"),
    source = await read("wrangler.jsonc");
  const first = customerConfig(structuredClone(source), {
      worker: "customer-one",
      accountId: "a".repeat(32)
    }),
    second = customerConfig(structuredClone(source), {
      worker: "customer-two",
      accountId: "b".repeat(32)
    });
  for (const value of [first, second]) {
    assert.equal(value.artifacts[0].namespace, value.name);
    assert.equal(value.workflows, undefined);
    assert.equal(value.vars.PENTCLOUD_WORKER_NAME, value.name);
    assert.equal(value.vars.ARTIFACTS_NAMESPACE, value.name);
    assert.deepEqual(value.triggers, { events: [] });
  }
  assert.notEqual(first.artifacts[0].namespace, second.artifacts[0].namespace);
  assert.equal(second.vars.PENTCLOUD_ACCOUNT_ID, "b".repeat(32));
});

test("native image builds use the matching SDK base digests and isolate build-only tools", async () => {
  const config = await read("wrangler.jsonc");
  for (const container of config.containers.filter(
    (value) => value.class_name !== "NativeAttempt"
  )) {
    const [pack, image] = Object.entries(container.images)[0],
      lock = await read(
        "node_modules/@memrov2/pentcloud-" + pack + "/tools.lock.json"
      );
    assert.equal(image.dockerfile, "infra/tool-packs/Dockerfile");
    assert.equal(image.build_vars.PACK, pack);
    assert.equal(
      image.build_vars.RUNTIME_IMAGE.split("@")[1],
      lock.baseImage.split("@")[1]
    );
  }
  const docker = await readFile(
    new URL("../infra/tool-packs/Dockerfile", import.meta.url),
    "utf8"
  );
  assert.match(docker, /libarchive-tools/);
  assert.match(docker, /COPY --from=prepare \/prepared\/ \//);
  assert.match(docker, /CMD \[\]/);
});

test("single-character Worker names meet Artifacts namespace rules without sharing installations", async () => {
  const { customerConfig } = await import("./build-customer.mjs"),
    source = await read("wrangler.jsonc");
  const names = ["a", "0", "b", "a-b", "a".repeat(63)];
  const configs = names.map((worker) =>
    customerConfig(structuredClone(source), { worker })
  );
  const namespaces = configs.map((config) => config.artifacts[0].namespace);
  for (const config of configs) {
    const namespace = config.artifacts[0].namespace;
    assert(namespace.length >= 2 && namespace.length <= 63);
    assert.match(namespace, /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9._])?$/);
    assert.equal(config.vars.ARTIFACTS_NAMESPACE, namespace);
    assert.equal(config.workflows, undefined);
    assert.deepEqual(config.triggers, { events: [] });
    assert.equal(config.vars.PENTCLOUD_WORKER_NAME, config.name);
  }
  assert.equal(new Set(namespaces).size, names.length);
  assert.throws(
    () => customerConfig(structuredClone(source), { worker: "a-" }),
    /Worker name/
  );
});

test("app and customer deployments select separate generated Workers and asset directories", async () => {
  const app = await read("apps/control-plane/package.json");
  const customerConfig = await read("wrangler.jsonc"),
    appConfig = await read("apps/control-plane/wrangler.jsonc");
  const customerTarget =
    verificationTasks["gate:customer:deploy"].command.split("--config ")[1];
  const appTarget =
    "apps/control-plane/" + app.scripts.deploy.split("--config ")[1];
  assert.notEqual(
    customerTarget,
    appTarget,
    "Deploy commands must never select the other build target"
  );
  assert.equal(
    customerTarget.replace("worker/wrangler.json", "client"),
    customerConfig.assets.directory
  );
  assert.equal(
    appTarget.replace("worker/wrangler.json", "client"),
    "apps/control-plane/" + appConfig.assets.directory.replace(/^\.\//, "")
  );
});

test("root dry-run fails closed when only app output and its native redirection exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pentcloud-deploy-target-"));
  try {
    const appOutput = join(directory, "apps/control-plane/dist/worker");
    await mkdir(appOutput, { recursive: true });
    await writeFile(
      join(appOutput, "wrangler.json"),
      JSON.stringify({
        name: "app-only",
        main: "index.js",
        compatibility_date: "2026-10-30",
        no_bundle: true
      })
    );
    await writeFile(
      join(appOutput, "index.js"),
      'export default { fetch() { return new Response("app-only") } };'
    );
    await mkdir(join(directory, ".wrangler/deploy"), { recursive: true });
    await writeFile(
      join(directory, ".wrangler/deploy/config.json"),
      JSON.stringify({
        configPath: "../../apps/control-plane/dist/worker/wrangler.json"
      })
    );
    const [command, ...args] =
      verificationTasks["gate:customer:deploy"].command.split(" ");
    assert.equal(command, "wrangler");
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)
        ),
        ...args,
        "--dry-run",
        "--containers-rollout=none"
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
      }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /Could not read file: apps\/control-plane\/dist-customer\/worker\/wrangler.json/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
