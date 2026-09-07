const test = require('node:test');
const assert = require('node:assert/strict');
const Proposal = require('../modal/proposalsModel').default;
const {syncFieldGapQuestions} = require('../src/modules/conversations/fieldGapQuestions');
const {IMPORTANT_FIELD_QUESTIONS,fieldQuestionCode} = require('../src/modules/conversations/domain');

test('extra extraction questions cannot consume the core intake budget', async t => {
  const original = Proposal.findOne;
  t.after(() => {Proposal.findOne = original;});
  const saved = {venueSchedule:{venueName:'QA Venue'}};
  Proposal.findOne = scope => {
    assert.deepEqual(scope,{_id:'proposal',userId:'actor',organizationId:'organization'});
    return {select:()=>({lean:async()=>saved})};
  };
  const inserted=[];
  const client={query:async(sql,args)=>{
    if(sql.includes('count(DISTINCT')) {
      // Eight arbitrary extraction diagnostics already exist. They must not
      // reduce how many of the nineteen core questions can still be created.
      assert.match(sql,/q\.issue_code=ANY\(\$4::text\[\]\)/);
      assert.deepEqual(args[3],IMPORTANT_FIELD_QUESTIONS.slice(0,19).map(field=>fieldQuestionCode(field.path)));
      return {rows:[{n:0}]};
    }
    if(sql.includes('INSERT INTO')) {inserted.push(args[4]);return {rows:[{id:'inserted'}]};}
    return {rows:[]};
  }};
  const snapshot=await syncFieldGapQuestions(client,'org','ref','conversation',{
    organizationMongoId:'organization',actorUserMongoId:'actor',proposalMongoId:'proposal'});
  assert.equal(snapshot,saved,'reuse the tenant-scoped proposal snapshot for progress without another read');
  assert.equal(inserted.length,18,'all missing core questions remain askable; venue is already saved');
  assert.ok(inserted.includes(fieldQuestionCode('/content/budget/proposalSubmissionDueDate')));
});
