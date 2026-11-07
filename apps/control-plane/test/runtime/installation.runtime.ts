/// <reference types="@cloudflare/vitest-plugin/types" />
import {env,exports} from "cloudflare:workers";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {accessHeaders,accessKeys} from "./access-fixture";
import type {RuntimeFixtureEnv,RecordedCall} from "./router-fixture";

const app=exports as unknown as {default:Fetcher};
const coordinator=()=>(env as unknown as RuntimeFixtureEnv).COORDINATOR.getByName("global");
const sha="a".repeat(40),previous="b".repeat(40);
async function authorized(path:string,value?:unknown,extra:HeadersInit={}){
  return app.default.fetch(new Request("https://operator.test/v1/"+path,{method:value===undefined?"GET":"POST",headers:await accessHeaders(extra),...(value===undefined?{}:{body:JSON.stringify(value)})}));
}
const calls=async()=>JSON.parse(await coordinator().calls()) as RecordedCall[];
beforeEach(async()=>{accessKeys();await coordinator().clearCalls();});
afterEach(()=>vi.restoreAllMocks());

it("authenticates release info and projects only public installation provenance",async()=>{
  expect((await app.default.fetch("https://operator.test/v1/installation")).status).toBe(401);
  const response=await authorized("installation",undefined,{"X-Fixture-Release-SHA":sha,"X-Fixture-Installer-Schema":"2","X-Fixture-Tool-Backend":"tool-packs"});
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({schemaVersion:1,sourceCommit:sha,installerSchema:2,backend:"tool-packages",versionId:"fixture-native-version"});
  expect(await (await authorized("installation",undefined,{"X-Fixture-Release-SHA":"not-a-commit","X-Fixture-Installer-Schema":"other"})).json()).toEqual({schemaVersion:1,sourceCommit:null,installerSchema:null,backend:"legacy-toolbox",versionId:"fixture-native-version"});
  expect(await (await authorized("installation",undefined,{"X-Fixture-Tool-Backend":"unconfigured"})).json()).toMatchObject({sourceCommit:null,installerSchema:null,backend:"unconfigured"});
  expect(await calls()).toEqual([]);
});

it("validates upgrade ownership and source identity before forwarding authenticated mutations",async()=>{
  for(const path of ["lifecycle/prepare-upgrade","lifecycle/finish-upgrade"]){
    expect((await app.default.fetch("https://operator.test/v1/"+path,{method:"POST",body:JSON.stringify({operationId:"upgrade-1",sourceCommit:sha})})).status).toBe(401);
  }
  for(const value of [{operationId:"",sourceCommit:sha},{operationId:"../escape",sourceCommit:sha},{operationId:"a".repeat(101),sourceCommit:sha},{operationId:"upgrade-1",sourceCommit:"A".repeat(40)},{operationId:"upgrade-1",sourceCommit:sha,previousSourceCommit:"bad"},{operationId:"upgrade-1",sourceCommit:sha,extra:true}]){
    expect((await authorized("lifecycle/prepare-upgrade",value)).status).toBe(400);
  }
  expect(await calls()).toEqual([]);
  const value={operationId:"upgrade-1",sourceCommit:sha,previousSourceCommit:previous};
  expect((await authorized("lifecycle/prepare-upgrade",value)).status).toBe(200);
  expect(await calls()).toEqual([{method:"prepareUpgrade",args:[value]}]);
});

it("keeps maintenance closed until the deployed runtime matches the requested release",async()=>{
  const value={operationId:"upgrade-1",sourceCommit:sha};
  expect((await authorized("lifecycle/finish-upgrade",value)).status).toBe(409);
  expect((await authorized("lifecycle/finish-upgrade",value,{"X-Fixture-Release-SHA":previous})).status).toBe(409);
  expect((await authorized("lifecycle/finish-upgrade",{...value,previousSourceCommit:previous},{"X-Fixture-Release-SHA":sha})).status).toBe(400);
  expect(await calls()).toEqual([]);
  expect((await authorized("lifecycle/finish-upgrade",value,{"X-Fixture-Release-SHA":sha})).status).toBe(200);
  expect(await calls()).toEqual([{method:"finishUpgrade",args:[value]}]);
});
