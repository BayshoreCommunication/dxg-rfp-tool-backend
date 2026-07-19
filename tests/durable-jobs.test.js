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
