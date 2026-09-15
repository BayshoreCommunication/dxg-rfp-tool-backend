const test=require("node:test");const assert=require("node:assert/strict");require("ts-node/register");
const {createDispatcher}=require("../src/modules/durableJobs/dispatcher");
const message={jobId:"01900000-0000-7000-8000-000000000001",organizationMongoId:"507f1f77bcf86cd799439011",actorUserMongoId:"507f191e810c19729de860ea",jobType:"source_security_scan",inputReference:"01900000-0000-7000-8000-000000000002",inputVersion:"a".repeat(64),correlationId:"correlation"};
const repository=()=>({
 published:[],failed:[],claims:[{eventId:"evt",message}],reconciled:[message],
 async claimOutbox(){return this.claims},async markOutboxPublished(id){this.published.push(id)},async markOutboxFailed(id,code){this.failed.push([id,code])},async reconcile(){return this.reconciled},
 async reapExpiredLeases(){return this.reaped??[]}
});
test("dispatcher publishes reference-only messages and acknowledges outbox",async()=>{const repo=repository();const seen=[];const dispatcher=createDispatcher(repo,{async publish(value){seen.push(value)}});assert.deepEqual(await dispatcher.dispatch(),{claimed:1,published:1});assert.deepEqual(repo.published,["evt"]);assert.equal(seen[0].jobId,message.jobId);for(const prohibited of ["documentText","signedUrl","accessToken","proposalBody"])assert.equal(prohibited in seen[0],false);});
test("dispatcher records safe failure code when Redis publish fails",async()=>{const repo=repository();const dispatcher=createDispatcher(repo,{async publish(){throw new Error("secret provider details")}});assert.deepEqual(await dispatcher.dispatch(),{claimed:1,published:0});assert.deepEqual(repo.failed,[["evt","REDIS_PUBLISH_FAILED"]]);});
test("reconciliation republishes authoritative queued job references",async()=>{const repo=repository();let count=0;const dispatcher=createDispatcher(repo,{async publish(){count++}});assert.equal(await dispatcher.reconcile(),1);assert.equal(count,1);});

const {attemptBudget}=require("../src/modules/durableJobs/domain");
const {leaseHeartbeatIntervalMs}=require("../src/modules/durableJobs/worker");
test("retry budget honours the per-job-type max_attempts, not just the global ceiling",()=>{
 // The regression: vendor_response_analyze rows declare 2 attempts but fail()
 // compared against the worker's JOB_MAX_ATTEMPTS (default 5), so a failing
 // analysis made up to 5 billed provider calls instead of 2.
 assert.equal(attemptBudget(2,5),2,"per-type budget wins over a larger global ceiling");
 assert.equal(attemptBudget(3,5),3);
 // An operator who lowers the global ceiling must not be overridden by a row.
 assert.equal(attemptBudget(5,2),2,"global ceiling wins when it is the smaller");
 // Missing or nonsensical row values fall back to the global ceiling.
 for(const value of [null,undefined,0,-1,NaN,"abc"])assert.equal(attemptBudget(value,5),5);
 assert.equal(attemptBudget("3",5),3,"numeric strings from the driver are honoured");
});

test("long-running workers renew their lease well before expiry",()=>{
 assert.equal(leaseHeartbeatIntervalMs(90),30000);
 assert.equal(leaseHeartbeatIntervalMs(2),1000);
});

const fs=require("node:fs"),path=require("node:path");
const readSrc=(rel)=>fs.readFileSync(path.join(__dirname,"..",rel),"utf8");

test("an expired lease is reclaimed instead of stranding the job in running",()=>{
  // claim() sets lease_expires_at and heartbeat() extends it, but nothing read
  // the column: a killed worker left its job 'running' forever. reconcile()
  // only republishes queued/retry_scheduled, and BullMQ's stalled re-delivery
  // is rejected by the heartbeat lease check, so the row was unreachable by
  // every recovery path and invisible to operators.
  const repo=readSrc("src/modules/durableJobs/postgresJobRepository.ts");
  const reaper=repo.slice(repo.indexOf("reapExpiredLeases"),repo.indexOf("listDeadLetters"));
  assert.match(reaper,/status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now\(\)/,"targets expired leases only");
  assert.match(reaper,/FOR UPDATE SKIP LOCKED/,"two dispatchers cannot reap the same row");
  assert.match(reaper,/attemptBudget\(row\.max_attempts/,"honours the per-job-type attempt budget");
  assert.match(reaper,/retry_scheduled/,"a job with budget left is retried");
  assert.match(reaper,/job_dead_letters/,"an exhausted job is dead-lettered, not silently retried forever");
  assert.match(reaper,/ON CONFLICT \(job_id,operator_status\) DO NOTHING/,"repeat reaps cannot duplicate the dead letter");

  // The index for this predicate has existed since migration 004 and was never used.
  const migration=readSrc("migrations/postgres/004_durable_jobs.up.sql");
  assert.match(migration,/ai_jobs_lease_idx/,"the supporting index exists");

  const dispatcher=readSrc("src/modules/durableJobs/dispatcher.ts");
  assert.match(dispatcher,/reapExpiredLeases\(limit\)/,"the dispatcher actually runs the reaper");
});

test("open dead letters are listable by an operator",()=>{
  // The table was written and requeued by id, but nothing listed it: a
  // dead-lettered job could only be found by someone who already knew its id.
  const repo=readSrc("src/modules/durableJobs/postgresJobRepository.ts");
  const list=repo.slice(repo.indexOf("listDeadLetters"),repo.indexOf("reconcile(limit)"));
  assert.match(list,/operator_status='open'/,"only unresolved entries");
  assert.match(list,/JOIN rfpilot\.ai_jobs/,"carries the job type and attempt counts an operator needs");

  const route=readSrc("routes/jobsRoute.ts");
  assert.match(route,/admin\/jobs\/dead-letters/,"an endpoint exists");
  const line=route.slice(route.indexOf("dead-letters"));
  assert.match(line.slice(0,160),/authorizeAction\("security:admin"\)/,"admin-only");
});

const {pseudonym,sanitizeTelemetry}=require("../src/shared/observability/safeTelemetry");
test("every attempt logs its start, outcome and timings, whatever the job type",()=>{
 // The regression: only five of thirteen handlers logged their own failure, and
 // the worker's catch settled the row and returned without a line, so a failed
 // requirement extraction produced NOTHING in CloudWatch and the reason could
 // only be read out of proposal_context_runs.safe_error_code.
 const worker=readSrc("src/modules/durableJobs/worker.ts");
 const failure=worker.slice(worker.indexOf("const failed = await repository.fail("));
 assert.match(failure.slice(0,1200),/safeLog\("error", "job\.attempt\.failed"/,"the generic catch logs");
 assert.match(failure.slice(0,1200),/errorCode: code/,"carries the diagnostic code it just persisted");
 assert.match(failure.slice(0,1200),/outcome: failed\.status/,"separates a scheduled retry from a terminal failure");

 // Start and success close the lifecycle: without them a missing completion
 // cannot be told apart from a job that was never delivered, and queue backlog
 // is invisible until durations move.
 assert.match(worker,/safeLog\("info", "job\.attempt\.started"/,"an attempt announces itself");
 assert.match(worker,/queueWaitMs: Math\.max\(0, startedAt - job\.timestamp\)/,"enqueue-to-start latency is measured");
 assert.match(worker,/safeLog\("info", "job\.attempt\.completed"/,"a successful attempt is logged");
 const started=worker.indexOf('"job.attempt.started"'),claim=worker.indexOf("repository.claim(");
 assert.ok(claim<started,"the start line follows the claim, so it means started and not merely delivered");

 // Attributes outside the allowlist are dropped silently, so assert the record
 // an operator greps for actually survives sanitisation.
 const emitted=sanitizeTelemetry({
  queueWaitMs:57,
  jobId:"01900000-0000-7000-8000-000000000001",
  jobType:"proposal_context_extract",
  runId:"01900000-0000-7000-8000-000000000002",
  correlationId:"correlation",
  organizationPseudonym:pseudonym("507f1f77bcf86cd799439011"),
  attempt:2,
  errorCode:"LIVE_AI_PROVIDER_TEMPORARY",
  retryable:true,
  outcome:"retry_scheduled",
  durationMs:1234,
 });
 for(const key of ["jobId","jobType","runId","correlationId","organizationPseudonym","attempt","errorCode","retryable","outcome","durationMs","queueWaitMs"])
  assert.ok(key in emitted,`${key} reaches the log line`);
 assert.equal(emitted.errorCode,"LIVE_AI_PROVIDER_TEMPORARY");
 assert.equal(emitted.organizationPseudonym.length,16,"the tenant is pseudonymised, never logged raw");
});
