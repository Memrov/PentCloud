/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessKeys, accessHeaders } from "./access-fixture";
import type { RuntimeFixtureEnv } from "./router-fixture";

const bindings=env as unknown as RuntimeFixtureEnv;
const app=exports as unknown as {default:Fetcher};
const control=()=>bindings.COORDINATOR.getByName("global");
const call=async(path:string,init:RequestInit={})=>app.default.fetch(new Request("https://files.test"+path,{...init,headers:await accessHeaders(init.headers)}));
const upload="/v1/ui/runs/run-1/uploads/upload-1?name=notes.md";
const headers={"X-Content-SHA256":"a".repeat(64),"Content-Type":"text/plain"};
afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{accessKeys();await control().clearCalls();});

describe("authenticated file routes in real workerd",()=>{
  it("authenticates before accepting raw bytes and carries exact receipt identity",async()=>{
    expect((await app.default.fetch("https://files.test"+upload,{method:"POST",body:"hello"})).status).toBe(401);
    expect(JSON.parse(await control().calls())).toEqual([]);
    const response=await call(upload,{method:"POST",headers,body:"hello\n"});
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({id:"upload-1",runId:"run-1",name:"notes.md",status:"ready"});
    expect(JSON.parse(await control().calls())).toEqual([{method:"stageUpload",args:[{runId:"run-1",id:"upload-1",name:"notes.md",sha256:"a".repeat(64),uploadedBy:"operator",text:"hello\n"}]}]);
  });
  it("rejects invalid upload identities/names and body limits before RPC",async()=>{
    for(const path of [upload.replace("notes.md","..%2Fsecret"),upload.replace("notes.md","%00bad"),upload.replace("notes.md","")])
      expect((await call(path,{method:"POST",headers,body:"hello"})).status).toBe(400);
    expect((await call(upload,{method:"POST",body:"hello"})).status).toBe(400);
    expect((await call(upload,{method:"POST",headers:{...headers,"Content-Length":String(2*1024*1024+1)},body:"x"})).status).toBe(413);
    expect(JSON.parse(await control().calls())).toEqual([]);
  });
  it("serves an attempt-specific immutable file list and validates download scope",async()=>{
    const result=await call("/v1/ui/runs/run-1/files?job=job-1");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({runId:"run-1",commit:"a".repeat(40),files:[]});
    const path="/v1/ui/runs/run-1/file?commit="+"a".repeat(40)+"&path="+encodeURIComponent(".pentagi/materials/notes.md");
    const preview=await call(path+"&preview=1");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(preview.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await preview.text()).toBe("<script>inert file</script>");
    expect((await call(path.replace("a".repeat(40),"b".repeat(40)))).status).toBe(404);
    expect((await call(path.replace(encodeURIComponent(".pentagi/materials/notes.md"),"..%2Fsecret"))).status).toBe(400);
  });
  it("passes file selections into existing run/revision operations without a separate scheduler",async()=>{
    const send=(path:string,value:unknown)=>call(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});
    const selection={upload_ids:["upload-1"]};
    expect((await send("/v1/ui/runs",{run_id:"run-1",task:"Review files",...selection})).status).toBe(202);
    expect((await send("/v1/ui/jobs/job-1/revisions",{instructions:"Review attached",request_id:"revision-1",...selection})).status).toBe(202);
    const calls=JSON.parse(await control().calls());
    expect(calls[0]).toMatchObject({method:"createRun",args:[{run_id:"run-1",task:"Review files",...selection}]});
    expect(calls[1]).toEqual({method:"revise",args:["job-1","Review attached","revision-1",null,["upload-1"]]});
  });
});
