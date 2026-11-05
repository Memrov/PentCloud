/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {accessKeys,accessHeaders} from "./access-fixture";
import type {RuntimeFixtureEnv} from "./router-fixture";
const bindings=env as unknown as RuntimeFixtureEnv, app=exports as unknown as {default:Fetcher};
const control=()=>bindings.COORDINATOR.getByName("global");
const call=async(path:string,body?:unknown,authorized=true)=>app.default.fetch("https://setup.test/v1/ui"+path,{method:body?"POST":"GET",headers:authorized?await accessHeaders({"Content-Type":"application/json"}):{},...(body?{body:JSON.stringify(body)}:{})});
afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{accessKeys();await control().clearCalls();});
it("authenticates key writes and does not echo their value",async()=>{
  const value={id:"key-one",purpose:"api",label:"API",value:"private-api-test-value",revision:null};
  expect((await call("/onboarding/credential.save",value,false)).status).toBe(401);
  expect(JSON.parse(await control().calls())).toEqual([]);
  const result=await call("/onboarding/credential.save",value);
  expect(result.status).toBe(200);expect(await result.text()).not.toContain(value.value);
  expect(JSON.parse(await control().calls())[0]).toMatchObject({method:"onboardingAction",args:["credential.save",value,"operator"]});
});
it("reads safe setup and dispatches revision-checked explicit analysis activation",async()=>{
  expect((await call("/onboarding")).status).toBe(200);
  const response=await call("/runs/run-1/analysis",{revision:2,requestId:"start-one",acknowledgeFailure:true});
  expect(response.status).toBe(202);
  expect(JSON.parse(await control().calls()).at(-1)).toEqual({method:"activateAnalysis",args:["run-1",2,"start-one",true]});
});

it("does not open a model session for discovery inspection or chat routes",async()=>{
  for(const suffix of ["events","inspect","session-controls"])
    expect((await call("/jobs/discovery/"+suffix)).status).toBe(409);
});

it("refuses OpenCode key writes before sending the value to storage RPC",async()=>{
  const response=await call("/onboarding/credential.save",{id:"model-key",purpose:"model",label:"OpenCode",value:"never-store-this",revision:null});
  expect(response.status).toBe(400);expect(await response.text()).toContain("Cloudflare");expect(JSON.parse(await control().calls())).toEqual([]);
});
it("authenticates optional source actions and preserves revision/import identity at the RPC boundary",async()=>{
  const value={id:"target-one",revision:3,url:"https://github.com/owner/source",requestId:"import-one"};
  expect((await call("/onboarding/source.import",value,false)).status).toBe(401);
  expect(JSON.parse(await control().calls())).toEqual([]);
  expect((await call("/onboarding/source.import",value)).status).toBe(200);
  expect(JSON.parse(await control().calls())).toEqual([{method:"onboardingAction",args:["source.import",value,"operator"]}]);
});
