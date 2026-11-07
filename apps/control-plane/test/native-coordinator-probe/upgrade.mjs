import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {withNativeTestHarness} from "../../../../scripts/lib/native-test-harness.mjs";

const root=fileURLToPath(new URL("../../",import.meta.url));
const a="a".repeat(40),b="b".repeat(40),c="c".repeat(40);
await withNativeTestHarness({root,workers:[{configPath:"test/native-coordinator-probe/wrangler.jsonc"}]},async server=>{
  async function probe(action,value,object="upgrade-main",status=200){
    const response=await server.fetch(`https://coordinator.test/upgrade?object=${object}&action=${action}`,value===undefined?{}:{method:"POST",body:JSON.stringify(value)});
    const result=await response.json();
    assert.equal(response.status,status,JSON.stringify(result));
    return result;
  }
  const operation={operationId:"upgrade-probe",sourceCommit:a};
  const initial=await probe("setup");
  assert.equal(initial.onboarding.targets,1);
  assert.equal(initial.onboarding.definitionUploads,1);
  const data=await probe("data");
  assert.equal((await probe("prepare",operation)).maintenance,true);
  assert.deepEqual(await probe("data"),data,"upgrade preparation preserves saved targets, secrets, definition bytes, artifacts metadata and retained history");
  assert.deepEqual((await probe("status")).maintenanceOperation,operation);
  assert.equal((await probe("prepare",operation)).maintenance,true,"same operation resumes idempotently");
  for(const wrong of [{operationId:"other-upgrade",sourceCommit:a},{operationId:"upgrade-probe",sourceCommit:b},{...operation,sourceCommit:b,previousSourceCommit:c}]){
    assert.match((await probe("prepare",wrong,"upgrade-main",500)).error,/409:/);
    assert.deepEqual((await probe("status")).maintenanceOperation,operation);
  }
  const blocked=await probe("admission");
  for(const name of ["run","target","model","upload","definition","restore","archive","trash","delete","discard","cancel","interrupt","revise","settings","catalog","uninstall"])assert.match(blocked.denied[name],/409:.*maintenance/,name);
  assert.equal(blocked.snapshot.targets[0].id,"saved-api","owner metadata remains readable");
  assert.deepEqual(await probe("data"),data);
  try{await server.fetch("https://coordinator.test/abort?object=upgrade-main");}catch{}
  assert.deepEqual((await probe("status")).maintenanceOperation,operation,"maintenance survives coordinator eviction");
  const retarget={operationId:"upgrade-probe",sourceCommit:b,previousSourceCommit:a};
  assert.equal((await probe("prepare",retarget)).maintenance,true);
  for(const wrong of [operation,{operationId:"other-upgrade",sourceCommit:b}]){
    assert.match((await probe("finish",wrong,"upgrade-main",500)).error,/409:/);
    assert.equal((await probe("status")).maintenance,true);
  }
  const finish={operationId:"upgrade-probe",sourceCommit:b};
  assert.equal((await probe("finish",finish)).maintenance,false);
  assert.deepEqual(await probe("data"),data);
  try{await server.fetch("https://coordinator.test/abort?object=upgrade-main");}catch{}
  assert.equal((await probe("finish",finish)).completed,true,"completed operation receipt survives eviction");
  assert.equal((await probe("prepare",finish)).maintenance,false,"completed operation retries cannot close admissions again");
  assert.match((await probe("prepare",operation,"upgrade-main",500)).error,/409:/);
  const next={operationId:"next-upgrade",sourceCommit:c};
  assert.equal((await probe("prepare",next)).maintenance,true);
  assert.match((await probe("finish",finish,"upgrade-main",500)).error,/409:/,"old completed receipt cannot release a newer operation");
  assert.deepEqual((await probe("status")).maintenanceOperation,next);

  await probe("setup",undefined,"upgrade-blockers");
  const {errors,status}=await probe("blockers",undefined,"upgrade-blockers");
  const blockers=["quiesced","active","publication:run-0","input:preparing","purge:run-0","project:owned:unfinished","onboarding:creation:unfinished","conversation:job-0","acceptances","projections","uploads","initializing","creations","purges","preparingConversations","preparingMaterials","definitionBusy","job","run"];
  assert.deepEqual(Object.keys(errors),blockers);
  for(const error of Object.values(errors))assert.match(error,/409:/);
  assert.equal(status.maintenance,false,"refused preparations never close admissions");
  assert.equal((await probe("prepare",operation,"upgrade-blockers")).maintenance,true,"retained library data and completed history do not block maintenance");
  assert.deepEqual(await probe("advance",undefined,"upgrade-blockers"),{jobs:1,active:0},"maintenance prevents phase advancement and execution claiming");

  for(const kind of ["definition","upload","model","discard"]){
    const object="upgrade-race-"+kind;
    await probe("setup",undefined,object);
    const race=await probe("race-"+kind,undefined,object);
    assert.match(race.refused,/409:/,`${kind} operation must finish before upgrade maintenance`);
    assert.equal(race.during.maintenance,false);
    assert.deepEqual(race.result,{complete:true});
    assert.equal((await probe("prepare",operation,object)).maintenance,true,`${kind} operation releases its admission reservation`);
  }
});
console.log("Native upgrade lifecycle probe passed");
