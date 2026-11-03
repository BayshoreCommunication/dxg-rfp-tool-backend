// ORG-305: an Admin adds a domain and gets a DNS TXT token; the background job verifies it,
// re-checks weekly, and un-verifies it when the record is removed. Routes go through the real
// app; the job runs against the real Mongo repository with a mocked TXT resolver.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, ensureMigrated, ensureServices, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../server';
import Organization from '../modal/organizationModel';
import OrganizationDomain from '../modal/organizationDomainModel';
import OrganizationMembership from '../modal/organizationMembershipModel';
import RefreshSession from '../modal/refreshSessionModel';
import SecurityAuditEvent from '../modal/securityAuditEventModel';
import User from '../modal/userModel';
import { beginAuthenticatedSession } from '../src/modules/auth/composition';
import { createDomainVerification, RECHECK_VERIFIED_MS, type TxtLookup } from '../src/modules/domainVerification/application/manageDomains';
import { txtRecordValue } from '../src/modules/domainVerification/domain/domainRules';
import { mongoDomainRepository } from '../src/modules/domainVerification/infrastructure/mongo/mongoDomainRepository';
import { mongoSecurityAuditWriter } from '../src/modules/auth/infrastructure/audit/mongoSecurityAuditWriter';
import { closePostgres } from '../config/postgres';
import { closeSecurityRateLimitRedis } from '../middleware/securityRateLimit';

let server: http.Server;
let baseUrl: string;
const tag = randomMongoId().slice(0, 10);
const domain = (name: string) => `${name}-${tag}.example.com`;

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

const member = async (organizationId: string, who: string, role: string) => {
  const user = await User.create({ name: who, email: `domains-${who}-${tag}@example.com`, password: 'not-used-here', role: 'customer', organizationId });
  await OrganizationMembership.create({ organizationId, userId: user._id, roles: [role], status: 'active' });
  return (await beginAuthenticatedSession({ userId: String(user._id), organizationId, correlationId: randomMongoId() })).accessToken;
};

// The background job with a mocked resolver and a controllable clock.
const dns = new Map<string, TxtLookup>();
let clock = new Date();
const job = createDomainVerification({
  domains: mongoDomainRepository,
  resolver: { resolve: async (name) => dns.get(name) ?? { kind: 'none' } },
  adminEmails: { qualifies: async () => false },
  audit: mongoSecurityAuditWriter,
  methods: () => ({ dnsTxt: true, adminEmail: false }),
  now: () => clock,
});
// Other sessions' rows may be due too; only look at ours.
const sweepOurs = async () => { await job.sweep({ limit: 1000 }); };

let orgA: string;
let orgB: string;
let adminA: string;
let plannerA: string;
let adminB: string;

before(async () => {
  await ensureServices();
  ensureMigrated();
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Promise.all([User.init(), Organization.init(), OrganizationMembership.init(), OrganizationDomain.init()]);
  server = http.createServer(app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  orgA = String((await Organization.create({ name: 'Domains A', slug: `intg-domains-a-${tag}` }))._id);
  orgB = String((await Organization.create({ name: 'Domains B', slug: `intg-domains-b-${tag}` }))._id);
  adminA = await member(orgA, 'admin-a', 'organization_admin');
  plannerA = await member(orgA, 'planner-a', 'planner');
  adminB = await member(orgB, 'admin-b', 'owner');
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  if (mongoose.connection.readyState === 1) {
    const ids = [orgA, orgB].filter(Boolean);
    await Promise.all([
      OrganizationDomain.deleteMany({ organizationId: { $in: ids } }),
      RefreshSession.deleteMany({ organizationId: { $in: ids } }),
      OrganizationMembership.deleteMany({ organizationId: { $in: ids } }),
      User.deleteMany({ organizationId: { $in: ids } }),
      Organization.deleteMany({ _id: { $in: ids } }),
    ]);
  }
  await closeSecurityRateLimitRedis();
  await disconnectMongo();
  await closePostgres();
});

test('only Owner and Admin manage domains; public mail domains are refused', async () => {
  assert.equal((await call('GET', '/api/organization/domains', plannerA)).status, 403);
  assert.equal((await call('POST', '/api/organization/domains', plannerA, { domain: domain('planner') })).status, 403);
  for (const publicDomain of ['gmail.com', 'outlook.com', 'yahoo.co.uk']) {
    const refused = await call('POST', '/api/organization/domains', adminA, { domain: publicDomain });
    assert.equal(refused.status, 422, publicDomain);
    assert.equal(refused.body.code, 'DOMAIN_NOT_VERIFIABLE');
  }
  assert.equal((await call('POST', '/api/organization/domains', adminA, { domain: 'not a domain' })).status, 400);
});

test('adding returns the TXT record; the job verifies, re-checks weekly, and un-verifies when the record goes', async () => {
  const name = domain('acme');
  const added = await call('POST', '/api/organization/domains', adminA, { domain: `https://www.${name.toUpperCase()}/` });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.domain.domain, name);
  assert.equal(added.body.domain.status, 'pending');
  const record = added.body.domain.verification;
  assert.equal(record.type, 'TXT');
  assert.equal(record.name, name);
  assert.match(record.value, /^rfpilot-domain-verification=[0-9a-f]{32}$/);
  assert.equal((await call('POST', '/api/organization/domains', adminA, { domain: name })).body.code, 'DOMAIN_ALREADY_ADDED');
  const id = added.body.domain.id;

  clock = new Date();
  await sweepOurs();
  assert.equal((await OrganizationDomain.findById(id).lean())?.status, 'pending');

  dns.set(name, { kind: 'records', values: ['v=spf1 -all', record.value] });
  clock = new Date(clock.getTime() + 15 * 60_000);
  await sweepOurs();
  const verified = await call('GET', '/api/organization/domains', adminA);
  const row = verified.body.domains.find((d: any) => d.id === id);
  assert.equal(row.status, 'verified');
  assert.equal(row.method, 'dns_txt');
  assert.equal(new Date(row.nextCheckAt).getTime() - clock.getTime(), RECHECK_VERIFIED_MS);
  assert.deepEqual((await Organization.findById(orgA).lean())?.verifiedDomains, [name]);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: orgA, action: 'organization.domain.verified', targetId: id }));

  // Weekly re-check with the record still there: stays verified.
  clock = new Date(clock.getTime() + RECHECK_VERIFIED_MS);
  await sweepOurs();
  assert.equal((await OrganizationDomain.findById(id).lean())?.status, 'verified');

  // The record is removed: the next re-check un-verifies.
  dns.delete(name);
  clock = new Date(clock.getTime() + RECHECK_VERIFIED_MS);
  await sweepOurs();
  assert.equal((await OrganizationDomain.findById(id).lean())?.status, 'unverified');
  assert.deepEqual((await Organization.findById(orgA).lean())?.verifiedDomains, []);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: orgA, action: 'organization.domain.unverified', targetId: id }));
});

test('a domain verified by one organization cannot be verified or added by another', async () => {
  const name = domain('shared');
  const a = await call('POST', '/api/organization/domains', adminA, { domain: name });
  const b = await call('POST', '/api/organization/domains', adminB, { domain: name });
  assert.equal(b.status, 201);
  dns.set(name, { kind: 'records', values: [a.body.domain.verification.value, b.body.domain.verification.value] });
  clock = new Date(Date.now() + 365 * 24 * 60 * 60_000);
  await sweepOurs();
  const statuses = (await OrganizationDomain.find({ domain: name }).lean()).map((r) => r.status).sort();
  assert.deepEqual(statuses, ['pending', 'verified'], 'the partial unique index lets only one win');
  const winner = (await OrganizationDomain.findOne({ domain: name, status: 'verified' }).lean())!;
  const loserToken = String(winner.organizationId) === orgA ? adminB : adminA;
  await OrganizationDomain.deleteOne({ domain: name, status: 'pending' });
  const refused = await call('POST', '/api/organization/domains', loserToken, { domain: name });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'DOMAIN_UNAVAILABLE');
  assert.equal(txtRecordValue('x'), 'rfpilot-domain-verification=x');
});

test("another organization's domain is invisible; removing drops it from the verified set", async () => {
  const name = domain('remove');
  const added = await call('POST', '/api/organization/domains', adminA, { domain: name });
  const id = added.body.domain.id;
  assert.equal((await call('GET', '/api/organization/domains', adminB)).body.domains.some((d: any) => d.id === id), false);
  assert.equal((await call('POST', `/api/organization/domains/${id}/check`, adminB)).status, 404);
  assert.equal((await call('DELETE', `/api/organization/domains/${id}`, adminB)).status, 404);

  dns.set(name, { kind: 'records', values: [added.body.domain.verification.value] });
  clock = new Date(Date.now() + 2 * 365 * 24 * 60 * 60_000);
  await sweepOurs();
  assert.ok((await Organization.findById(orgA).lean())?.verifiedDomains.includes(name));
  assert.equal((await call('DELETE', `/api/organization/domains/${id}`, adminA)).status, 200);
  assert.equal(await OrganizationDomain.countDocuments({ _id: id }), 0);
  assert.equal((await Organization.findById(orgA).lean())?.verifiedDomains.includes(name), false);
  assert.ok(await SecurityAuditEvent.exists({ organizationId: orgA, action: 'organization.domain.removed', targetId: id }));
});
