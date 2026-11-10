// ORG-401: the dashboard list and summary, through the real app against Mongo. Covers the access
// scope per role, the property that the summary is exactly an aggregate of the list, filter
// correctness, and the p95 budget on an organization with 5,000 RFPs.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import RefreshSession from '../modal/refreshSessionModel';
import RfpShare from '../modal/rfpShareModel';
import Team from '../modal/teamModel';
import TeamMembership from '../modal/teamMembershipModel';
import User from '../modal/userModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { summarize } from '../src/modules/rfpDashboard/domain';
import { LIFECYCLE_STAGES } from '../src/modules/proposalLifecycle/domain';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const users: Record<string, mongoose.Types.ObjectId> = {};
let teamId: mongoose.Types.ObjectId;
let otherTeamId: mongoose.Types.ObjectId;

// Deterministic PRNG so a failure reproduces.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const random = rng(4031);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: `Person ${key}`, email: `${key}-${randomMongoId().slice(0, 10)}@example.test`, password: 'not-a-real-hash', role: 'customer', organizationId });
  users[key] = user._id as mongoose.Types.ObjectId;
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  return { user, membership };
};
const signIn = async (organizationId: mongoose.Types.ObjectId, key: string) => {
  const membership = await OrganizationMembership.findOne({ organizationId, userId: users[key] }).lean();
  const user = await User.findById(users[key]).lean();
  const session = await authenticationSessions.begin({
    account: { userId: String(users[key]), accountType: 'planner', email: user!.email, organizationId: String(organizationId), role: 'customer', roles: membership!.roles, rolesVersion: membership!.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
};

const get = async (who: string, path: string) => {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

const CITIES = ['Chicago', 'chicago ', 'Austin', 'Denver', ''];
const DATES = ['2027-01-15', '2027-02-01', '2027-03-31', '2027-04-01', '2027-06-30', ''];

// A proposal as the lifecycle module leaves it, inserted directly for speed.
const fixture = (organizationId: mongoose.Types.ObjectId, owner: mongoose.Types.ObjectId, team: mongoose.Types.ObjectId | null, index: number, now: Date) => {
  const stage = pick(LIFECYCLE_STAGES);
  const published = stage !== 'draft';
  const awardedAt = stage === 'awarded' || (stage === 'archived' && random() < 0.5)
    ? new Date(now.getTime() - Math.floor(random() * 200) * 24 * 3600 * 1000)
    : null;
  const responded = stage === 'draft' || stage === 'sent' ? 0 : Math.floor(random() * 6);
  const legacy = random() < 0.1; // not yet backfilled: no lifecycle, stage derived from flags
  return {
    organizationId,
    userId: owner,
    teamId: team,
    status: published ? pick(['submitted', 'rejected']) : 'unsubmitted',
    isDraft: !published,
    isArchived: stage === 'archived',
    isCopy: random() < 0.05,
    event: { eventName: `Event ${index} ${pick(['Summit', 'Gala', 'Kickoff'])}`, startDate: pick(DATES) },
    venueSchedule: { venueCity: pick(CITIES) },
    ...(legacy && !['awarded', 'under_review', 'receiving_responses'].includes(stage)
      ? {}
      : { lifecycle: { revision: 1, stage, status: published ? 'submitted' : 'unsubmitted', awardedAt, vendorsInvited: responded + 1, vendorsResponded: responded } }),
    createdAt: new Date(now.getTime() - index * 60_000),
    updatedAt: new Date(now.getTime() - index * 30_000),
  };
};

let orgA: mongoose.Types.ObjectId;
let orgB: mongoose.Types.ObjectId;
let orgBig: mongoose.Types.ObjectId;
let sharedProposalId: string;

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  const now = new Date();
  orgA = (await Organization.create({ plan: 'full_access', name: 'Dashboard A', slug: `intg-dash-${randomMongoId().slice(0, 10)}`, timeZone: 'America/Chicago' }))._id as mongoose.Types.ObjectId;
  orgB = (await Organization.create({ plan: 'full_access', name: 'Dashboard B', slug: `intg-dash-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgBig = (await Organization.create({ plan: 'full_access', name: 'Dashboard Big', slug: `intg-dash-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgIds.push(orgA, orgB, orgBig);

  await member(orgA, 'admin', ['organization_admin']);
  await member(orgA, 'plannerOne', ['planner']);
  await member(orgA, 'plannerTwo', ['planner']);
  await member(orgA, 'manager', ['team_manager']);
  await member(orgA, 'viewer', ['viewer']);
  await member(orgB, 'foreigner', ['organization_admin']);
  await member(orgBig, 'bigAdmin', ['organization_admin']);
  await member(orgBig, 'bigPlanner', ['planner']);

  teamId = (await Team.create({ organizationId: orgA, name: 'Corporate' }))._id as mongoose.Types.ObjectId;
  otherTeamId = (await Team.create({ organizationId: orgA, name: 'Incentives' }))._id as mongoose.Types.ObjectId;
  await TeamMembership.create([
    { organizationId: orgA, teamId, userId: users.manager, isManager: true },
    { organizationId: orgA, teamId, userId: users.plannerOne, isManager: false },
  ]);

  const docs = Array.from({ length: 160 }, (_, i) =>
    fixture(orgA, pick([users.plannerOne, users.plannerTwo, users.admin]), pick([teamId, otherTeamId, null]), i, now));
  docs.push(...Array.from({ length: 15 }, (_, i) => fixture(orgB, users.foreigner, null, i, now)));
  const inserted = await Proposal.collection.insertMany(docs);
  // A visible, non-copy RFP of plannerTwo's shared with the viewer.
  const visible = Object.entries(inserted.insertedIds)
    .map(([i, id]) => ({ doc: docs[Number(i)], id }))
    .find(({ doc }) => String(doc.organizationId) === String(orgA) && String(doc.userId) === String(users.plannerTwo) && !doc.isCopy && !doc.isArchived)!;
  sharedProposalId = String(visible.id);
  await RfpShare.create({ organizationId: orgA, proposalId: visible.id, userId: users.viewer, permission: 'view', grantedBy: users.admin });

  const big = Array.from({ length: 5000 }, (_, i) =>
    fixture(orgBig, i % 5 === 0 ? users.bigPlanner : users.bigAdmin, null, i, now));
  await Proposal.collection.insertMany(big);
  await Proposal.syncIndexes();

  for (const key of Object.keys(users)) await signIn(key === 'foreigner' ? orgB : key.startsWith('big') ? orgBig : orgA, key);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      Proposal.collection.deleteMany({ organizationId: { $in: orgIds } }),
      RfpShare.deleteMany({ organizationId: { $in: orgIds } }),
      Team.collection.deleteMany({ organizationId: { $in: orgIds } }),
      TeamMembership.collection.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
});

const allItems = async (who: string, query: string) => {
  const items: any[] = [];
  for (let page = 1; ; page += 1) {
    const res = await get(who, `/api/v1/rfps?limit=100&page=${page}${query ? `&${query}` : ''}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    items.push(...res.body.data.items);
    if (page >= res.body.data.pagination.totalPages) {
      assert.equal(items.length, res.body.data.pagination.total);
      return items;
    }
  }
};

// What each member should see, straight from the stored rows.
const expectedIds = async (who: string) => {
  const base = { organizationId: orgA, isCopy: { $ne: true }, isArchived: { $ne: true } };
  const scope: Record<string, unknown> =
    who === 'admin' ? {}
      : who === 'manager' ? { teamId }
      : who === 'viewer' ? { _id: new mongoose.Types.ObjectId(sharedProposalId) }
      : { userId: users[who] };
  const rows = await Proposal.collection.find({ ...base, ...scope }).project({ _id: 1 }).toArray();
  return rows.map((row) => String(row._id)).sort();
};

test('each role lists exactly the RFPs the access policy allows', async () => {
  for (const who of ['admin', 'plannerOne', 'plannerTwo', 'manager', 'viewer']) {
    const ids = (await allItems(who, '')).map((item) => item.id).sort();
    assert.deepEqual(ids, await expectedIds(who), who);
  }
  const foreignIds = new Set((await allItems('foreigner', '')).map((item) => item.id));
  for (const id of await expectedIds('admin')) assert.equal(foreignIds.has(id), false);
});

test('filters cannot widen the scope', async () => {
  // plannerOne asking for plannerTwo's RFPs gets none of them.
  assert.equal((await allItems('plannerOne', `owner=${users.plannerTwo}`)).length, 0);
  // The manager asking for the other team gets nothing.
  assert.equal((await allItems('manager', `team=${otherTeamId}`)).length, 0);
});

const FILTER_CASES = () => {
  const parts: string[] = [];
  if (random() < 0.5) parts.push(`stage=${[...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(LIFECYCLE_STAGES)))].join(',')}`);
  if (random() < 0.3) parts.push(`owner=${pick([users.plannerOne, users.plannerTwo, users.admin])}`);
  if (random() < 0.3) parts.push(`team=${pick([teamId, otherTeamId])}`);
  if (random() < 0.3) parts.push(`eventFrom=${pick(['2027-01-01', '2027-02-01', '2027-04-01'])}`);
  if (random() < 0.3) parts.push(`eventTo=${pick(['2027-03-31', '2027-06-30', '2027-12-31'])}`);
  if (random() < 0.3) parts.push(`venueCity=${encodeURIComponent(pick(['chicago', 'Austin', 'DENVER']))}`);
  if (random() < 0.2) parts.push(`search=${pick(['Summit', 'gala'])}`);
  return parts.join('&');
};

test('property: the summary equals aggregating the list, and every item matches its filters', async () => {
  for (let run = 0; run < 40; run += 1) {
    const who = pick(['admin', 'plannerOne', 'manager', 'viewer']);
    let query = FILTER_CASES();
    // eventFrom after eventTo is a 400, covered below.
    const from = /eventFrom=([\d-]+)/.exec(query)?.[1];
    const to = /eventTo=([\d-]+)/.exec(query)?.[1];
    if (from && to && from > to) query = query.replace(/&?eventTo=[\d-]+/, '');
    const items = await allItems(who, query);
    const summary = await get(who, `/api/v1/rfps/summary${query ? `?${query}` : ''}`);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    const { quarter, ...reported } = summary.body.data;
    assert.deepEqual(reported, summarize(items, { start: new Date(quarter.start), end: new Date(quarter.end) }), `${who} ?${query}`);

    const params = new URLSearchParams(query);
    const stages = params.get('stage')?.split(',');
    for (const item of items) {
      if (stages) assert.ok(stages.includes(item.stage), `${item.stage} not in ${stages}`);
      else assert.notEqual(item.stage, 'archived');
      if (params.get('owner')) assert.equal(item.ownerUserId, params.get('owner'));
      if (params.get('team')) assert.equal(item.teamId, params.get('team'));
      if (params.get('eventFrom')) assert.ok(item.eventStartDate && item.eventStartDate >= params.get('eventFrom')!);
      if (params.get('eventTo')) assert.ok(item.eventStartDate && item.eventStartDate <= params.get('eventTo')!);
      if (params.get('venueCity')) assert.equal(item.venueCity?.toLowerCase(), params.get('venueCity')!.toLowerCase());
      if (params.get('search')) assert.match(item.eventName, new RegExp(params.get('search')!, 'i'));
    }
  }
});

test('the quarter is the organization\'s', async () => {
  const summary = await get('admin', '/api/v1/rfps/summary');
  assert.equal(summary.body.data.quarter.timeZone, 'America/Chicago');
  assert.equal((await get('foreigner', '/api/v1/rfps/summary')).body.data.quarter.timeZone, 'UTC');
});

test('list items carry owner and team names', async () => {
  const items = await allItems('manager', '');
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.teamName === 'Corporate' && typeof item.ownerName === 'string'));
});

test('invalid filters are a 400', async () => {
  for (const query of ['stage=won', 'owner=me', 'eventFrom=2027-13-01', 'eventFrom=2027-05-01&eventTo=2027-01-01', 'sortBy=password']) {
    const res = await get('admin', `/api/v1/rfps?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.body.code, 'DASHBOARD_FILTER_INVALID');
  }
  assert.equal((await get('admin', '/api/v1/rfps/summary?stage=won')).status, 400);
});

test('p95 stays under 300 ms on an organization with 5,000 RFPs', async () => {
  const p95 = async (who: string, path: string) => {
    for (let i = 0; i < 3; i += 1) await get(who, path); // warm up
    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      const res = await get(who, path);
      samples.push(performance.now() - started);
      assert.equal(res.status, 200);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.ceil(samples.length * 0.95) - 1];
  };
  const cases: Array<[string, string]> = [
    ['bigAdmin', '/api/v1/rfps'],
    ['bigAdmin', '/api/v1/rfps/summary'],
    ['bigAdmin', '/api/v1/rfps?stage=sent,receiving_responses&sortBy=eventStartDate&page=20'],
    ['bigAdmin', '/api/v1/rfps/summary?venueCity=chicago&eventFrom=2027-01-01'],
    ['bigPlanner', '/api/v1/rfps'],
    ['bigPlanner', '/api/v1/rfps/summary'],
  ];
  const results: string[] = [];
  for (const [who, path] of cases) {
    const value = await p95(who, path);
    results.push(`${who} ${path}: ${value.toFixed(1)} ms`);
    assert.ok(value < 300, `${who} ${path} p95 ${value.toFixed(1)} ms`);
  }
  process.stdout.write(`# p95 ${results.join(' | ')}\n`);
  const total = (await get('bigAdmin', '/api/v1/rfps/summary')).body.data.total;
  assert.ok(total > 4000 && total < 5000, `5k fixture minus archived and copies: ${total}`);
});
