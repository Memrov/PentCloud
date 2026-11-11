import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transferConfigs } from "./prepare-dev-transfer.mjs";

const root = new URL("../", import.meta.url);
const packs = [
  "recon",
  "http",
  "nuclei",
  "sqlmap",
  "service",
  "web-context",
  "pcap",
  "file-analysis",
  "password",
  "reference",
  "metasploit"
];
const read = async (name) =>
  JSON.parse(await readFile(new URL(name, root), "utf8"));
const source = await read("wrangler.jsonc");
const gateway = await read("wrangler.dev.gateway.jsonc");
const targets = Object.fromEntries(
  await Promise.all(
    packs.map(async (pack) => [pack, await read(`wrangler.dev.${pack}.jsonc`)])
  )
);

void test("every existing tool namespace moves through pending and committed states", () => {
  const stages = transferConfigs(source, gateway, targets);
  assert.equal(Object.keys(stages["01-source-convert"].exports).length, 11);
  for (const pack of packs) {
    const receive = stages[`02-${pack}-receive`];
    const bound = stages[`04-${pack}-bound`];
    const className = bound.durable_objects.bindings[0].class_name;
    assert.equal(receive.exports[className].state, "expecting-transfer");
    assert.equal(receive.durable_objects.bindings.length, 0);
    assert.equal(
      bound.exports[className].container,
      `pentcloud-dev-tools-${pack}`
    );
    assert.equal(
      stages["03-source-commit"].exports[className].transferred_to,
      bound.name
    );
  }
  assert.equal(stages["05-source-gateway"].name, "pentcloud-dev-tools");
  assert.equal(stages["05-source-gateway"].services.length, 11);
});
