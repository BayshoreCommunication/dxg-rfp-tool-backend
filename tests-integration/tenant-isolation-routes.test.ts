// ORG-108: cross-tenant isolation through every HTTP route. Organization B is seeded through its
// own API with marker strings, then every route the app registers is called as every role of
// organization A with B's ids in the path, query and body. Routes come from the Express router,
// so a route added later is swept without editing this file. A canary router with a deliberately
// unscoped handler proves the sweep fails when a route leaks.
//
// The app connects to Postgres as the non-superuser app role, as production must (ORG-105 logs
// postgres.rls.bypassed otherwise): many repositories rely on row-level security alone, and a
// superuser login would make them leak. Seeding and inspection use a separate superuser pool.
import { TEST_APP_ROLE_URL, TEST_MONGODB_DB_NAME, TEST_POSTGRES_URL, TEST_REDIS_URL } from './env';
import { connectMongo, disconnectMongo, ensureAppRole, ensureMigrated, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express, { type Application, type Response } from 'express';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import app from '../server';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { closePostgres, postgresPool } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';
import { assistantOperationalLimiter } from '../src/modules/platformAssistant/operationalLimits';
import { closeSupportRedis } from '../src/modules/supportDesk/infrastructure/redis/supportRedis';
import { closeQueue } from '../src/modules/durableJobs/queue';
import Organization from '../modal/organizationModel';
import OrganizationMembership, { CUSTOMER_ORGANIZATION_ROLES } from '../modal/organizationMembershipModel';
import Proposal from '../modal/proposalsModel';
import User from '../modal/userModel';
import VendorResponse from '../modal/vendorResponseModel';
import { beginAuthenticatedSession } from '../src/modules/auth/composition';

const ROLES = [...CUSTOMER_ORGANIZATION_ROLES, 'knowledge_editor', 'knowledge_approver'];
const MARKER = `FOREIGN${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

// Routes the sweep cannot call meaningfully: they end the caller's own session or start an
// unauthenticated sign-in flow. Everything else is swept, including DXG staff routes.
const SKIPPED = [
  /^POST \/api\/auth\/(?!sessions)/,
  /^(GET|POST) \/api\/proposals\/upload-/,
];

// Where a path parameter's real foreign id comes from, keyed by the path segment before it.
const PARAM_SOURCES: Record<string, { pg?: string; mongo?: string; field?: string }> = {
  proposals: { mongo: 'proposals' },
  'vendor-responses': { mongo: 'vendorresponses' },
  'revision-drafts': { mongo: 'vendorsubmissions' },
  submissions: { mongo: 'vendorsubmissions' },
  versions: { mongo: 'vendorsubmissionversions' },
  receipt: { mongo: 'vendorsubmissionversions' },
  drafts: { mongo: 'vendorsubmissiondrafts' },
  notifications: { mongo: 'notifications' },
  'public-access': { mongo: 'publicaccessgrants' },
  users: { mongo: 'users' },
  domains: { mongo: 'organizationdomains' },
  'all-clients': { mongo: 'users' },
  'legacy-customers': { mongo: 'users' },
  sessions: { mongo: 'refreshsessions' },
  tickets: { mongo: 'supporttickets' },
  attachments: { mongo: 'supportattachments', field: 'attachmentId' },
  emails: { mongo: 'emailcampaigns' },
  proposal: { mongo: 'proposals' },
  open: { mongo: 'vendorresponses', field: 'emailTrackingId' },
  click: { mongo: 'vendorresponses', field: 'emailTrackingId' },
  'vendor-click': { mongo: 'vendorresponses', field: 'emailTrackingId' },
  sources: { pg: 'document_sources' },
  'import-sources': { pg: 'document_sources' },
  jobs: { pg: 'ai_jobs' },
  runs: { pg: 'ai_runs' },
  'context-runs': { pg: 'proposal_context_runs' },
  'room-recommendations': { pg: 'room_recommendation_runs' },
  'analysis-runs': { pg: 'vendor_analysis_runs' },
  'fact-mapping-runs': { pg: 'vendor_intelligence_runs' },
  'evaluation-runs': { pg: 'vendor_evaluation_runs' },
  comparisons: { pg: 'comparison_runs' },
  'draft-runs': { pg: 'proposal_draft_runs' },
  'requirement-sets': { pg: 'requirement_sets' },
  requirements: { pg: 'requirements' },
  'clarification-sets': { pg: 'comparison_clarification_sets' },
  questions: { pg: 'comparison_clarification_questions' },
  threads: { pg: 'assistant_threads' },
  messages: { pg: 'assistant_messages' },
  'candidate-applications': { pg: 'candidate_applications' },
  'legal-holds': { pg: 'assistant_legal_holds' },
  'import-batches': { pg: 'knowledge_import_batches' },
  'import-documents': { pg: 'knowledge_import_documents' },
  'review-versions': { pg: 'knowledge_review_versions' },
  fragments: { pg: 'knowledge_source_fragments' },
  releases: { pg: 'knowledge_releases' },
  'pricing-records': { pg: 'pricing_records' },
  'expert-rules': { pg: 'expert_rules' },
  assets: { pg: 'governed_assets' },
  vendors: { pg: 'comparison_participants' },
  teams: { mongo: 'teams' },
  // /teams/:teamId/members/:userId and /proposals/:proposalId/shares/:userId name a member.
  members: { mongo: 'organizationmemberships', field: 'userId' },
  shares: { mongo: 'organizationmemberships', field: 'userId' },
  invitations: { mongo: 'invitations' },
};
// Parameters that name a kind rather than a record.
const LITERAL_PARAMS: Record<string, string> = { sectionKey: 'event_overview', reportType: 'executive' };

type Route = { method: string; path: string };
type Probe = { status: number; text: string; json: Record<string, unknown> | null };
type Finding = { route: string; role: string; problem: string };
type Actor = { key: string; token: string; userId: string; proposalId: string };

let admin: Pool;
let server: http.Server;
let baseUrl: string;
let redis: Redis;
let orgA: mongoose.Types.ObjectId;
let orgB: mongoose.Types.ObjectId;
let ownerB: Actor;
const actorsA: Actor[] = [];
const foreignIds = new Set<string>();
const foreignByParam = new Map<string, string>();
let baseline: Map<string, string>;
let foreignFingerprint: string;
let findings: Finding[] = [];
let probedRoutes = 0;

// Express 4 keeps each mounted router's prefix only as a regexp; this reverses the simple ones.
const mountPrefix = (layer: { regexp: RegExp & { fast_slash?: boolean } }) =>
  layer.regexp.fast_slash ? '' : layer.regexp.source.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
export const listRoutes = (target: Application): Route[] => {
  const routes: Route[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) routes.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
      else if (layer.name === 'router' && layer.handle?.stack) walk(layer.handle.stack, prefix + mountPrefix(layer));
    }
  };
  walk((target as any)._router.stack, '');
  return routes;
};

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const lookalike = (value: string) => (isUuid(value) ? crypto.randomUUID() : /^[0-9a-f]{24}$/i.test(value) ? randomMongoId() : `${value.slice(0, 4)}${crypto.randomBytes(8).toString('hex')}`);

const request = async (base: string, token: string, method: string, path: string, body?: unknown): Promise<Probe> => {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = (await res.text()).slice(0, 200_000);
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text); } catch { /* exports and pixels are not JSON */ }
    return { status: res.status, text: `${res.headers.get('location') ?? ''}${text}`, json };
  } catch (error) {
    return { status: 0, text: String(error), json: null };
  }
};

// Rate limits are per user and would turn the second probe of a pair into a 429.
const clearRateLimits = async () => {
  const keys = await redis.keys('rfpilot:rate:*');
  if (keys.length) await redis.del(...keys);
};

const VOLATILE = /(At|_at|time|date|stamp|expires|generated|now|token|ticket|nonce|signature|url)$|correlation|request/i;
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !VOLATILE.test(k)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
};
const shape = (probe: Probe, ids: string[]) => {
  let text = JSON.stringify(probe.json ? stable(probe.json) : probe.text);
  for (const id of ids) if (id) text = text.split(id).join('<id>');
  return text;
};

const leakIn = (probe: Probe, sent: Set<string>): string | null => {
  if (probe.text.includes(MARKER)) return `foreign marker in a ${probe.status} response`;
  for (const id of foreignIds) if (!sent.has(id) && probe.text.includes(id)) return `foreign id ${id} in a ${probe.status} response`;
  return null;
};

// Every id-looking field a body might carry, all pointing at the same foreign record kind.
const bodyFor = (ids: { proposal: string; response: string }) => ({
  proposalId: ids.proposal, resourceId: ids.proposal, responseId: ids.response, vendorResponseId: ids.response,
  submissionId: ids.response, ids: [ids.response], responseIds: [ids.response], proposalIds: [ids.proposal],
  purpose: 'proposal:view', content: 'isolation probe', message: 'isolation probe', title: 'isolation probe',
});

// One route, one actor: the foreign id and an id that does not exist must be indistinguishable,
// and nothing from organization B may appear in either answer.
const probeRoute = async (base: string, route: Route, actor: Actor, outer: 'foreign' | 'own'): Promise<Finding[]> => {
  const params = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
  const foreignPath: string[] = [];
  const missingPath: string[] = [];
  const segments = route.path.split('/');
  segments.forEach((segment, index) => {
    if (!segment.startsWith(':')) { foreignPath.push(segment); missingPath.push(segment); return; }
    const name = segment.slice(1);
    if (LITERAL_PARAMS[name]) { foreignPath.push(LITERAL_PARAMS[name]); missingPath.push(LITERAL_PARAMS[name]); return; }
    const parent = segments[index - 1];
    if (outer === 'own' && name === 'proposalId' && params.length > 1) { foreignPath.push(actor.proposalId); missingPath.push(actor.proposalId); return; }
    const foreign = foreignByParam.get(parent) ?? foreignByParam.get(`?${name}`) ?? randomMongoId();
    foreignPath.push(foreign);
    missingPath.push(lookalike(foreign));
  });
  const foreignIdsSent = [foreignByParam.get('proposals')!, foreignByParam.get('vendor-responses')!, ...foreignPath.filter((s) => foreignIds.has(s))];
  const missingProposal = randomMongoId();
  const missingResponse = randomMongoId();
  const query = `?proposalId=${foreignByParam.get('proposals')}&limit=50`;
  const missingQuery = `?proposalId=${missingProposal}&limit=50`;
  const hasBody = !['GET', 'DELETE'].includes(route.method) || route.path.endsWith('/vendor-responses/');
  const askForeign = () => clearRateLimits().then(() => request(base, actor.token, route.method, foreignPath.join('/') + query,
    hasBody ? bodyFor({ proposal: foreignByParam.get('proposals')!, response: foreignByParam.get('vendor-responses')! }) : undefined));
  const askMissing = () => clearRateLimits().then(() => request(base, actor.token, route.method, missingPath.join('/') + missingQuery,
    hasBody ? bodyFor({ proposal: missingProposal, response: missingResponse }) : undefined));
  let foreign = await askForeign();
  let missing = await askMissing();

  const label = `${route.method} ${route.path}${outer === 'own' ? ' (own proposal)' : ''}`;
  const ids = [...foreignIdsSent, ...missingPath, missingProposal, missingResponse];
  const out: Finding[] = [];
  const leak = leakIn(foreign, new Set(foreignIdsSent));
  if (leak) out.push({ route: label, role: actor.key, problem: leak });
  // A route that changes the caller's own state (deleting their settings) answers the second
  // call differently whatever the id; asking with the foreign id again separates that from a leak.
  if (foreign.status !== missing.status || (foreign.status >= 400 && shape(foreign, ids) !== shape(missing, ids))) {
    foreign = await askForeign();
    missing = await askMissing();
  }
  if (foreign.status !== missing.status) {
    out.push({ route: label, role: actor.key, problem: `foreign id answers ${foreign.status}, a missing id answers ${missing.status}` });
  } else if (foreign.status >= 400) {
    const [a, b] = [shape(foreign, ids), shape(missing, ids)];
    if (a !== b) out.push({ route: label, role: actor.key, problem: `error body differs: ${firstDifference(a, b)}` });
  }
  return out;
};

export const sweep = async (base: string, routes: Route[], actors: Actor[]) => {
  const out: Finding[] = [];
  for (const route of routes) {
    const nested = route.path.includes(':proposalId') && (route.path.match(/:\w+/g) ?? []).length > 1;
    for (const actor of actors) {
      out.push(...await probeRoute(base, route, actor, 'foreign'));
      if (nested) out.push(...await probeRoute(base, route, actor, 'own'));
    }
  }
  return out;
};

const firstDifference = (a: string, b: string) => {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return `…${a.slice(Math.max(0, at - 60), at + 60)} vs …${b.slice(Math.max(0, at - 60), at + 60)}`;
};

const isSwept = (route: Route) => !SKIPPED.some((pattern) => pattern.test(`${route.method} ${route.path}`));

// What each role of A sees on every parameterless read, with volatile fields removed.
const snapshotReads = async () => {
  const reads = listRoutes(app).filter((r) => r.method === 'GET' && !r.path.includes(':') && isSwept(r));
  const out = new Map<string, string>();
  for (const actor of actorsA) {
    for (const route of reads) {
      await clearRateLimits();
      const probe = await request(baseUrl, actor.token, 'GET', `${route.path}?limit=50`);
      out.set(`${actor.key} GET ${route.path}`, `${probe.status} ${shape(probe, [])}`);
    }
  }
  return out;
};

const member = async (organizationId: mongoose.Types.ObjectId, key: string, roles: string[]): Promise<Actor> => {
  const user = await User.create({ name: `${key} person`, email: `${key}-${randomMongoId().slice(0, 10)}@example.test`, password: 'not-a-real-hash', role: 'customer', organizationId });
  await OrganizationMembership.create({ organizationId, userId: user._id, roles, status: 'active', version: 1, activatedAt: new Date() });
  const session = await beginAuthenticatedSession({ userId: String(user._id), organizationId: String(organizationId), correlationId: randomMongoId() });
  const proposal = await Proposal.create({ organizationId, userId: user._id, event: { eventName: `Own proposal ${key}` } });
  return { key, token: session.accessToken, userId: String(user._id), proposalId: String(proposal._id) };
};

// Organization B creates its data the way a customer would, with the marker in every free-text
// field. Steps that a mock-only test stack cannot run are reported, not failed: the coverage
// line below shows which foreign ids the sweep actually used.
const seedForeignOrganization = async () => {
  ownerB = await member(orgB, 'ownerB', ['owner']);
  const call = (method: string, path: string, body?: unknown) => request(baseUrl, ownerB.token, method, path, body);
  const created = await call('POST', '/api/proposals', {
    event: { eventName: `${MARKER} gala`, eventFormat: 'in_person' },
    contact: { contactFirstName: MARKER, contactLastName: 'Planner', contactEmail: `${MARKER.toLowerCase()}@example.test`, contactPhone: '+1 555 0100' },
  });
  const proposalId = String((created.json?.data as any)?._id ?? ownerB.proposalId);
  await Proposal.updateOne({ _id: ownerB.proposalId }, { $set: { 'event.eventName': `${MARKER} second event` } });
  await VendorResponse.create({
    organizationId: orgB, proposalId, proposalOwnerId: ownerB.userId, proposalTitle: `${MARKER} gala`,
    vendorName: `${MARKER} Audio`, submittedBy: MARKER, email: `vendor-${MARKER.toLowerCase()}@example.test`, message: `${MARKER} quote`,
    emailTrackingId: `isolation-${randomMongoId()}`,
  });
  const steps: Array<[string, string, unknown?]> = [
    ['POST', `/api/v1/proposals/${proposalId}/notes`, { title: `${MARKER} notes`, text: `${MARKER} stage plot and rigging notes`, content: `${MARKER} stage plot` }],
    ['POST', '/api/public-access', { resourceId: proposalId, purpose: 'proposal:view' }],
    ['POST', `/api/v1/proposals/${proposalId}/conversation/messages`, { content: `${MARKER} conversation`, text: `${MARKER} conversation` }],
    ['POST', `/api/v1/proposals/${proposalId}/context-jobs`, {}],
    ['POST', `/api/v1/proposals/${proposalId}/guidance-reports`, {}],
    ['POST', `/api/v1/proposals/${proposalId}/draft-jobs`, {}],
    ['POST', `/api/v1/proposals/${proposalId}/room-recommendations`, {}],
    ['POST', `/api/v1/proposals/${proposalId}/investment-guidance-reports`, {}],
    ['POST', `/api/v1/proposals/${proposalId}/historical-insights`, {}],
    ['POST', `/api/v1/proposals/${proposalId}/intelligence/requirement-sets`, {}],
    ['POST', '/api/v1/assistant/threads', { title: `${MARKER} thread` }],
    ['POST', '/api/v1/support/tickets', { subject: `${MARKER} ticket`, body: `${MARKER} cannot open my proposal`, message: `${MARKER} cannot open my proposal`, category: 'other' }],
    ['POST', '/api/v1/knowledge/pricing-records', { category: 'audio', itemLabel: `${MARKER} line array`, unit: 'per_day', amountLowMinor: 1, amountMidMinor: 2, amountHighMinor: 3, currency: 'USD' }],
    ['POST', '/api/v1/knowledge/expert-rules', { title: `${MARKER} rule`, body: `${MARKER} rule`, category: 'audio' }],
    ['PUT', '/api/settings', { companyName: `${MARKER} Events`, emailSignature: MARKER }],
    ['POST', '/api/v1/teams', { name: `${MARKER} team` }],
    ['POST', '/api/v1/organization/invitations', { email: `invitee-${MARKER.toLowerCase()}@example.test`, role: 'planner' }],
    ['POST', '/api/organization/domains', { domain: `${MARKER.toLowerCase()}.example.com` }],
  ];
  const skipped: string[] = [];
  for (const [method, path, body] of steps) {
    await clearRateLimits();
    const res = await call(method, path, body);
    if (res.status >= 300) skipped.push(`${method} ${path.replace(proposalId, ':proposalId')} → ${res.status}`);
  }
  const threadId = (await admin.query<{ id: string }>(
    "SELECT t.id FROM rfpilot.assistant_threads t JOIN rfpilot.organizations o ON o.id = t.organization_id WHERE o.external_mongo_id = $1 LIMIT 1", [String(orgB)])).rows[0]?.id;
  if (threadId) {
    await clearRateLimits();
    await call('POST', `/api/v1/assistant/threads/${threadId}/messages`, { content: `${MARKER} assistant question` });
  }
  if (skipped.length) console.log(`# foreign seed steps unavailable on this stack: ${skipped.join('; ')}`);
};

// Every id organization B owns, from every Mongo collection and every Postgres tenant table.
const collectForeignIds = async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray()) {
    const docs = await db.collection(name).find({ organizationId: orgB }).toArray();
    for (const doc of docs) {
      foreignIds.add(String(doc._id));
      for (const [segment, source] of Object.entries(PARAM_SOURCES)) {
        if (source.mongo === name && !foreignByParam.has(segment)) foreignByParam.set(segment, String(source.field ? doc[source.field] : doc._id));
      }
    }
  }
  foreignIds.add(String(orgB));
  const pgOrg = (await admin.query<{ id: string }>('SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1', [String(orgB)])).rows[0]?.id;
  if (pgOrg) {
    foreignIds.add(pgOrg);
    const tables = (await admin.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped
         JOIN pg_attribute o ON o.attrelid = c.oid AND o.attname = 'organization_id' AND NOT o.attisdropped
        WHERE n.nspname = 'rfpilot' AND c.relkind = 'r'`)).rows.map((r) => r.name);
    for (const table of tables) {
      const rows = (await admin.query<{ id: string }>(`SELECT id::text AS id FROM rfpilot."${table}" WHERE organization_id = $1`, [pgOrg])).rows;
      for (const row of rows) foreignIds.add(row.id);
      for (const [segment, source] of Object.entries(PARAM_SOURCES)) {
        if (source.pg === table && rows[0] && !foreignByParam.has(segment)) foreignByParam.set(segment, rows[0].id);
      }
    }
  }
  // Short or generic values would match unrelated text; only real identifiers count as leaks.
  for (const id of foreignIds) if (id.length < 20) foreignIds.delete(id);
  foreignByParam.set('?proposalId', foreignByParam.get('proposals')!);
};

// A digest of everything organization B owns; a write that crossed tenants changes it.
const fingerprintForeign = async () => {
  const hash = crypto.createHash('sha256');
  const db = mongoose.connection.db!;
  for (const { name } of (await db.listCollections().toArray()).sort((x, y) => x.name.localeCompare(y.name))) {
    if (name === 'refreshsessions') continue;
    hash.update(name + JSON.stringify(await db.collection(name).find({ organizationId: orgB }).sort({ _id: 1 }).toArray()));
  }
  const pgOrg = (await admin.query<{ id: string }>('SELECT id FROM rfpilot.organizations WHERE external_mongo_id = $1', [String(orgB)])).rows[0]?.id;
  if (pgOrg) {
    const tables = (await admin.query<{ name: string }>(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' WHERE n.nspname = 'rfpilot' AND c.relkind = 'r' ORDER BY 1")).rows;
    for (const { name } of tables) {
      const row = (await admin.query<{ digest: string }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM rfpilot."${name}" t WHERE organization_id = $1`, [pgOrg])).rows[0];
      hash.update(name + row.digest);
    }
  }
  return hash.digest('hex');
};

before(async () => {
  admin = new Pool({ connectionString: TEST_POSTGRES_URL, max: 2 });
  ensureMigrated();
  await ensureAppRole(admin);
  process.env.POSTGRES_URL = TEST_APP_ROLE_URL;
  assert.equal((await postgresPool().query('SELECT current_user AS role')).rows[0].role, 'rfpilot_app');
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  orgA = (await Organization.create({ name: 'Isolation A', slug: `intg-iso-a-${randomMongoId().slice(0, 10)}`, status: 'active' }))._id as mongoose.Types.ObjectId;
  orgB = (await Organization.create({ name: `${MARKER} Org`, slug: `intg-iso-b-${randomMongoId().slice(0, 10)}`, status: 'active' }))._id as mongoose.Types.ObjectId;
  for (const role of ROLES) actorsA.push(await member(orgA, role, [role]));

  // The first read of some resources creates the caller's defaults (settings); read twice.
  await snapshotReads();
  baseline = await snapshotReads();
  await seedForeignOrganization();
  await collectForeignIds();
  foreignFingerprint = await fingerprintForeign();
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db!;
    for (const { name } of await db.listCollections().toArray()) {
      if (name === 'securityauditevents') continue;
      await db.collection(name).deleteMany({ organizationId: { $in: [orgA, orgB] } });
    }
    await Organization.deleteMany({ _id: { $in: [orgA, orgB] } });
  }
  await redis?.quit();
  await admin?.end();
  await disconnectMongo();
  await closePostgres();
  await closeSecurityRateLimitRedis();
  await closeSupportRedis();
  await closeQueue();
  await assistantOperationalLimiter.close?.();
});

test('the API is healthy when it logs in as the app role', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200, await health.text());
});

test('organization B has data the sweep can aim at', () => {
  for (const required of ['proposals', 'vendor-responses']) assert.ok(foreignByParam.get(required), `no foreign ${required} id`);
  const covered = Object.keys(PARAM_SOURCES).filter((segment) => foreignByParam.has(segment));
  console.log(`# ${foreignIds.size} foreign ids; real foreign ids for: ${covered.join(', ')}`);
});

test('foreign data changes no list, count or total that organization A reads', async () => {
  const now = await snapshotReads();
  const changed = [...baseline.keys()].filter((key) => baseline.get(key) !== now.get(key));
  assert.deepEqual(changed.map((key) => `${key}: ${firstDifference(baseline.get(key)!, now.get(key) ?? '')}`), []);
});

test('every route, as every role, treats foreign ids as missing and returns no foreign data', async () => {
  const routes = listRoutes(app).filter(isSwept);
  assert.ok(routes.length > 200, `found ${routes.length} routes`);
  probedRoutes = routes.length;
  findings = await sweep(baseUrl, routes, actorsA);
  console.log(`# swept ${probedRoutes} routes × ${actorsA.length} roles`);
  assert.deepEqual(findings, []);
});

test('nothing organization B owns changed during the sweep', async () => {
  assert.equal(await fingerprintForeign(), foreignFingerprint);
});

test('the sweep fails on a deliberately unscoped route', async () => {
  const canary = express();
  canary.use(express.json());
  const router = express.Router();
  router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
    const proposal = await Proposal.findById(req.params.id).lean();
    if (!proposal) return res.status(404).json({ success: false, message: 'Proposal not found' });
    return res.json({ success: true, data: proposal });
  });
  router.patch('/:id/favorite', authenticate, async (req: AuthRequest, res: Response) => {
    const updated = await Proposal.updateOne({ _id: req.params.id }, { $set: { isFavorite: true } });
    return res.status(updated.matchedCount ? 200 : 404).json({ success: updated.matchedCount > 0 });
  });
  canary.use('/api/proposals', router);
  const canaryServer = http.createServer(canary).listen(0);
  try {
    const canaryBase = `http://127.0.0.1:${(canaryServer.address() as AddressInfo).port}`;
    const caught = await sweep(canaryBase, listRoutes(canary), actorsA.slice(0, 1));
    assert.ok(caught.some((f) => f.route === 'GET /api/proposals/:id' && /foreign marker/.test(f.problem)), JSON.stringify(caught));
    assert.ok(caught.some((f) => f.route === 'PATCH /api/proposals/:id/favorite' && /answers 200, a missing id answers 404/.test(f.problem)), JSON.stringify(caught));
  } finally {
    canaryServer.closeAllConnections();
    canaryServer.close();
    await Proposal.updateOne({ _id: foreignByParam.get('proposals') }, { $unset: { isFavorite: '' } });
  }
});
