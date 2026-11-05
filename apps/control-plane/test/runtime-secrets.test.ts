import {expect,it} from "vitest";
import {knownRuntimeSecrets} from "../../../shared/runtime-secrets";
it("redacts legacy fixture values without reading a Store or making them authentication",()=>{
  expect(knownRuntimeSecrets({CONTROL_TOKEN:"local-fixture",CONTROL_AUTH:{get(){throw Error("must never read");}}})).toEqual(["local-fixture"]);
  expect(knownRuntimeSecrets({})).toEqual([]);
});
