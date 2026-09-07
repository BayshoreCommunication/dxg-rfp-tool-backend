const assert = require('node:assert/strict');
const test = require('node:test');
const RefreshSession = require('../modal/refreshSessionModel').default;
const {mongoRefreshSessionRepository: repository} = require('../src/modules/auth/infrastructure/mongo/mongoRefreshSessionRepository');

test('reader-first release finds historical refresh tokens but never treats them as active', async () => {
  const original = RefreshSession.findOne;
  let filter;
  RefreshSession.findOne = query => {
    filter = query;
    return {select:() => ({lean:async () => ({_id:'row',organizationId:'org',userId:'user',sessionId:'session',familyId:'family',tokenId:'new-id',tokenHash:'new-hash',status:'active',expiresAt:new Date(10000),idleExpiresAt:new Date(10000)})})};
  };
  try {
    assert.equal((await repository.findByTokenHash('old-hash')).status, 'consumed');
    assert.deepEqual(filter, {$or:[{tokenHash:'old-hash'},{consumedTokenHashes:'old-hash'}]});
    assert.equal((await repository.findByTokenHash('new-hash')).status, 'active');
  } finally { RefreshSession.findOne = original; }
});

test('a stale legacy writer must include the hash it originally read in its consume CAS', async () => {
  const original = RefreshSession.updateOne;
  let filter;
  RefreshSession.updateOne = async query => { filter = query; return {modifiedCount:0}; };
  try {
    assert.equal(await repository.consumeActive({id:'row',tokenHash:'old-hash',now:new Date()}),false);
    assert.deepEqual(filter,{_id:'row',tokenHash:'old-hash',status:'active'});
  } finally { RefreshSession.updateOne = original; }
});
