const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDomain, isPublicMailDomain, allowedVerificationMethods, txtRecordValue } = require("../src/modules/domainVerification/domain/domainRules");
const { createDomainVerification, RECHECK_VERIFIED_MS } = require("../src/modules/domainVerification/application/manageDomains");

const DAY = 24 * 60 * 60 * 1000;

// In-memory repository with the same verified-uniqueness rule as the Mongo partial index,
// and a mocked TXT resolver whose answers each test sets.
const setup = (options = {}) => {
  let clock = new Date("2026-11-02T12:00:00Z");
  let seq = 0;
  const rows = new Map();
  const mirror = new Map();
  const audits = [];
  const dns = new Map();
  const lookups = [];
  const domains = {
    async list(org) { return [...rows.values()].filter((r) => r.organizationId === org).map((r) => ({ ...r })); },
    async findById(org, id) { const r = rows.get(id); return r && r.organizationId === org ? { ...r } : null; },
    async countForOrganization(org) { return [...rows.values()].filter((r) => r.organizationId === org).length; },
    async isVerifiedElsewhere(domain, org) { return [...rows.values()].some((r) => r.domain === domain && r.status === "verified" && r.organizationId !== org); },
    async create(input) {
      if ([...rows.values()].some((r) => r.organizationId === input.organizationId && r.domain === input.domain)) return "duplicate";
      const record = { id: `d${++seq}`, ...input, status: "pending", method: null, verifiedByUserId: null, verifiedAt: null, lastCheckedAt: null, lastCheckOutcome: null, createdAt: clock };
      rows.set(record.id, record);
      return { ...record };
    },
    async markVerified(input) {
      const r = rows.get(input.id);
      if ([...rows.values()].some((o) => o.id !== r.id && o.domain === r.domain && o.status === "verified")) return "claimed";
      Object.assign(r, { status: "verified", method: input.method, verifiedByUserId: input.verifiedByUserId, verifiedAt: input.now, lastCheckedAt: input.now, nextCheckAt: input.nextCheckAt, lastCheckOutcome: input.outcome });
      mirror.set(r.organizationId, new Set([...(mirror.get(r.organizationId) ?? []), r.domain]));
      return "verified";
    },
    async markUnverified(input) {
      const r = rows.get(input.id);
      Object.assign(r, { status: "unverified", lastCheckedAt: input.now, nextCheckAt: input.nextCheckAt, lastCheckOutcome: input.outcome });
      mirror.get(r.organizationId)?.delete(r.domain);
    },
    async recordCheck(input) { Object.assign(rows.get(input.id), { lastCheckedAt: input.now, nextCheckAt: input.nextCheckAt, lastCheckOutcome: input.outcome }); },
    async remove(org, id) {
      const r = rows.get(id);
      if (!r || r.organizationId !== org) return null;
      rows.delete(id);
      mirror.get(org)?.delete(r.domain);
      return r;
    },
    async due(now, limit) { return [...rows.values()].filter((r) => r.nextCheckAt <= now).sort((a, b) => a.nextCheckAt - b.nextCheckAt).slice(0, limit).map((r) => ({ ...r })); },
  };
  let adminEmail = options.adminEmail ?? false;
  let qualifies = true;
  const service = createDomainVerification({
    domains,
    resolver: { async resolve(domain) { lookups.push(domain); return dns.get(domain) ?? { kind: "none" }; } },
    adminEmails: { async qualifies() { return qualifies; } },
    audit: { async append(event) { audits.push(event); } },
    methods: () => ({ dnsTxt: true, adminEmail }),
    now: () => clock,
    token: () => `token${seq + 1}`,
  });
  return {
    service, rows, mirror, audits, dns, lookups,
    tick: (ms) => { clock = new Date(clock.getTime() + ms); },
    publish: (domain, token) => dns.set(domain, { kind: "records", values: ["v=spf1 -all", txtRecordValue(token)] }),
    setQualifies: (v) => { qualifies = v; },
  };
};
const add = (ctx, domain, org = "o1", actorEmail = "admin@elsewhere.example") =>
  ctx.service.add({ organizationId: org, actorUserId: "admin", actorEmail, domain, correlationId: "c" });

test("domains are normalised from what an Admin might type", () => {
  assert.equal(normalizeDomain(" Acme.COM "), "acme.com");
  assert.equal(normalizeDomain("https://www.acme.com/about"), "acme.com");
  assert.equal(normalizeDomain("jane@events.acme.co.uk"), "events.acme.co.uk");
  assert.equal(normalizeDomain("acme.com."), "acme.com");
  for (const bad of ["", "localhost", "acme", "-acme.com", "acme..com", "a b.com", 42, null]) assert.equal(normalizeDomain(bad), null, String(bad));
});

test("public mail domains, their country variants and subdomains are never verifiable", () => {
  for (const domain of ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "yahoo.co.uk", "hotmail.fr", "outlook.com.au", "live.co.uk", "mail.gmail.com"]) {
    assert.equal(isPublicMailDomain(domain, []), true, domain);
  }
  for (const domain of ["acme.com", "dxg.events", "gmail-events.com", "notgmail.com", "outlookfarms.com"]) {
    assert.equal(isPublicMailDomain(domain, []), false, domain);
  }
  assert.equal(isPublicMailDomain("corpmail.example", ["corpmail.example"]), true);
});

test("Q7: DNS TXT is the only method unless admin_email is configured", () => {
  assert.deepEqual(allowedVerificationMethods(undefined), { dnsTxt: true, adminEmail: false });
  assert.deepEqual(allowedVerificationMethods("dns_txt"), { dnsTxt: true, adminEmail: false });
  assert.deepEqual(allowedVerificationMethods("dns_txt, admin_email"), { dnsTxt: true, adminEmail: true });
});

test("adding a domain returns a TXT token and stays pending until the job finds it", async () => {
  const ctx = setup();
  const added = await add(ctx, "Acme.com");
  assert.equal(added.kind, "added");
  assert.equal(added.record.status, "pending");
  assert.equal(added.record.verificationToken, "token1");
  assert.equal(ctx.lookups.length, 0, "verification happens in the background job, not the request");
  assert.ok(ctx.audits.some((a) => a.action === "organization.domain.added"));

  const first = await ctx.service.sweep();
  assert.deepEqual(first, { checked: 1, verified: 0, unverified: 0, pending: 1, failed: 0 });
  assert.equal(ctx.rows.get("d1").lastCheckOutcome, "txt_record_missing");
  assert.equal(ctx.rows.get("d1").nextCheckAt.getTime() - Date.parse("2026-11-02T12:00:00Z"), 15 * 60_000);

  ctx.publish("acme.com", "token1");
  assert.equal((await ctx.service.sweep()).checked, 0, "not due yet");
  ctx.tick(15 * 60_000);
  assert.equal((await ctx.service.sweep()).verified, 1);
  assert.equal(ctx.rows.get("d1").status, "verified");
  assert.equal(ctx.rows.get("d1").method, "dns_txt");
  assert.deepEqual([...ctx.mirror.get("o1")], ["acme.com"]);
  assert.ok(ctx.audits.some((a) => a.action === "organization.domain.verified"));
});

test("a verified domain is re-checked weekly, and removing the TXT record un-verifies it", async () => {
  const ctx = setup();
  await add(ctx, "acme.com");
  ctx.publish("acme.com", "token1");
  await ctx.service.sweep();
  assert.equal(ctx.rows.get("d1").status, "verified");

  ctx.tick(RECHECK_VERIFIED_MS - 60_000);
  assert.equal((await ctx.service.sweep()).checked, 0, "not before a week");
  ctx.tick(60_000);
  assert.equal((await ctx.service.sweep()).verified, 1, "still published: stays verified");

  ctx.dns.delete("acme.com");
  ctx.tick(RECHECK_VERIFIED_MS);
  assert.equal((await ctx.service.sweep()).unverified, 1);
  assert.equal(ctx.rows.get("d1").status, "unverified");
  assert.equal(ctx.mirror.get("o1").has("acme.com"), false);
  assert.ok(ctx.audits.some((a) => a.action === "organization.domain.unverified" && a.reason === "txt_record_missing"));

  // Publishing it again re-verifies on a later check.
  ctx.publish("acme.com", "token1");
  ctx.tick(DAY);
  assert.equal((await ctx.service.sweep()).verified, 1);
});

test("a TXT record with someone else's token doesn't verify", async () => {
  const ctx = setup();
  await add(ctx, "acme.com");
  ctx.publish("acme.com", "not-our-token");
  await ctx.service.sweep();
  assert.equal(ctx.rows.get("d1").status, "pending");
});

test("a DNS failure retries in an hour and never un-verifies", async () => {
  const ctx = setup();
  await add(ctx, "acme.com");
  ctx.publish("acme.com", "token1");
  await ctx.service.sweep();
  ctx.dns.set("acme.com", { kind: "error", code: "ESERVFAIL" });
  ctx.tick(RECHECK_VERIFIED_MS);
  await ctx.service.sweep();
  assert.equal(ctx.rows.get("d1").status, "verified");
  assert.equal(ctx.rows.get("d1").lastCheckOutcome, "dns_error:ESERVFAIL");
  assert.equal(ctx.rows.get("d1").nextCheckAt.getTime() - (Date.parse("2026-11-02T12:00:00Z") + RECHECK_VERIFIED_MS), 60 * 60_000);
});

test("public, invalid, duplicate and over-limit domains are refused", async () => {
  const ctx = setup();
  assert.equal((await add(ctx, "gmail.com")).kind, "not_verifiable");
  assert.equal((await add(ctx, "yahoo.co.uk")).kind, "not_verifiable");
  assert.equal((await add(ctx, "not a domain")).kind, "invalid");
  assert.equal((await add(ctx, "acme.com")).kind, "added");
  assert.equal((await add(ctx, "ACME.com")).kind, "already_added");
  for (let i = 0; i < 19; i++) await add(ctx, `acme${i}.com`);
  assert.equal((await add(ctx, "one-too-many.com")).kind, "limit");
});

test("only one organization can hold a domain verified", async () => {
  const ctx = setup();
  await add(ctx, "acme.com", "o1");
  await add(ctx, "acme.com", "o2");
  ctx.publish("acme.com", "token1");
  await ctx.service.sweep();
  assert.equal(ctx.rows.get("d1").status, "verified");
  assert.equal(ctx.rows.get("d2").status, "pending");
  ctx.publish("acme.com", "token2");
  ctx.tick(DAY);
  await ctx.service.sweep();
  assert.equal(ctx.rows.get("d2").status, "pending");
  assert.equal(ctx.rows.get("d2").lastCheckOutcome, "verified_by_another_organization");
  assert.equal((await add(ctx, "acme.com", "o3")).kind, "unavailable");
});

test("removing a domain drops it from the verified set and is audited", async () => {
  const ctx = setup();
  await add(ctx, "acme.com");
  ctx.publish("acme.com", "token1");
  await ctx.service.sweep();
  assert.equal((await ctx.service.remove({ organizationId: "o2", id: "d1", actorUserId: "x", correlationId: "c" })).kind, "not_found", "other organizations can't remove it");
  assert.equal((await ctx.service.remove({ organizationId: "o1", id: "d1", actorUserId: "admin", correlationId: "c" })).kind, "removed");
  assert.equal(ctx.mirror.get("o1").has("acme.com"), false);
  assert.ok(ctx.audits.some((a) => a.action === "organization.domain.removed" && a.metadata.wasVerified === true));
});

test("check now verifies immediately for the organization that owns the domain only", async () => {
  const ctx = setup();
  await add(ctx, "acme.com");
  ctx.publish("acme.com", "token1");
  assert.equal((await ctx.service.checkNow({ organizationId: "o2", id: "d1", actorUserId: "x", correlationId: "c" })).kind, "not_found");
  const checked = await ctx.service.checkNow({ organizationId: "o1", id: "d1", actorUserId: "admin", correlationId: "c" });
  assert.equal(checked.record.status, "verified");
});

test("Q7 admin_email, when configured: an Admin at the domain verifies it, re-checked against their membership", async () => {
  const off = setup();
  assert.equal((await add(off, "acme.com", "o1", "jane@acme.com")).record.status, "pending", "off by default");

  const ctx = setup({ adminEmail: true });
  assert.equal((await add(ctx, "other.com", "o1", "jane@acme.com")).record.status, "pending");
  const added = await add(ctx, "acme.com", "o1", "jane@acme.com");
  assert.equal(added.record.status, "verified");
  assert.equal(added.record.method, "admin_email");
  ctx.tick(RECHECK_VERIFIED_MS);
  await ctx.service.sweep();
  assert.equal(ctx.rows.get(added.record.id).status, "verified");
  ctx.setQualifies(false); // that Admin left; no TXT record either
  ctx.tick(RECHECK_VERIFIED_MS);
  await ctx.service.sweep();
  assert.equal(ctx.rows.get(added.record.id).status, "unverified");
});
