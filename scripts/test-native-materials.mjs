import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {withNativeTestHarness} from "./lib/native-test-harness.mjs";
const root=fileURLToPath(new URL("../apps/control-plane",import.meta.url));
for(const mode of ["advanced-head","initial","active","projection","interrupted","capacity","metadata","rejected"]){
  await withNativeTestHarness({root,workers:[{configPath:"test/native-coordinator-probe/wrangler.jsonc"}]},async server=>{
    const response=await server.fetch(`https://coordinator.test/materials-scenario?mode=${mode}`);
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    if(mode==="advanced-head")assert.equal(result.error,undefined,"an advanced accepted head must admit the attachment without reverting evidence");
    if(mode==="rejected"){
      assert.equal(result.rejected.status,"invalid_result");
      assert.match(result.rejected.inputError,/file count|byte limit/i);
      assert.equal(result.rejected.nativeSession,undefined,"pre-session rejection cannot invent a model session");
      assert.equal(result.snapshot.records.find(r=>r.key==="run:run-0").value.phase,"completed","rejected input cannot continue automatically without requested files");
      assert.equal(result.snapshot.records.find(r=>r.key==="input:preparing")?.value??null,null);
    }else if(mode==="capacity"){
      assert.equal(result.revision.job.id,result.duplicate.job.id,"admitted replay survives later pending material changes");
      assert.match(result.rejected,/file count|byte limit|selection exceeds/i);
      assert.equal(result.snapshot.jobs.filter(j=>j.status==="created").length,1,"second cumulative overflow is rejected before queue admission");
    }else if(mode==="metadata"){
      assert.equal(result.listing.files.find(f=>f.kind==="input").name,"config.md","old attempt keeps original material label");
      assert.match(result.disposition,/config.md/);
    }else if(mode==="interrupted"){
      assert.match(result.error,/boundary/);
      assert.equal(result.snapshot.records.find(r=>r.key==="input:preparing")?.value,null,"interrupted input releases its global preparation hold");
      assert.equal(result.snapshot.records.find(r=>r.key==="active")?.value.id,"job-1","another run can claim after interruption");
    }else if(mode==="active"){
      assert.deepEqual(result.after,result.before,"attachments cannot mutate active input");
      assert.equal(result.head,result.before.input.inputCommit);
      assert.equal(result.revision.job.id,result.duplicate.job.id,"lost revision reply reuses request identity");
      assert.equal(result.revision.job.status,"created");
    }else{
      assert.notEqual(result.settled.headCommit,result.initial.headCommit);
      assert.equal(result.launch.input.inputCommit,result.settled.headCommit);
      assert.equal(result.launch.input.context.materials.files[0].sha256,result.receipt.sha256);
      assert.equal(result.content,"# Evidence\nconfig = ß\n");
      if(mode==="advanced-head")assert.equal(result.acceptedProof,"Retain accepted evidence\n","attachment admission retains previously accepted files");
      if(mode==="projection"){
        assert.match(result.error,/projection/);
        assert.equal(result.held,undefined,"no attempt starts before input main projection settles");
        assert.equal(result.prepared.headCommit,result.settled.headCommit,"recovery reuses same material commit");
      }
    }
    console.log(`native material ${mode}: passed`);
  });
}
