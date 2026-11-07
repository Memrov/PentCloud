import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {withNativeTestHarness} from "../../../../scripts/lib/native-test-harness.mjs";
import { verifyReadonlyState } from "./state.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
let worker;
const get = async (path, status = 200) => {
  if (process.env.PROBE_DEBUG) console.log(path);
  const response = await worker.dispatchFetch(
    "https://coordinator.test" + path,
  );
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
};
const deadline = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Lifecycle alarm waited for unbounded Attempt.run")),
        ms,
      );
      timer.unref();
    }),
  ]);
const fixture = async (run) => withNativeTestHarness({
  root,
  workers: [{configPath: "test/native-coordinator-probe/wrangler.jsonc"}],
}, async (server, url) => {
  // Retain the original request/assertion surface while Wrangler owns bundling,
  // local ports, isolated storage, diagnostics and deterministic shutdown.
  worker = {dispatchFetch: server.fetch};
  await run(url);
});
await fixture(async()=>{
  await get("/seed");await get("/fire");
  assert.equal((await get("/attempt?id=job-0")).deliveries,1);
  await get("/recovery-after-reset");
  await worker.dispatchFetch("https://coordinator.test/abort").catch(()=>undefined);
  // Finish only the remote attempt: its old coordinator completion RPC was lost.
  await get("/release?id=job-0");
  let next;
  for(let retry=0;retry<150;retry++){
    next=await get("/attempt?id=job-1");
    if(next.deliveries===1)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(next.deliveries,1,"durable heartbeat reconciles a lost completion then admits FIFO after drain");
  assert.equal((await get("/attempt?id=job-0")).starts,1,"recovery consumes the settled receipt without restarting work");
  await get("/cancel?run=run-0");await get("/cancel?run=run-1");await get("/release?id=job-1");
});
await fixture(async()=>{
  const value=await get("/readonly-queue");
  assert.deepEqual(value.cold.pending,[]);assert.deepEqual(value.coldJobs,[],"queue snapshot never starts recovery");
  assert.deepEqual(value.pending.map(job=>job.id),["job-1","job-0"],"pending projection follows authoritative admission order");
});
await fixture(async()=>{
  await worker.dispatchFetch("https://coordinator.test/native-memory-handoff").catch(()=>undefined);
  let diagnostics;
  for(let retry=0;retry<100;retry++){
    diagnostics=await get("/platform-diagnostics");
    if(diagnostics.coordinator.recovery)break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(diagnostics.coordinator.recovery?.sealed,false,"native breaker sees the original rejected handoff");
  assert.ok(diagnostics.coordinator.recovery.nextTime>Date.now(),"native breaker persists its recovery backoff after reset");
  assert.equal((await get("/platform-schedules")).recover,1,"the rejected handoff retains one native wake");
});
await fixture(async()=>{
  const value=await get("/native-wake");
  assert.ok(value.initial,"startup installs the one durable native recovery job");
  assert.equal(value.initial.singleflight,true);assert.equal(value.initial.recoveryLoop,true);
  assert.equal(value.firstPasses,1);assert.equal(value.busyPasses,1);assert.equal(value.peak,1,"same-ID wake never overlaps detached recovery");
  assert.ok(value.busyWake.time<=value.busyRequestedAt+1000,"wake while busy durably advances the existing heartbeat");
  assert.ok(value.heartbeat,"busy dispatch leaves a durable heartbeat");
  assert.equal(value.passes,2,"heartbeat runs a fresh pass after the handoff settles");
  assert.equal(value.rolledBack,true,"admission and native wake retime roll back together");
  assert.match(value.failure,/injected alarm rearm failure/);assert.ok(value.retained,"rearm failure preserves the native wake for retry");
});
await fixture(async()=>{const value=await get('/bounty-gate-scenario');assert.deepEqual(value.denied,['scope.names','scope.search','scope.preview','scope.import']);assert.deepEqual(Object.fromEntries(value.status.connections.map(c=>[c.platform,c.status])),{hackerone:'missing',intigriti:'missing',bugcrowd:'development',yeswehack:'development'});assert.deepEqual(value.unavailable,['bugcrowd:bounty.check','bugcrowd:scope.preview','bugcrowd:scope.import','yeswehack:bounty.check','yeswehack:scope.preview','yeswehack:scope.import']);});
await fixture(async()=>{
  const value=await get("/direct-delete-scenario?mode=tool-packs");
  assert.equal(value.error,undefined,"package-only run deletion does not require a Kali binding");
  assert.equal(value.clears,0);
  assert.equal(value.before.records.find(row=>row.key==="purged:run:run-0").value.id,"run-0");
});
const params = (values) =>
  new URLSearchParams(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === "object" ? JSON.stringify(value) : value,
      ]),
    ),
  ).toString();
await fixture(async()=>{const value=await get("/recorded-work-scenario");assert.ok(value.crossRun&&value.self&&value.wrongRole&&value.stopped);assert.equal(value.catalog.attempts.length,1);assert.equal(value.catalog.attempts[0].status,"failed");assert.equal(value.catalog.attempts[0].error,"TOKEN=[redacted]");assert.match(value.source.messages[0].content[0].text,/differs from handoff/);});
await fixture(async()=>{const value=await get("/findings-scenario");assert.equal(value.legacy.bundle,undefined);assert.equal(value.bundle.bundle.document.findings.length,1);assert.equal(value.bundle.commit,"a".repeat(40));assert.match(value.wrong,/accepted reporter/);assert.match(value.missing,/reference/);});
await fixture(url => verifyReadonlyState(worker.dispatchFetch, url));
await fixture(async url => {
  const value=await get("/catalog-runtime?origin="+encodeURIComponent(url.origin));
  assert.deepEqual(value,[{route:"go",models:1},{route:"console",models:1}],"catalog works with the actual Workerd fetch implementation");
  const redirects=await get("/catalog-runtime?redirect=1&origin="+encodeURIComponent(url.origin));
  assert.ok(redirects.every(value=>value.error.includes("HTTP 302")),"catalog redirects are rejected without following or sending keys");
});
await fixture(async () => {
  const value=await get("/early-chat");
  assert.deepEqual(value.before.primary,{prepared:true,preparations:1,cancelled:false,starts:0});
  assert.ok(value.workDenied&&value.unselectedDenied&&value.unknownDenied);
  assert.match(value.selectedRead,/Owned project configuration/);
  assert.equal(value.headAfterRead,value.before.head,"preparation never advances accepted Git");
  assert.equal(value.unknownHeld.starts,0,"an unknown scanner outcome cannot be acknowledged away");
  assert.equal(value.held.starts,0,"drained failure waits for explicit coverage acknowledgement");
  assert.equal(value.after.starts,1,"the prepared primary is admitted once after acknowledgement");
  const admitted=value.snapshot.records.find(row=>row.key.startsWith("launch:")&&row.value.role==="primary").value;
  assert.equal(admitted.targetConfig.access.headerBinding,"PENTCLOUD_TARGET_TEST_HEADERS","admission preserves the pinned native target bindings");
  const beforeRun=value.before.snapshot.records.find(row=>row.key==="run:run-0").value;
  const afterRun=value.snapshot.records.find(row=>row.key==="run:run-0").value;
  assert.equal(beforeRun.phase,"primary");assert.equal(afterRun.phase,"primary");
  assert.equal(afterRun.discoveryDrained,true);assert.equal(afterRun.discoveryAcknowledged,true);
});
for(const suffix of ["","&terminal=true"])await fixture(async () => {
  const value=await get("/early-chat?stop=true"+suffix);
  assert.equal(value.before.primary.preparations,1);assert.equal(value.after.starts,0);
  assert.equal(value.after.cancelled,true,"Stop includes the queued native conversation");
});
await fixture(async () => {
  const value=await get("/early-chat?rejected-primary=true");
  const primary=value.snapshot.jobs.find(job=>job.id!=="job-0");
  assert.equal(primary.status,"invalid_result");assert.equal(primary.nativeSession,true,"preparation transcript remains readable after admission rejection");
  assert.equal(value.after.cancelled,true,"input rejection aborts the prepared host immediately");
});
await fixture(async () => {
  const value=await get("/early-chat?queued-rejected=true");
  const discovery=value.rejected.jobs.find(job=>job.id==="job-1");
  assert.equal(discovery.status,"invalid_result");
  const run=value.rejected.records.find(row=>row.key==="run:run-1").value;
  assert.equal(run.discoveryDrained,true,"never-admitted discovery has no scanner work to drain");
  assert.equal(value.ackError,undefined);
  assert.equal(value.after.starts,1,"acknowledgement releases a safely rejected queued discovery");
  assert.equal(value.input.context.materials.files[0].id,"preparation-file","initial files reach actual execution even if discovery could not admit them");
});
await fixture(async () => {
  const value=await get("/mismatched-discovery");
  const job=value.snapshot.jobs.find(job=>job.id==="job-0");
  const run=value.snapshot.records.find(row=>row.key==="run:run-0").value;
  assert.equal(job.status,"invalid_result","wrong execution mode is rejected instead of spinning forever");
  assert.equal(run.phase,"setup");assert.equal(run.discoveryDrained,true);
  assert.equal(value.main,run.inputCommit,"rejected output never reaches accepted main");
  assert.equal(value.attempt.starts,1,"reconciliation never restarts discovery or inference");
});
await fixture(async () => {
  await get("/seed?notify=false");
  await get("/platform-backoff");
  await get("/repeat?id=job-0");
  await get("/recover");
  assert.equal((await get("/attempt?id=job-0")).deliveries, 0, "Lifecycle/API wakes honor the native backoff time");
  assert.equal((await get("/snapshot")).records.find(row => row.key === "active"), undefined);
  await get("/end-platform-backoff");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await get("/attempt?id=job-0")).deliveries, 1, "due backoff resumes the original FIFO attempt");
});
await fixture(async () => {
  await get("/seed?notify=false");
  await get("/rpc-failure?id=job-0&enabled=true");
  await deadline(get("/repeat?id=job-0"), 2500);
  await new Promise(resolve => setTimeout(resolve, 100));
  const attempt = await get("/platform-memory?unresolved=1");
  assert.equal(attempt.active.recovery.sealed, true);
  await get("/recover");
  assert.equal((await get("/attempt?id=job-0")).deliveries, 1, "a sealed attempt cannot relaunch its model or mutations");
  assert.equal((await get("/attempt?id=job-1")).deliveries, 0, "a sealed scanner hold keeps the global slot");
  const sealed = await get("/platform-memory?scope=coordinator");
  assert.equal(sealed.coordinator.recovery.sealed, true);
  assert.equal(sealed.backlog.waiting, 1);
  assert.equal((await get("/platform-schedules")).recover, 0, "sealing cancels the ordinary recovery heartbeat");
  const marker = sealed.coordinator.recovery.observedAt;
  assert.match((await get(`/platform-rearm?at=${marker - 1}`, 500)).error, /409:/, "stale platform recovery cannot rearm");
  assert.match((await get(`/platform-rearm?at=${marker}`, 500)).error, /409:/, "unknown scanner outcomes prevent platform rearm");
  const held = await get("/snapshot");
  assert.equal(held.records.find(row => row.key === "active").value.id, "job-0");
  const resolved = await get("/platform-memory?unresolved=0");
  assert.equal((await get(`/platform-rearm?at=${marker}`)).rearmed, true);
  assert.equal((await get("/platform-schedules")).recover, 1, "explicit resume restores the single native recovery job");
  assert.equal((await get("/platform-diagnostics")).coordinator.recovery, undefined);
  assert.equal((await get("/attempt?id=job-0")).deliveries, 1, "Coordinator resume preserves the separate Attempt seal");
  await get("/rpc-failure?id=job-0&enabled=false");
  assert.equal((await get(`/platform-rearm?scope=attempt&id=job-0&at=${resolved.active.recovery.observedAt}`)).rearmed, true);
  await get("/recover");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await get("/attempt?id=job-0")).deliveries, 2, "the operator resumes the same pinned attempt once");
  assert.equal((await get("/attempt?id=job-1")).deliveries, 0, "resume retains serial ownership");
});
await fixture(async () => {
  await get("/seed?notify=false");
  await get("/rpc-failure?id=job-0&enabled=true");
  await deadline(get("/repeat?id=job-0"), 2500);
  await new Promise(resolve => setTimeout(resolve, 200));
  const failed = await get("/attempt?id=job-0");
  assert.equal(failed.deliveries, 1, "immediate RPC failure waits for a durable wake instead of recursively relaunching");
  const held = await get("/snapshot");
  assert.equal(held.records.find(row => row.key === "active").value.id, "job-0", "RPC failure retains the durable global owner");
  assert.equal(held.jobs.find(job => job.id === "job-0").status, "running");
  assert.equal((await get("/attempt?id=job-1")).deliveries, 0, "failure cannot release the toolbox slot");
  await get("/rpc-failure?id=job-0&enabled=false");
  await get("/recover");
  let resumed;
  for(let retry=0;retry<100;retry++) { resumed = await get("/attempt?id=job-0"); if(resumed.deliveries === 2) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(resumed.deliveries, 2, "the next explicit recovery wake retries the same owner once");
  assert.deepEqual(resumed.input, failed.input, "retry uses the exact immutable launch input");
  await get("/cancel?run=run-0"); await get("/release?id=job-0"); await get("/cancel?run=run-1");
});
await fixture(async () => {
  await get("/seed"); await get("/fire"); await get("/release?id=job-0");
  let next;
  for(let retry=0;retry<100;retry++) { next=await get("/attempt?id=job-1"); if(next.deliveries===1) break; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.equal(next.deliveries, 1, "successful completion wakes FIFO immediately without waiting for the 15-second schedule");
  await get("/cancel?run=run-0"); await get("/cancel?run=run-1"); await get("/release?id=job-1");
});
await fixture(async () => {
  await get("/seed");
  await deadline(get("/fire"), 2500);
  const first = await get("/attempt?id=job-0");
  assert.equal(first.deliveries, 1);
  assert.deepEqual(
    first.input.context.enabledTools,
    ["search_code", "store_code"],
    "pinned role context enables supported original memory tools",
  );
  assert.equal((await get("/attempt?id=job-1")).deliveries, 0);
  const notOwner = await get("/reconciled?id=job-1", 500);
  assert.match(
    notOwner.error,
    /409/,
    "nonterminal queued job cannot reconcile another owner",
  );
  await deadline(get("/repeat?id=job-0"), 2500);
  assert.equal(
    (await get("/attempt?id=job-0")).deliveries,
    1,
    "overlapping alarm cannot change pinned launch",
  );
  const wait = Number(process.env.PROBE_DEADMAN_WAIT_MS ?? 31000);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  assert.equal(
    (await get("/attempt?id=job-0")).starts,
    1,
    "SDK recovery/deadman wakes retain one physical execution",
  );
  assert.equal(
    (await get("/attempt?id=job-1")).starts,
    0,
    "unbounded work has no 30-second execution deadline",
  );
  // The persisted native wake, without a new API wake, resumes after eviction.
  await get("/recovery-after-reset");
  // Abrupt reset represents deployment/eviction; graceful eviction waits for pending I/O.
  await worker
    .dispatchFetch("https://coordinator.test/abort")
    .catch(() => undefined);
  let resumed;
  for(let retry=0;retry<150;retry++){
    resumed=await get("/attempt?id=job-0");
    if(resumed.deliveries>=2)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(resumed.deliveries,2,"persisted native heartbeat resumes the same owner after reset without an API wake");
  assert.deepEqual(
    resumed.input,
    first.input,
    "reset resumes byte-identical pinned input",
  );
  assert.equal(resumed.starts, 1);
  await get("/cancel?run=run-0");
  await get("/recover");
  assert.equal(
    (await get("/attempt?id=job-1")).deliveries,
    0,
    "cancellation holds slot until execution drains",
  );
  await get("/release?id=job-0");
  await get("/recover");
  assert.equal(
    (await get("/attempt?id=job-1")).deliveries,
    1,
    "FIFO next run starts after drain",
  );
  assert.equal(
    (await get("/reconciled?id=job-0")).alreadyDrained,
    true,
    "late successful remote reconciliation remains idempotent after slot handoff",
  );
  await get("/cancel?run=run-1");
  await get("/release?id=job-1");
});
await fixture(async () => {
  await get("/seed?count=1&notify=false");
  await get("/terminalize?id=job-0");
  const snapshot = await get("/advance-twice");
  assert.equal(
    snapshot.jobs.filter((job) => job.id !== "job-0").length,
    1,
    "concurrent continuation CAS admits one wave",
  );
  assert.equal(
    snapshot.records.find((row) => row.key === "run:run-0").value.wave,
    1,
  );
  await get("/cancel?run=run-0");
  await deadline(get("/repeat?id=job-0"), 2500);
  const cancelled = await get("/snapshot");
  assert.equal(
    cancelled.records.find((row) => row.key === "run:run-0").value.phase,
    "cancelled",
  );
  assert(
    cancelled.jobs.every(
      (job) => job.status === "failed" || job.status === "interrupted",
    ),
    "late queue notification cannot resurrect cancelled jobs",
  );
});
await fixture(async () => {
  await get("/seed?role=primary");
  await get("/fire");
  await get("/target?id=target-0&run=run-0");
  await get("/target?id=target-1&run=run-1");
  const revise =
    "/delegate?" +
    params({
      parent: "job-0",
      tool: "revise_attempt",
      args: { job_id: "target-0", instructions: "repair" },
    });
  const first = await get(revise),
    replay = await get(revise);
  assert.equal(
    first.job_id,
    replay.job_id,
    "replayed revision keeps immutable identity at capacity",
  );
  const cross = await get(
    "/delegate?" +
      params({
        parent: "job-0",
        tool: "revise_attempt",
        args: { job_id: "target-1", instructions: "repair" },
      }),
    500,
  );
  assert.match(cross.error, /same-run/);
  const full = await get(
    "/delegate?" +
      params({
        parent: "job-0",
        tool: "search",
        args: { question: "new research", message: "research" },
      }),
    500,
  );
  assert.match(full.error, /429/);
  await get("/cancel?run=run-0");
  const cancelled = await get("/snapshot");
  assert(
    cancelled.jobs
      .filter((job) => job.runId === "run-0")
      .every((job) => ["completed", "interrupted"].includes(job.status)),
    "cancel fences whole run before external calls",
  );
  await get(
    "/revise?" +
      params({
        id: "target-1",
        instructions: "first after cancellation",
        request: "one",
      }),
  );
  const capacity = await get(
    "/revise?" +
      params({
        id: "target-1",
        instructions: "second after cancellation",
        request: "two",
      }),
    500,
  );
  assert.match(
    capacity.error,
    /429/,
    "draining cancelled owner still counts toward global 1+2 bound",
  );
  await get("/cancel?run=run-1");
  await get("/release?id=job-0");
});
await fixture(async () => {
  await get("/seed?count=1");
  await get("/fire");
  const forbidden = await get(
    "/delegate?" +
      params({
        parent: "job-0",
        tool: "pentester",
        args: { question: "escalate role", message: "forbidden" },
      }),
    500,
  );
  assert.match(forbidden.error, /403/);
  await get("/cancel?run=run-0");
  await get("/release?id=job-0");
});
await fixture(async () => {
  await get("/seed");
  await get("/fire");
  const baseline = (await get("/main?run=run-0")).head;
  const candidate = await get("/prepare?id=job-0");
  const pushedEarly = await get("/reconcile?id=job-0");
  assert.equal(
    pushedEarly.pending,
    true,
    "push event cannot fence an unfinished local terminal publication",
  );
  assert.equal(
    (await get("/snapshot")).jobs.find((job) => job.id === "job-0").status,
    "running",
  );
  await get("/block-projection?value=true");
  const finished = await worker.dispatchFetch(
    "https://coordinator.test/finish",
    { method: "POST", body: JSON.stringify(candidate) },
  );
  assert.equal(finished.status, 200);
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt++) {
    snapshot = await get("/snapshot");
    if (snapshot.jobs.find((job) => job.id === "job-0").status === "completed")
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    snapshot.jobs.find((job) => job.id === "job-0").status,
    "completed",
    "candidate acceptance linearizes before projection",
  );
  assert.equal(
    snapshot.records.find((row) => row.key === "run:run-0").value.headCommit,
    candidate.outputCommit,
  );
  assert.equal(
    snapshot.records.find((row) => row.key === "publication:run-0").value
      .commit,
    candidate.outputCommit,
    "failed projection retains durable receipt",
  );
  assert.equal(
    (await get("/main?run=run-0")).head,
    baseline,
    "remote main remains old while publication is blocked",
  );
  assert.equal((await get("/attempt?id=job-1")).starts, 0);
  await worker
    .dispatchFetch("https://coordinator.test/abort")
    .catch(() => undefined);
  await get("/block-projection?value=false");
  const duplicate = await get("/accept?id=job-0");
  assert.equal(
    duplicate.duplicate,
    true,
    "duplicate completion repairs durable projection after reset",
  );
  await get("/recover");
  snapshot = await get("/snapshot");
  assert.equal((await get("/main?run=run-0")).head, candidate.outputCommit);
  assert.equal(
    snapshot.records.find((row) => row.key === "publication:run-0").value,
    null,
  );
  assert.equal(
    snapshot.jobs.find((job) => job.id === "job-0").revision,
    2,
    "replay does not accept twice",
  );
  assert.equal(
    (await get("/attempt?id=job-0")).starts,
    1,
    "accepted candidate never reruns model",
  );
  let next;
  for (let attempt = 0; attempt < 100; attempt++) {
    next = await get("/attempt?id=job-1");
    if (next.starts === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(next.starts, 1, "publication repair allows FIFO to continue");
  await get("/cancel?run=run-0");
  await get("/cancel?run=run-1");
  await get("/release?id=job-1");
});
await fixture(async () => {
  await get("/seed?count=1");
  await get("/fire");
  await get("/prepare?id=job-0");
  for (const changes of [
    { status: "running" },
    { tool: "report_result" },
    { finishedAt: -1 },
  ]) {
    const rejected = await get(
      "/accept?" + params({ id: "job-0", changes }),
      500,
    );
    assert.match(rejected.error, /400|Invalid/);
  }
  await get("/cancel?run=run-0");
  await get("/release?id=job-0");
});
await fixture(async () => {
  await get("/seed?count=1");
  await get("/fire");
  const invalid = await get(
    "/prepare?" + params({ id: "job-0", record: { run_id: "another-run" } }),
  );
  const rejected = await get("/accept?id=job-0", 500);
  assert.match(rejected.error, /provenance mismatch/);
  await worker.dispatchFetch("https://coordinator.test/finish", {
    method: "POST",
    body: JSON.stringify(invalid),
  });
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = (await get("/snapshot")).jobs.find(
      (job) => job.id === "job-0",
    ).status;
    if (status === "invalid_result") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    status,
    "invalid_result",
    "invalid settled candidate terminates explicitly instead of retrying acceptance forever",
  );
  await get("/cancel?run=run-0");
  await get("/release?id=job-0");
});
await fixture(async () => {
  await get("/seed?count=1&role=primary");
  await get("/fire");
  await get(
    "/prepare?" + params({ id: "job-0", record: { __sourceWrite: true } }),
  );
  const rejected = await get("/accept?id=job-0", 500);
  assert.match(
    rejected.error,
    /cannot change source/,
    "coordinator independently enforces role diff policy",
  );
  await get("/cancel?run=run-0");
  await get("/release?id=job-0");
});
await fixture(async () => {
  await get("/seed?count=1&role=primary&notify=false");
  await get("/target?id=target-0&run=run-0");
  await get("/limit?run=run-0&max=3");
  await get("/terminalize?id=job-0");
  const snapshot = await get("/advance-twice");
  assert.equal(snapshot.jobs.length, 3);
  assert.equal(
    snapshot.jobs.find((job) => !["job-0", "target-0"].includes(job.id)).role,
    "reporter",
    "last job budget slot is reserved for required reporter",
  );
  await get("/cancel?run=run-0");
});
await fixture(async () => {
  const [first, second] = await Promise.all([
    get("/create?id=concurrent&task=same"),
    get("/create?id=concurrent&task=same"),
  ]);
  assert.equal(
    first.rootJob.id,
    second.rootJob.id,
    "concurrent identical admission resumes one initialization and returns one immutable root receipt",
  );
  const snapshot = await get("/snapshot");
  assert.equal(snapshot.jobs.length, 1);
  await get("/cancel?run=concurrent");
  await get("/release?id=" + first.rootJob.id);
});
await fixture(async () => {
  const rejected = await get("/create?id=" + "a".repeat(55), 500);
  assert.match(
    rejected.error,
    /400:.*run id/,
    "repository-derived run IDs enforce length before remote mutation",
  );
});
await fixture(async () => {
  await get("/block-projection?value=true");
  const failed = await get("/create?id=initialization-retry", 500);
  assert.match(failed.error, /503/);
  const first = (await get("/initialization-head?id=initialization-retry"))
    .head;
  assert.equal(
    (await get("/snapshot")).jobs.length,
    0,
    "failed initialization is not admitted",
  );
  await get("/block-projection?value=false");
  const resumed = await get("/create?id=initialization-retry");
  assert.equal(
    resumed.run.inputCommit,
    first,
    "initialization replay reuses durable local commit after failed push",
  );
  await get("/cancel?run=initialization-retry");
  await get("/release?id=" + resumed.rootJob.id);
});
await fixture(async () => {
  const created = await get(
    "/create?" +
      params({
        id: "scope-probe",
        task: "Research https://example.test/allowed/ and https://other.test/path avoid https://user:password@private.test/",
      }),
  );
  await get("/fire");
  const active = await get("/attempt?id=" + created.rootJob.id);
  assert.deepEqual(
    active.input.context.browserAllowedURLs,
    ["https://owned.invalid/"],
    "new-run reader context comes from the saved target snapshot, not arbitrary objective URLs",
  );
  await get("/cancel?run=scope-probe");
  await get("/release?id=" + created.rootJob.id);
});
await fixture(async () => {
  for (const kind of ["roles", "template", "missing-format", "type"]) {
    const rejected = await get("/invalid-settings?kind=" + kind, 500);
    assert.match(
      rejected.error,
      /400:/,
      kind + " settings failure is a client validation error",
    );
  }
  const unavailable = await get("/invalid-settings?kind=infrastructure", 500);
  assert.match(unavailable.error, /hash backend unavailable/);
  assert.doesNotMatch(
    unavailable.error,
    /400:/,
    "infrastructure failure is preserved",
  );
});
await fixture(async()=>{
  assert.deepEqual(await get("/browser-auth-lifecycle"),{cancelled:true,completed:true,archived:true});
});
console.log(
  "workerd coordinator: Lifecycle heartbeat/handoff/deadman/reset, cancellation drain/FIFO/capacity, continuation CAS, role/revision authority, real Git candidate validation and durable publication replay passed",
);
