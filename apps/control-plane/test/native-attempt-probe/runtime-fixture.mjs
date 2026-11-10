import assert from "node:assert/strict";
import { exports } from "cloudflare:workers";

export const fixtureResponse = (path) =>
  exports.default.fetch(new Request(`http://attempt-fixture.invalid/${path}`));

export async function probe(path) {
  const response = await fixtureResponse(path);
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.ok(!Object.hasOwn(value, "error"), JSON.stringify(value));
  return value;
}
export const roles = [
  "primary",
  "adviser",
  "reporter",
  "coder",
  "maintenance",
  "memorist",
  "pentester",
  "searcher"
];
export const nativeNames = [
  "pentcloud_read_evidence",
  "cloudflare_browser",
  "computer_read",
  "computer_read_bytes",
  "computer_ls",
  "computer_find",
  "computer_grep",
  "computer_write",
  "computer_edit",
  "computer_delete",
  "computer_exec"
];
