import {expect,it} from "vitest";
import {knownRuntimeSecrets} from "../../../shared/runtime-secrets";
import { SEARCH_PROVIDERS } from "../../../shared/search-providers";
it("redacts legacy fixture values without reading a Store or making them authentication",()=>{
  expect(knownRuntimeSecrets({CONTROL_TOKEN:"local-fixture",CONTROL_AUTH:{get(){throw Error("must never read");}}})).toEqual(["local-fixture"]);
  expect(knownRuntimeSecrets({})).toEqual([]);
});
it("redacts every plain search key without resolving Store bindings or unrelated values", () => {
  const env = Object.fromEntries(SEARCH_PROVIDERS.map(({ binding }, index) => [binding, `search-fixture-${index}`]));
  expect(knownRuntimeSecrets({ ...env, unrelated: "not-a-runtime-secret" })).toEqual(SEARCH_PROVIDERS.map((_, index) => `search-fixture-${index}`));
  expect(knownRuntimeSecrets(Object.fromEntries(SEARCH_PROVIDERS.map(({ binding }) => [binding, { get() { throw new Error("must never read"); } }])))).toEqual([]);
});
