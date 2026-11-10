// ORG-604: RFP templates through the real app (routes, authenticate middleware, controller, use
// cases, Mongo repositories): saving from an RFP, the snapshot, role policy, the personal and
// organization boundary, audit, creating an RFP from a template (owner, team, plan limit), and
// cross-tenant isolation.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import ProposalStatusTransition from '../modal/proposalStatusTransitionModel';
import ProposalTemplate from '../modal/proposalTemplateModel';
import PublicAccessGrant from '../modal/publicAccessGrantModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import Team from '../modal/teamModel';
import TeamMembership from '../modal/teamMembershipModel';
import User from '../modal/userModel';
import { authenticationSessions } from '../src/modules/auth/composition';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';
import { closeQueue } from '../src/modules/durableJobs/queue';

let server: http.Server;
let baseUrl: string;
let orgA: mongoose.Types.ObjectId;
let orgB: mongoose.Types.ObjectId;
const orgIds: mongoose.Types.ObjectId[] = [];
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};
const MARKER = `TPL${randomMongoId().slice(0, 10).toUpperCase()}`;
let sourceId: string;
let teamId: string;

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]) => {
  const user = await User.create({ name: key, email: `${key}-${randomMongoId().slice(0, 10)}@example.com`, password: 'not-a-real-hash', role: 'customer', organizationId });
  const membership = await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active' });
  const session = await authenticationSessions.begin({
    account: { userId: String(user._id), accountType: 'planner', email: user.email, organizationId: String(organizationId), role: 'customer', roles, rolesVersion: membership.version },
    correlationId: randomMongoId(),
  });
  tokens[key] = session.accessToken;
  userIds[key] = String(user._id);
};
const send = async (headers: Record<string, string>, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
const call = (who: string, method: string, path: string, body?: unknown) => send({ authorization: `Bearer ${tokens[who]}` }, method, path, body);
const BASE = '/api/v1/proposal-templates';
const titles = async (who: string, query = '') =>
  ((await call(who, 'GET', `${BASE}${query}`)).body.data.items as Array<{ title: string }>).map((t) => t.title);
const stored = (templateId: string) => ProposalTemplate.findOne({ _id: templateId, organizationId: { $in: orgIds } }).lean();
const save = async (who: string, fields: Record<string, unknown> = {}) => {
  const res = await call(who, 'POST', BASE, { proposalId: sourceId, title: `${who} template`, ...fields });
  assert.equal(res.status, 201, `${who}: ${res.text}`);
  return res.body.data as Record<string, any>;
};
const auditActions = async (templateId: string) =>
  (await SecurityAuditEvent.find({ organizationId: orgA, targetType: 'proposal_template', targetId: templateId }).sort({ createdAt: 1, _id: 1 }).lean()).map((e) => e.action);

const MANAGERS = ['owner', 'admin'];

before(async () => {
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await ProposalTemplate.init();
  // full_access: these tests create more than two RFPs in one organization. The free-trial
  // limit on create-from-template has its own organization below.
  orgA = (await Organization.create({ name: 'Templates A', slug: `intg-templates-${randomMongoId().slice(0, 10)}`, plan: 'full_access' }))._id as mongoose.Types.ObjectId;
  orgB = (await Organization.create({ name: 'Templates B', slug: `intg-templates-${randomMongoId().slice(0, 10)}`, plan: 'full_access' }))._id as mongoose.Types.ObjectId;
  orgIds.push(orgA, orgB);
  await member(orgA, 'owner', ['owner']);
  await member(orgA, 'admin', ['organization_admin']);
  await member(orgA, 'manager', ['team_manager']);
  await member(orgA, 'planner', ['planner']);
  await member(orgA, 'colleague', ['planner']);
  await member(orgA, 'viewer', ['viewer']);
  await member(orgB, 'foreignOwner', ['owner']);
  await member(orgB, 'foreignPlanner', ['planner']);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The planner is on exactly one team, so an RFP they create lands on it (ORG-202).
  const team = await Team.create({ organizationId: orgA, name: 'Conferences' });
  teamId = String(team._id);
  await TeamMembership.create({ organizationId: orgA, teamId: team._id, userId: userIds.planner, isManager: false });

  // The source RFP: the owner's, submitted, with everything a template must leave behind.
  const created = await call('owner', 'POST', '/api/proposals', {
    event: { eventName: `${MARKER} Kickoff`, startDate: '2026-03-02', endDate: '2026-03-04', editionYear: '2026', attendees: '800', eventObjectives: 'Launch the new line', rfpTimeline: 'Responses due 1 Feb' },
    venueSchedule: { venueName: 'Grand Hall', loadInDate: '2026-03-01', loadInTime: '08:00' },
    roomByRoom: [{ roomFunction: 'General session', loadInDateTime: '2026-03-01T08:00', wirelessMicsQty: '6' }],
    production: { unionLabor: 'Yes' },
    venue: { riggingRequired: 'YES', venueAvContactEmail: 'sam@venue.example' },
    uploads: { supportDocuments: ['https://files.example/secret.pdf'], coVendors: { photographer: { companyName: 'Snap Co', contactEmail: 'snap@vendor.example' } } },
    budget: { estimatedAvBudget: '$100k-$250k', proposalSubmissionDueDate: '2026-02-01' },
    contact: { contactFirstName: 'Pat', contactLastName: 'Planner', contactEmail: 'pat@customer.example', contactPhone: '+1 555 0199' },
  });
  assert.equal(created.status, 201, created.text);
  sourceId = String(created.body.data._id);
  assert.equal((await call('owner', 'PATCH', `/api/proposals/${sourceId}/status`, { status: 'submitted' })).status, 200);
  // A vendor is invited, so the RFP has vendor state of its own.
  const issued = await call('owner', 'POST', '/api/public-access', { resourceId: sourceId, purpose: 'vendor:submit', recipient: 'invited@vendor.example' });
  assert.equal(issued.status, 201, issued.text);
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      ProposalTemplate.deleteMany({ organizationId: { $in: orgIds } }),
      Proposal.deleteMany({ organizationId: { $in: orgIds } }),
      ProposalStatusTransition.collection.deleteMany({ organizationId: { $in: orgIds } }),
      PublicAccessGrant.deleteMany({ organizationId: { $in: orgIds } }),
      Team.deleteMany({ organizationId: { $in: orgIds } }),
      TeamMembership.deleteMany({ organizationId: { $in: orgIds } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: orgIds } }),
      RefreshSession.deleteMany({ organizationId: { $in: orgIds } }),
      User.deleteMany({ organizationId: { $in: orgIds } }),
      Organization.deleteMany({ _id: { $in: orgIds } }),
    ]);
  }
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeQueue();
});

test('saving an RFP as a template keeps content and layout, and leaves vendors, responses, dates, files and contacts behind', async () => {
  const template = await save('owner', { title: `${MARKER} standard`, description: 'Our standard kickoff', scope: 'organization', presentationLayout: 'template-two' });
  assert.deepEqual(
    [template.scope, template.published, template.usable, template.ownedByMe, template.ownerUserId, template.publishedBy, template.presentationLayout, template.eventName, template.archived],
    ['organization', true, true, true, userIds.owner, userIds.owner, 'template-two', `${MARKER} Kickoff`, false],
  );
  const event = template.content.event as Record<string, unknown>;
  assert.deepEqual([event.eventName, event.attendees, event.eventObjectives], [`${MARKER} Kickoff`, '800', 'Launch the new line']);
  for (const dropped of ['startDate', 'endDate', 'editionYear', 'rfpTimeline']) assert.equal(dropped in event, false, dropped);
  assert.deepEqual(Object.keys(template.content).filter((section) => ['contact', 'uploads', 'lifecycle', 'proposalSettings', 'videoRecordingStep'].includes(section)), []);
  assert.deepEqual(template.content.venueSchedule, { venueName: 'Grand Hall' });
  assert.deepEqual(template.content.roomByRoom, [{ roomFunction: 'General session', wirelessMicsQty: '6' }]);
  assert.deepEqual(template.content.venue, { riggingRequired: 'YES' });
  assert.deepEqual(template.content.budget, { estimatedAvBudget: '$100k-$250k' });

  const row = (await stored(template.id))!;
  assert.equal(String(row.organizationId), String(orgA));
  const everything = JSON.stringify(row);
  assert.doesNotMatch(everything, /2026-0[1-3]|08:00|Responses due|files\.example|vendor\.example|venue\.example|customer\.example|Snap Co|555 0199|"lifecycle"|"contact"|"uploads"|"proposalSettings"|vendorsInvited|"status"/);
  assert.doesNotMatch(everything, new RegExp(sourceId));
  // The source RFP is untouched.
  const source = (await Proposal.findOne({ _id: sourceId, organizationId: orgA }).lean())!;
  assert.deepEqual([source.status, source.event.startDate, source.contact.contactEmail], ['submitted', '2026-03-02', 'pat@customer.example']);
  // The list carries no snapshot.
  const listed = (await call('planner', 'GET', `${BASE}?search=${MARKER}`)).body.data;
  assert.deepEqual([listed.total, listed.items[0].title, listed.items[0].eventName, 'content' in listed.items[0]], [1, `${MARKER} standard`, `${MARKER} Kickoff`, false]);
  assert.deepEqual(await auditActions(template.id), ['proposal_template.created', 'proposal_template.published']);
});

test('policy per role: Owner and Admin manage organization templates; Team Manager and Planner use them and keep personal ones; Viewers get nothing', async () => {
  const shared = await save('admin', { title: 'Policy shared', scope: 'organization' });

  // Viewers: every route is refused, and nothing about the template comes back.
  const viewerAttempts: Array<[string, string, unknown?]> = [
    ['GET', BASE], ['POST', BASE, { proposalId: sourceId, title: 'Viewer' }], ['GET', `${BASE}/${shared.id}`], ['PATCH', `${BASE}/${shared.id}`, { title: 'Viewer' }],
    ['POST', `${BASE}/${shared.id}/publish`], ['POST', `${BASE}/${shared.id}/unpublish`], ['POST', `${BASE}/${shared.id}/archive`], ['POST', `${BASE}/${shared.id}/restore`],
    ['POST', `${BASE}/${shared.id}/proposals`, { eventName: 'Viewer RFP' }],
  ];
  const before = await Proposal.countDocuments({ organizationId: orgA });
  for (const [method, path, body] of viewerAttempts) {
    const refused = await call('viewer', method, path, body);
    assert.equal(refused.status, 403, `viewer ${method} ${path}: ${refused.text}`);
    assert.doesNotMatch(refused.text, /Policy shared|Kickoff/);
  }
  assert.equal(await Proposal.countDocuments({ organizationId: orgA }), before);
  assert.equal(await ProposalTemplate.countDocuments({ organizationId: orgA, ownerUserId: userIds.viewer }), 0);

  // Team Manager and Planner.
  for (const who of ['manager', 'planner']) {
    const personal = await save(who, { title: `Policy personal ${who}` });
    assert.deepEqual([personal.scope, personal.published, personal.ownerUserId], ['personal', false, userIds[who]]);
    assert.equal((await call(who, 'GET', `${BASE}/${shared.id}`)).status, 200);
    const refusals: Array<[string, string, unknown?]> = [
      ['POST', BASE, { proposalId: sourceId, title: 'Not allowed', scope: 'organization' }],
      ['POST', `${BASE}/${personal.id}/publish`], ['POST', `${BASE}/${shared.id}/publish`], ['POST', `${BASE}/${shared.id}/unpublish`],
      ['POST', `${BASE}/${shared.id}/archive`], ['POST', `${BASE}/${shared.id}/restore`], ['PATCH', `${BASE}/${shared.id}`, { title: 'Taken over' }],
    ];
    for (const [method, path, body] of refusals) assert.equal((await call(who, method, path, body)).status, 403, `${who} ${method} ${path}`);
    assert.equal((await call(who, 'PATCH', `${BASE}/${personal.id}`, { description: 'Mine' })).body.data.description, 'Mine');
    assert.equal((await call(who, 'POST', `${BASE}/${personal.id}/archive`)).body.data.archived, true);
    assert.equal((await call(who, 'POST', `${BASE}/${personal.id}/restore`)).body.data.archived, false);
    assert.deepEqual(await auditActions(personal.id), ['proposal_template.created', 'proposal_template.updated', 'proposal_template.archived', 'proposal_template.restored']);
  }
  const unchanged = (await stored(shared.id))!;
  assert.deepEqual([unchanged.title, unchanged.archived, unchanged.publishedAt !== null], ['Policy shared', false, true]);

  // Owner and Admin, on a template the other one saved.
  for (const who of MANAGERS) {
    assert.equal((await call(who, 'POST', `${BASE}/${shared.id}/unpublish`)).body.data.published, false);
    assert.deepEqual(await titles('planner', '?search=Policy%20shared'), []);
    assert.equal((await call('planner', 'GET', `${BASE}/${shared.id}`)).status, 403);
    assert.equal((await call('planner', 'POST', `${BASE}/${shared.id}/proposals`)).status, 403);
    const republished = await call(who, 'POST', `${BASE}/${shared.id}/publish`);
    assert.deepEqual([republished.status, republished.body.data.published, republished.body.data.publishedBy], [200, true, userIds[who]]);
    assert.deepEqual(await titles('planner', '?search=Policy%20shared'), ['Policy shared']);
    const archived = await call(who, 'POST', `${BASE}/${shared.id}/archive`);
    assert.deepEqual([archived.body.data.archived, archived.body.data.published], [true, false]);
    assert.equal((await call(who, 'POST', `${BASE}/${shared.id}/publish`)).body.code, 'TEMPLATE_ARCHIVED');
    assert.equal((await call(who, 'POST', `${BASE}/${shared.id}/proposals`)).body.code, 'TEMPLATE_ARCHIVED');
    assert.deepEqual(await titles(who, '?status=archived&scope=organization'), ['Policy shared']);
    assert.equal((await call(who, 'POST', `${BASE}/${shared.id}/restore`)).body.data.published, false);
    assert.equal((await call(who, 'POST', `${BASE}/${shared.id}/publish`)).body.data.published, true);
  }
  assert.deepEqual(await auditActions(shared.id), [
    'proposal_template.created', 'proposal_template.published',
    ...MANAGERS.flatMap(() => ['proposal_template.unpublished', 'proposal_template.published', 'proposal_template.archived', 'proposal_template.restored', 'proposal_template.published']),
  ]);
  // The audit trail names the template, never its content.
  const metadata = JSON.stringify((await SecurityAuditEvent.find({ organizationId: orgA, targetType: 'proposal_template' }).lean()).map((e) => e.metadata));
  assert.doesNotMatch(metadata, /Launch the new line|Grand Hall|General session/);
});

test('a personal template is visible only to its owner: others in the organization get 403, whatever their role', async () => {
  const mine = await save('planner', { title: `${MARKER} private pattern` });
  assert.deepEqual(await titles('planner', `?search=${MARKER}%20private`), [`${MARKER} private pattern`]);
  for (const who of ['owner', 'admin', 'manager', 'colleague']) {
    assert.deepEqual(await titles(who, `?search=${MARKER}%20private&status=all&scope=all`), [], who);
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `${BASE}/${mine.id}`], ['PATCH', `${BASE}/${mine.id}`, { title: 'Seen' }], ['POST', `${BASE}/${mine.id}/archive`],
      ['POST', `${BASE}/${mine.id}/restore`], ['POST', `${BASE}/${mine.id}/proposals`, {}],
      ...(MANAGERS.includes(who) ? [['POST', `${BASE}/${mine.id}/publish`], ['POST', `${BASE}/${mine.id}/unpublish`]] as Array<[string, string]> : []),
    ];
    for (const [method, path, body] of attempts) {
      const refused = await call(who, method, path, body);
      assert.deepEqual([refused.status, refused.body.code], [403, 'TEMPLATE_ACCESS_DENIED'], `${who} ${method} ${path}`);
      assert.doesNotMatch(refused.text, new RegExp(`${MARKER}|Kickoff`));
    }
  }
  const row = (await stored(mine.id))!;
  assert.deepEqual([row.scope, row.title, row.archived, String(row.ownerUserId)], ['personal', `${MARKER} private pattern`, false, userIds.planner]);
  assert.equal(await Proposal.countDocuments({ organizationId: orgA, 'event.eventName': `${MARKER} private pattern` }), 0);
});

test('an RFP the member cannot see cannot be saved as a template', async () => {
  // The colleague is a Planner with no share on the owner's RFP: in the organization, out of reach.
  const refused = await call('colleague', 'POST', BASE, { proposalId: sourceId, title: 'Borrowed' });
  assert.deepEqual([refused.status, refused.body.code], [403, 'PROPOSAL_ACCESS_DENIED']);
  const missing = await call('colleague', 'POST', BASE, { proposalId: randomMongoId(), title: 'Borrowed' });
  assert.deepEqual([missing.status, missing.body.code], [404, 'TEMPLATE_SOURCE_NOT_FOUND']);
  assert.equal(await ProposalTemplate.countDocuments({ organizationId: orgA, ownerUserId: userIds.colleague }), 0);
});

test('an RFP created from a template is owned by its creator, lands on their team, and is a clean draft', async () => {
  const template = await save('owner', { title: 'Team standard', scope: 'organization', presentationLayout: 'template-one' });
  const created = await call('planner', 'POST', `${BASE}/${template.id}/proposals`, {
    eventName: 'Spring Summit', userId: userIds.owner, teamId: randomMongoId(), organizationId: String(orgB), status: 'submitted', isDraft: false,
  });
  assert.equal(created.status, 201, created.text);
  const rfp = (await Proposal.findOne({ _id: created.body.data._id, organizationId: orgA }).lean())!;
  assert.equal(String(rfp.userId), userIds.planner);
  assert.equal(String(rfp.teamId), teamId);
  assert.equal(String(rfp.organizationId), String(orgA));
  assert.deepEqual([rfp.status, rfp.isDraft, rfp.isCopy, rfp.isArchived, rfp.viewsCount], ['unsubmitted', true, false, false, 0]);
  assert.deepEqual(
    [rfp.event.eventName, rfp.event.attendees, rfp.event.startDate, rfp.event.endDate, rfp.event.editionYear, rfp.event.rfpTimeline],
    ['Spring Summit', '800', undefined, undefined, undefined, undefined],
  );
  assert.deepEqual(rfp.roomByRoom, [{ roomFunction: 'General session', wirelessMicsQty: '6' }]);
  assert.deepEqual([rfp.uploads, rfp.contact?.contactEmail, rfp.lifecycle?.vendorsInvited ?? 0], [{}, undefined, 0]);
  assert.equal(await PublicAccessGrant.countDocuments({ organizationId: orgA, resourceId: String(rfp._id) }), 0);
  // The creator opens and edits it like any RFP of their own; the Team Manager role is not needed.
  assert.equal((await call('planner', 'GET', `/api/proposals/${rfp._id}`)).status, 200);
  assert.equal((await call('planner', 'PUT', `/api/proposals/${rfp._id}`, { event: { eventName: 'Spring Summit 2' } })).status, 200);
  // A member on no team gets an RFP with no team; without a name the template's event name is used.
  const untitled = await call('admin', 'POST', `${BASE}/${template.id}/proposals`);
  assert.equal(untitled.status, 201, untitled.text);
  const second = (await Proposal.findOne({ _id: untitled.body.data._id, organizationId: orgA }).lean())!;
  assert.deepEqual([String(second.userId), second.teamId, second.event.eventName], [userIds.admin, null, `${MARKER} Kickoff`]);
  // Each one took a plan slot.
  assert.equal((await Organization.findById(orgA).select('proposalsCreated').lean())!.proposalsCreated, 3);
});

test('a free-trial organization at its limit is refused when creating from a template, and the race for the last slot has one winner', async () => {
  const free = (await Organization.create({ name: 'Templates Free', slug: `intg-templates-free-${randomMongoId().slice(0, 10)}` }))._id as mongoose.Types.ObjectId;
  orgIds.push(free);
  await member(free, 'freeOwner', ['owner']);
  const first = await call('freeOwner', 'POST', '/api/proposals', { event: { eventName: 'Free one' } });
  assert.equal(first.status, 201, first.text);
  const template = await call('freeOwner', 'POST', BASE, { proposalId: first.body.data._id, title: 'Free template' });
  assert.equal(template.status, 201, template.text);
  const path = `${BASE}/${template.body.data.id}/proposals`;
  // Saving a template uses no slot.
  assert.equal((await Organization.findById(free).select('proposalsCreated').lean())!.proposalsCreated, 1);

  const race = await Promise.all(Array.from({ length: 6 }, () => call('freeOwner', 'POST', path, { eventName: 'Racing' })));
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 403, 403, 403, 403, 403], JSON.stringify(race.map((r) => r.body.code ?? r.body.message)));

  const refused = await call('freeOwner', 'POST', path, { eventName: 'Third' });
  assert.equal(refused.status, 403, refused.text);
  assert.deepEqual(
    { code: refused.body.code, plan: refused.body.plan, limit: refused.body.limit, created: refused.body.created, success: refused.body.success },
    { code: 'PLAN_LIMIT_REACHED', plan: 'free_trial', limit: 2, created: 2, success: false },
  );
  assert.match(refused.body.message, /RFP/);
  assert.doesNotMatch(refused.body.message, /proposal/i);
  assert.equal(await Proposal.countDocuments({ organizationId: free }), 2);
  assert.equal((await Organization.findById(free).select('proposalsCreated').lean())!.proposalsCreated, 2);
  // Templates themselves stay available at the limit; only a new RFP needs a slot.
  assert.equal((await call('freeOwner', 'GET', BASE)).body.data.total, 1);
  // After a plan change the same request succeeds.
  await Organization.updateOne({ _id: free }, { $set: { plan: 'full_access' } });
  assert.equal((await call('freeOwner', 'POST', path, { eventName: 'Third' })).status, 201);
});

test('another organization can neither see, use nor change a template: a foreign template is a 404', async () => {
  const secret = await save('owner', { title: `${MARKER} foreign probe`, description: `${MARKER} description`, scope: 'organization' });
  const personal = await save('planner', { title: `${MARKER} foreign personal` });
  const beforeRows = JSON.stringify([await stored(secret.id), await stored(personal.id)]);
  const missingId = randomMongoId();
  const proposalsB = await Proposal.countDocuments({ organizationId: orgB });

  for (const who of ['foreignOwner', 'foreignPlanner']) {
    for (const path of [`${BASE}?status=all&scope=all&limit=200`, `${BASE}?search=${MARKER}`, `${BASE}?organizationId=${orgA}&status=all`]) {
      const read = await call(who, 'GET', path);
      assert.equal(read.status, 200, `${who} ${path}`);
      assert.doesNotMatch(read.text, new RegExp(`${MARKER}|${secret.id}|${personal.id}|Kickoff`, 'i'), `${who} ${path}`);
    }
  }
  const attempts: Array<[string, string, unknown?]> = [
    ['GET', `${BASE}/:id`], ['PATCH', `${BASE}/:id`, { title: 'Taken over' }], ['POST', `${BASE}/:id/publish`], ['POST', `${BASE}/:id/unpublish`],
    ['POST', `${BASE}/:id/archive`], ['POST', `${BASE}/:id/restore`], ['POST', `${BASE}/:id/proposals`, { eventName: 'Stolen' }],
  ];
  for (const templateId of [secret.id, personal.id]) {
    for (const [method, path, body] of attempts) {
      const foreign = await call('foreignOwner', method, path.replace(':id', templateId), body);
      const missing = await call('foreignOwner', method, path.replace(':id', missingId), body);
      assert.equal(foreign.status, 404, `${method} ${path}: ${foreign.text}`);
      // Indistinguishable from a template that does not exist.
      assert.deepEqual(foreign.body, missing.body, `${method} ${path}`);
      assert.doesNotMatch(foreign.text, new RegExp(`${MARKER}|Kickoff`, 'i'));
    }
  }
  // A foreign RFP can't be the source of a template either.
  const stolen = await call('foreignOwner', 'POST', BASE, { proposalId: sourceId, title: 'Stolen', organizationId: String(orgA) });
  assert.deepEqual([stolen.status, stolen.body.code], [404, 'TEMPLATE_SOURCE_NOT_FOUND']);
  assert.equal(JSON.stringify([await stored(secret.id), await stored(personal.id)]), beforeRows);
  assert.equal(await Proposal.countDocuments({ organizationId: orgB }), proposalsB);
  assert.equal(await ProposalTemplate.countDocuments({ organizationId: orgB }), 0);
  assert.equal(await SecurityAuditEvent.countDocuments({ organizationId: orgB, targetType: 'proposal_template' }), 0);

  // A forged organization id does not move a write: the template lands in the caller's organization.
  const own = await call('foreignOwner', 'POST', '/api/proposals', { event: { eventName: 'B gala' } });
  assert.equal(own.status, 201, own.text);
  const forged = await call('foreignOwner', 'POST', `${BASE}?organizationId=${orgA}`, { proposalId: own.body.data._id, title: 'Forged', scope: 'organization', organizationId: String(orgA), ownerUserId: userIds.owner });
  assert.equal(forged.status, 201, forged.text);
  const forgedRow = (await stored(forged.body.data.id))!;
  assert.deepEqual([String(forgedRow.organizationId), String(forgedRow.ownerUserId)], [String(orgB), userIds.foreignOwner]);
  assert.doesNotMatch((await call('owner', 'GET', `${BASE}?status=all&limit=200`)).text, /Forged/);
});

test('template routes need a signed-in member: no token and a vendor submission link are both 401', async () => {
  const template = await save('owner', { title: 'Link probe', scope: 'organization' });
  const issued = await call('owner', 'POST', '/api/public-access', { resourceId: sourceId, purpose: 'vendor:submit', recipient: 'probe@vendor.example' });
  assert.equal(issued.status, 201, issued.text);
  const grant = String(issued.body.grant.token);
  const routes: Array<[string, string]> = [
    ['GET', BASE], ['POST', BASE], ['GET', `${BASE}/${template.id}`], ['PATCH', `${BASE}/${template.id}`], ['POST', `${BASE}/${template.id}/publish`],
    ['POST', `${BASE}/${template.id}/unpublish`], ['POST', `${BASE}/${template.id}/archive`], ['POST', `${BASE}/${template.id}/restore`], ['POST', `${BASE}/${template.id}/proposals`],
  ];
  const before = await Proposal.countDocuments({ organizationId: orgA });
  for (const [method, path] of routes) {
    for (const headers of [{}, { 'x-rfpilot-access-grant': grant }, { authorization: `Bearer ${grant}` }] as Array<Record<string, string>>) {
      const answer = await send(headers, method, `${path}?accessGrant=${encodeURIComponent(grant)}&proposalId=${sourceId}`, method === 'GET' ? undefined : { accessGrant: grant, proposalId: sourceId, title: 'From a vendor' });
      assert.equal(answer.status, 401, `${method} ${path} ${Object.keys(headers).join()}: ${answer.text}`);
      assert.doesNotMatch(answer.text, /Link probe|Kickoff/);
    }
  }
  assert.equal(await Proposal.countDocuments({ organizationId: orgA }), before);
  assert.equal((await stored(template.id))!.archived, false);
});
