import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { withNativeTestHarness } from "./lib/native-test-harness.mjs";

const app = fileURLToPath(new URL("../apps/control-plane/", import.meta.url));
await withNativeTestHarness(
  {
    root: app,
    workers: [{ configPath: "test/native-attempt-probe/wrangler.jsonc" }]
  },
  async (_server, url) => {
    const response = await fetch(new URL("/memory-contract", url));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const matches = (key) => result[key].matches;
    const paths = (key) => [
      ...new Set(matches(key).map((match) => match.path))
    ];
    assert.ok(
      matches("sameAttempt").some(
        (match) => match.text === "same-attempt-needle"
      ),
      "new untracked memory must be searchable before publication"
    );
    assert.deepEqual(
      matches("wrongLanguage"),
      [],
      "required language selector must exclude other language"
    );
    assert.deepEqual(
      paths("guides"),
      [result.paths.install.path],
      "guide retrieval must enforce kind and guide type"
    );
    assert.deepEqual(
      paths("answers"),
      [result.paths.answer.path],
      "answer retrieval must enforce kind and answer type"
    );
    assert.deepEqual(
      matches("wrongAnswerType"),
      [],
      "answer type must not be silently ignored"
    );
    assert.deepEqual(
      paths("scoped"),
      [result.paths.scoped.path],
      "task and subtask selectors must exclude other native records"
    );
    assert.deepEqual(
      paths("argumentScoped"),
      [result.paths.argumentScoped.path],
      "original numeric launch arguments must retain their explicit scope"
    );
    assert.deepEqual(
      matches("mappedButNoMatch"),
      [],
      "known scope with no literal hit remains a normal empty result"
    );
    assert.match(
      result.unmapped ?? "",
      /no.*(?:task|scope).*metadata|cannot map/i,
      "unmapped original numeric IDs need an explicit error"
    );
    assert.match(
      result.unmappedSubtask ?? "",
      /cannot map/i,
      "known task does not justify silently ignoring an unknown subtask"
    );
    assert.deepEqual(
      paths("legacy"),
      [".pentagi/memory/code/legacy.md"],
      "previous accepted format must retain typed retrieval"
    );
    assert.equal(result.noModel, 0);
    assert.equal(result.noScanner, 0);
    const publishedResponse = await fetch(new URL("/memory", url));
    const published = await publishedResponse.json();
    assert.equal(publishedResponse.status, 200, JSON.stringify(published));
    assert.ok(published.acceptedHead);
    assert.ok(
      published.committedFiles.some((path) =>
        path.startsWith(".pentagi/memory/code/")
      )
    );
    assert.ok(
      published.found.matches.some(
        (match) => match.text === "native-memory-marker"
      ),
      "fresh memorist must still find previously published code across document kinds"
    );
    console.log(
      "native-memory-contract: same-attempt, original selectors, numeric scope and legacy retrieval passed"
    );
  }
);
