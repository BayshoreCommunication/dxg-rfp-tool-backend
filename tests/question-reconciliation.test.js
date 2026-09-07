const test = require('node:test');
const assert = require('node:assert/strict');
const { planExtractionQuestions, duplicateQuestionIds, reconcileQuestionDuplicates } = require('../src/modules/conversations/questionReconciliation');
const { questionPrompt, questionAnswerType, suggestedAnswerFor, IMPORTANT_FIELD_QUESTIONS } = require('../src/modules/conversations/domain');
const venue = '/content/venueSchedule/venueName';
const city = '/content/venueSchedule/venueCity';
const row = (id, paths, extra = {}) => ({ id, canonical_paths: paths, issue_code: `MISSING_FIELD:${paths[0]}`, severity: 'question', status: 'open', context_run_id: 'run', ...extra });

test('multiple venue diagnostics become one actionable question per field', () => {
  const planned = planExtractionQuestions([
    { code: 'VENUE_UNSTATED', severity: 'question', paths: [venue, city] },
    { code: 'INVALID_CANDIDATE_VALUE', severity: 'question', paths: [venue] },
    { code: 'MISSING_FIELDS', severity: 'question', paths: [venue, city] },
  ]);
  assert.deepEqual(planned.map(q => q.paths), [[venue], [city]]);
  assert.match(planned[0].prompt, /Which venue will host/);
  assert.match(planned[1].prompt, /Which city will host/);
});

test('load-in gaps are composite but load-in conflicts remain decisions', () => {
  const paths = ['/content/venueSchedule/loadInDate', '/content/venueSchedule/loadInTime'];
  const planned = planExtractionQuestions([
    { code: 'MISSING_FIELDS', severity: 'question', paths },
    { code: 'CROSS_SOURCE_CONFLICT', severity: 'blocking', paths: [paths[0]] },
  ]);
  assert.equal(planned.length, 2);
  assert.deepEqual(planned[0].paths, paths);
  assert.equal(planned[1].code, 'CROSS_SOURCE_CONFLICT');
  assert.match(planned[1].prompt, /sources disagree/);
});

test('ordinary question budget never hides a blocking decision', () => {
  const planned = planExtractionQuestions([
    { code: 'MISSING_FIELDS', severity: 'question', paths: IMPORTANT_FIELD_QUESTIONS.map(q => q.path) },
    { code: 'CROSS_SOURCE_CONFLICT', severity: 'blocking', paths: [venue] },
  ]);
  assert.equal(planned.filter(q => q.severity !== 'blocking').length, 8);
  assert.equal(planned.at(-1).code, 'CROSS_SOURCE_CONFLICT');
});

test('ordinary duplicates prefer the stable intake row, never remove conflicts', () => {
  assert.deepEqual(duplicateQuestionIds([
    row('run-gap', [venue]), row('intake', [venue], {context_run_id:null}),
    row('conflict', [venue], {issue_code:'CROSS_SOURCE_CONFLICT',severity:'blocking'}),
    row('city', [city]),
  ]), ['run-gap']);
});

test('answers and explicit skips stop duplicate ordinary questions from reappearing', () => {
  for (const status of ['answered', 'dismissed']) {
    assert.deepEqual(duplicateQuestionIds([
      row('resolved', [venue], {status,context_run_id:null}), row('duplicate', [venue]),
      row('conflict', [venue], {issue_code:'CROSS_SOURCE_CONFLICT',severity:'blocking'}),
    ]), ['duplicate']);
  }
});

test('technical extraction diagnostics use meaningful prompts and compatible answer controls', () => {
  const scenarios = [
    ['BUDGET_UNSTATED', '/content/budget/estimatedAvBudget', /estimated AV budget/, 'text', '$100,000'],
    ['REHEARSALDATE_NOT_SUPPORTED', '/content/venueSchedule/rehearsalDate', /When is the rehearsal/, 'date', '2027-09-13'],
    ['INVALID_CANDIDATE_VALUE', '/content/hybridVirtual/virtualAttendeeEstimate', /attend online/, 'number', '300'],
  ];
  for (const [code,path,prompt,type,answer] of scenarios) {
    assert.match(questionPrompt(code,[path]), prompt);
    assert.doesNotMatch(questionPrompt(code,[path]), /Please review:|UNSTATED|INVALID_|rehearsalDate|virtualAttendeeEstimate/);
    assert.equal(questionAnswerType([path]).answerType, type);
    assert.equal(suggestedAnswerFor([path],answer),answer);
  }
});

test('unknown diagnostics never expose machine codes and unavailable fields do not become unwritable asks', () => {
  assert.equal(planExtractionQuestions([{code:'UNKNOWN_FIELD',severity:'question',paths:['/content/notInThisProduct']}]).length,0);
  assert.doesNotMatch(questionPrompt('SOME_TECHNICAL_CODE',[]), /SOME|technical|code/i);
});

test('reconciliation is scoped, preserves history and is idempotent', async () => {
  let rows = [row('intake',[venue],{context_run_id:null}),row('duplicate',[venue])];
  const writes=[];
  const client={query:async(sql,args)=>{
    assert.equal(args[0],'proposal-ref');
    if (sql.startsWith('SELECT')) return {rows};
    writes.push({sql,args});
    rows=rows.filter(row=>!args[1].includes(row.id));
    return {rows:[]};
  }};
  await reconcileQuestionDuplicates(client,'proposal-ref','proposal-context.v2');
  await reconcileQuestionDuplicates(client,'proposal-ref','proposal-context.v2');
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0].args[1],['duplicate']);
  assert.match(writes[0].sql,/status='superseded'/);
  assert.match(writes[0].sql,/status='open'/);
});
