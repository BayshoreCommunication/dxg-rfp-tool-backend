const test = require('node:test');
const assert = require('node:assert/strict');
const {buildIntakeProgress} = require('../src/modules/conversations/intakeProgress');
const {IMPORTANT_FIELD_QUESTIONS, importantFieldPaths} = require('../src/modules/conversations/domain');
const {mongoPathFor} = require('../src/modules/candidateApplication/canonicalMapping');
const fields = IMPORTANT_FIELD_QUESTIONS.slice(0, 19);
const row = (index, status = 'open', extra = {}) => ({id:`q-${index}`, issue_code:`MISSING_FIELD:${fields[index].path}`,
  severity:'question', canonical_paths:importantFieldPaths(fields[index]), status, ...extra});
const proposalWith = entries => {
  const proposal = {};
  for (const [path, value] of entries) {
    const keys = mongoPathFor(path).split('.');
    let target = proposal;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  return proposal;
};

test('all nineteen slots exist before extraction or any question is asked', () => {
  const progress = buildIntakeProgress({}, []);
  assert.equal(progress.total, 19);
  assert.equal(progress.completed, 0);
  assert.equal(progress.items.length, 19);
  assert.equal(new Set(progress.items.map(item => item.key)).size, 19);
  assert.deepEqual(progress.extraQuestionIds, []);
});

test('venue activation and the following city answer cannot grow the denominator', () => {
  const opening = fields.slice(0, 8).map((_, i) => row(i));
  const selected = proposalWith([[fields[5].path, 'QA Chicago Venue']]);
  const cityAnswered = proposalWith([[fields[5].path, 'QA Chicago Venue'], [fields[6].path, 'Chicago'], [fields[8].path, 'IL']]);
  const snapshots = [buildIntakeProgress({}, opening), buildIntakeProgress(selected, fields.map((_, i) => row(i))),
    buildIntakeProgress(cityAnswered, fields.map((_, i) => row(i)))];
  assert.deepEqual(snapshots.map(item => item.total), [19, 19, 19]);
  assert.deepEqual(snapshots.map(item => item.completed), [0, 1, 3]);
  assert.deepEqual(snapshots[0].items.map(item => item.key), snapshots[2].items.map(item => item.key));
});

test('suggestions and duplicate diagnostic rows never add completion or slots', () => {
  const questions = [row(0, 'open', {suggestedAnswer:'Extracted event'}), row(0, 'open', {id:'duplicate'}), row(1)];
  const before = JSON.stringify(questions);
  const progress = buildIntakeProgress({event:{eventName:'Untitled proposal'}}, questions);
  assert.equal(progress.total, 19);
  assert.equal(progress.completed, 0);
  assert.equal(progress.items[0].questionId, 'q-0');
  assert.equal(JSON.stringify(questions), before);
});

test('confirmed fields remain complete when their original questions are retired', () => {
  const saved = proposalWith([[fields[0].path, 'Saved event'], [fields[7].path, 0], [fields[12].path, false]]);
  assert.equal(buildIntakeProgress(saved, []).completed, 3);
  assert.equal(buildIntakeProgress({}, [row(0, 'answered'), row(1, 'dismissed')]).completed, 2);
});

test('load-in is one slot and needs both date and time, including legacy split answers', () => {
  const paths = importantFieldPaths(fields[16]);
  assert.equal(paths.length, 2);
  const dateOnly = proposalWith([[paths[0], '2027-11-15']]);
  assert.equal(buildIntakeProgress(dateOnly, []).items[16].status, 'open');
  assert.equal(buildIntakeProgress(dateOnly, [row(16, 'answered', {canonical_paths:[paths[1]]})]).items[16].status, 'answered');
  assert.equal(buildIntakeProgress({}, [row(16, 'answered', {canonical_paths:[paths[0]]})]).items[16].status, 'open');
});

test('unknown venue never auto-completes future questions, explicit skip defers them', () => {
  assert.equal(buildIntakeProgress({}, [row(5)]).completed, 0);
  const skipped = buildIntakeProgress({}, [row(5, 'dismissed')]);
  assert.equal(skipped.items.filter(item => item.status === 'not_applicable').length, 11);
  assert.equal(skipped.completed, 12);
  assert.equal(skipped.total, 19);
  const selected = buildIntakeProgress(proposalWith([[fields[5].path, 'QA Venue']]), [row(5, 'dismissed')]);
  assert.equal(selected.items.filter(item => item.status === 'not_applicable').length, 0);
  const incompleteVenue = proposalWith([['/content/venueSchedule/venueConfirmedStatus', 'Preferred']]);
  assert.equal(buildIntakeProgress(incompleteVenue, []).items[9].status, 'open');
});

test('streaming and conflicts remain visible separately even when core intake is done', () => {
  const conflict = row(0, 'open', {id:'conflict',issue_code:'CROSS_SOURCE_CONFLICT',severity:'blocking'});
  const streaming = {id:'streaming',issue_code:'MISSING_FIELD:/content/hybridVirtual/streamingPlatform',severity:'question',canonical_paths:['/content/hybridVirtual/streamingPlatform'],status:'open'};
  const progress = buildIntakeProgress({}, [...fields.map((_, i) => row(i, 'answered')), conflict, streaming]);
  assert.equal(progress.total, 19);
  assert.equal(progress.completed, 19);
  assert.deepEqual(progress.extraQuestionIds, ['conflict', 'streaming']);
});
