const test=require("node:test");const assert=require("node:assert/strict");require("ts-node/register");
const {createDispatcher}=require("../src/modules/durableJobs/dispatcher");
const message={jobId:"01900000-0000-7000-8000-000000000001",organizationMongoId:"507f1f77bcf86cd799439011",actorUserMongoId:"507f191e810c19729de860ea",jobType:"source_security_scan",inputReference:"01900000-0000-7000-8000-000000000002",inputVersion:"a".repeat(64),correlationId:"correlation"};
const repository=()=>({
 published:[],failed:[],claims:[{eventId:"evt",message}],reconciled:[message],
 async claimOutbox(){return this.claims},async markOutboxPublished(id){this.published.push(id)},async markOutboxFailed(id,code){this.failed.push([id,code])},async reconcile(){return this.reconciled}
});
test("dispatcher publishes reference-only messages and acknowledges outbox",async()=>{const repo=repository();const seen=[];const dispatcher=createDispatcher(repo,{async publish(value){seen.push(value)}});assert.deepEqual(await dispatcher.dispatch(),{claimed:1,published:1});assert.deepEqual(repo.published,["evt"]);assert.equal(seen[0].jobId,message.jobId);for(const prohibited of ["documentText","signedUrl","accessToken","proposalBody"])assert.equal(prohibited in seen[0],false);});
test("dispatcher records safe failure code when Redis publish fails",async()=>{const repo=repository();const dispatcher=createDispatcher(repo,{async publish(){throw new Error("secret provider details")}});assert.deepEqual(await dispatcher.dispatch(),{claimed:1,published:0});assert.deepEqual(repo.failed,[["evt","REDIS_PUBLISH_FAILED"]]);});
test("reconciliation republishes authoritative queued job references",async()=>{const repo=repository();let count=0;const dispatcher=createDispatcher(repo,{async publish(){count++}});assert.equal(await dispatcher.reconcile(),1);assert.equal(count,1);});

const {attemptBudget}=require("../src/modules/durableJobs/domain");
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
