require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/modules/invitations/domain/invitationRules");
const { createInvitationService } = require("../src/modules/invitations/application/manageInvitations");
const { createInvitationDispatcher } = require("../src/modules/invitations/application/dispatchInvitations");

const ORG = "a".repeat(24);
const TEAM = "b".repeat(24);
const OTHER_TEAM = "c".repeat(24);
const admin = { organizationId: ORG, userId: "1".repeat(24), roles: ["organization_admin"], managedTeamIds: [] };
const manager = { organizationId: ORG, userId: "2".repeat(24), roles: ["team_manager"], managedTeamIds: [TEAM] };
const planner = { organizationId: ORG, userId: "3".repeat(24), roles: ["planner"], managedTeamIds: [] };

// ---------------------------------------------------------------------------
// Domain rules
// ---------------------------------------------------------------------------

test("only Owners, Admins and (when allowed) Team Managers may invite, within limits", () => {
  const on = { allowManagerInvites: true };
  const off = { allowManagerInvites: false };
  for (const role of rules.INVITABLE_ROLES) assert.equal(rules.inviteRefusal(admin, { role, teamId: null }, off), null);
  assert.equal(rules.inviteRefusal({ ...admin, roles: ["owner"] }, { role: "organization_admin", teamId: TEAM }, off), null);
  assert.equal(rules.inviteRefusal(planner, { role: "planner", teamId: null }, on), "INVITE_NOT_ALLOWED");
  assert.equal(rules.inviteRefusal({ ...planner, roles: ["viewer"] }, { role: "viewer", teamId: null }, on), "INVITE_NOT_ALLOWED");
  assert.equal(rules.inviteRefusal(manager, { role: "planner", teamId: TEAM }, off), "MANAGER_INVITES_DISABLED");
  assert.equal(rules.inviteRefusal(manager, { role: "planner", teamId: TEAM }, on), null);
  assert.equal(rules.inviteRefusal(manager, { role: "viewer", teamId: TEAM }, on), null);
  assert.equal(rules.inviteRefusal(manager, { role: "planner", teamId: OTHER_TEAM }, on), "TEAM_NOT_MANAGED");
  assert.equal(rules.inviteRefusal(manager, { role: "planner", teamId: null }, on), "TEAM_REQUIRED");
  assert.equal(rules.inviteRefusal(manager, { role: "team_manager", teamId: TEAM }, on), "ROLE_NOT_ALLOWED");
  assert.equal(rules.inviteRefusal(manager, { role: "organization_admin", teamId: TEAM }, on), "ROLE_NOT_ALLOWED");
  assert.equal(rules.isInvitableRole("owner"), false);
  assert.equal(rules.isInvitableRole("dxg_admin"), false);
});

test("a pasted list splits on commas, semicolons and new lines and keeps display-name entries", () => {
  assert.deepEqual(
    rules.parseEmailList('a@example.com, b@example.com;c@example.com\n"Dee Doe" <d@example.com>\r\n\n  ,not-an-email'),
    ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "not-an-email"],
  );
  assert.deepEqual(rules.parseEmailList([" a@example.com ", 7, ""]), ["a@example.com"]);
  assert.deepEqual(rules.parseEmailList(undefined), []);
});

test("email validation rejects malformed addresses", () => {
  for (const ok of ["a@example.com", "first.last+tag@sub.example.co.uk"]) assert.ok(rules.isValidEmail(ok), ok);
  for (const bad of ["", "a", "a@", "@example.com", "a@example", "a b@example.com", "a@exa mple.com", "a@-example.com", `${"x".repeat(250)}@example.com`]) {
    assert.ok(!rules.isValidEmail(bad), bad);
  }
});

test("tokens are 256-bit, url-safe and stored only as a SHA-256 hash", () => {
  const token = rules.generateInvitationToken();
  assert.ok(rules.looksLikeInvitationToken(token));
  assert.notEqual(rules.generateInvitationToken(), token);
  assert.match(rules.hashInvitationToken(token), /^[a-f0-9]{64}$/);
  assert.equal(rules.hashInvitationToken(token), rules.hashInvitationToken(token));
  assert.ok(!rules.looksLikeInvitationToken("short"));
  assert.ok(!rules.looksLikeInvitationToken({}));
});

test("expired, revoked, used and replaced links each get their own refusal", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const future = new Date("2026-11-05T00:00:00Z");
  const past = new Date("2026-11-01T00:00:00Z");
  assert.equal(rules.tokenRefusal(null, now), "INVITATION_INVALID");
  assert.equal(rules.tokenRefusal({ status: "pending", expiresAt: future, current: true }, now), null);
  assert.equal(rules.tokenRefusal({ status: "pending", expiresAt: future, current: false }, now), "INVITATION_SUPERSEDED");
  assert.equal(rules.tokenRefusal({ status: "pending", expiresAt: past, current: true }, now), "INVITATION_EXPIRED");
  assert.equal(rules.tokenRefusal({ status: "expired", expiresAt: future, current: true }, now), "INVITATION_EXPIRED");
  assert.equal(rules.tokenRefusal({ status: "revoked", expiresAt: future, current: false }, now), "INVITATION_REVOKED");
  assert.equal(rules.tokenRefusal({ status: "accepted", expiresAt: past, current: true }, now), "INVITATION_ALREADY_USED");
  const messages = Object.values(rules.TOKEN_REFUSAL_MESSAGES);
  assert.equal(new Set(messages).size, messages.length);
});

// ---------------------------------------------------------------------------
// Service with in-memory ports
// ---------------------------------------------------------------------------

const harness = (options = {}) => {
  let clock = new Date("2026-11-02T12:00:00Z");
  const rows = new Map();
  const audits = [];
  const emails = [];
  let nextId = 1;
  const id = () => String(nextId++).padStart(24, "0");
  const record = (row) => ({ ...row, delivery: { ...row.delivery } });
  const invitations = {
    async insertPending(input) {
      if ([...rows.values()].some((row) => row.status === "pending" && row.organizationId === input.organizationId && row.email === input.email)) return { kind: "duplicate" };
      const row = { ...input, id: id(), status: "pending", createdAt: clock, acceptedAt: null, revokedAt: null, tokenHash: null, previous: [], delivery: { state: "pending", kind: "invite", attempts: 0, sentAt: null } };
      rows.set(row.id, row);
      return { kind: "created", invitation: record(row) };
    },
    async findById(organizationId, rowId) { const row = rows.get(rowId); return row && row.organizationId === organizationId ? record(row) : null; },
    async list(organizationId) { return [...rows.values()].filter((row) => row.organizationId === organizationId).map(record); },
    async pendingEmails(organizationId, emailList, now) {
      return new Set([...rows.values()].filter((row) => row.organizationId === organizationId && row.status === "pending" && row.expiresAt > now && emailList.includes(row.email)).map((row) => row.email));
    },
    async findByTokenHash(hash) {
      for (const row of rows.values()) {
        if (row.tokenHash === hash) return { invitation: record(row), current: true };
        if (row.previous.includes(hash)) return { invitation: record(row), current: false };
      }
      return null;
    },
    async prepareResend(organizationId, rowId, input) {
      const row = rows.get(rowId);
      if (!row || !["pending", "expired"].includes(row.status)) return null;
      if (row.tokenHash) row.previous.push(row.tokenHash);
      Object.assign(row, { status: "pending", tokenHash: null, expiresAt: input.expiresAt, delivery: { state: "pending", kind: "resend", attempts: 0, sentAt: null } });
      return record(row);
    },
    async revoke(organizationId, rowId, input) {
      const row = rows.get(rowId);
      if (!row || row.status !== "pending") return null;
      Object.assign(row, { status: "revoked", revokedAt: input.now });
      return record(row);
    },
    async claimDelivery(rowId, input) {
      const row = rows.get(rowId);
      if (!row || row.status !== "pending" || !["pending", "failed"].includes(row.delivery.state) || row.delivery.attempts >= input.maxAttempts) return null;
      if (row.tokenHash) row.previous.push(row.tokenHash);
      row.tokenHash = input.tokenHash;
      row.delivery.state = "sending";
      row.delivery.attempts += 1;
      return record(row);
    },
    async completeDelivery(rowId, input) {
      const row = rows.get(rowId);
      if (row?.tokenHash === input.tokenHash && row.delivery.state === "sending") row.delivery.state = input.outcome;
    },
  };
  const standings = new Map(Object.entries(options.standings ?? {}));
  const accounts = new Map(Object.entries(options.accounts ?? {}));
  const joined = [];
  const organizations = {
    async find(orgId) { return orgId === ORG ? { id: ORG, name: "Acme Events", allowManagerInvites: options.allowManagerInvites ?? false, invitable: true } : null; },
    async userName() { return "Ada Admin"; },
  };
  const teams = { async findTeams(_org, ids) { return new Map(ids.filter((teamId) => teamId !== OTHER_TEAM || options.otherTeamExists).map((teamId) => [teamId, { id: teamId, name: "Team" }])); } };
  const mailer = { async send(email) { if (options.mailFails) throw new Error("smtp down"); emails.push(email); } };
  const dispatcher = createInvitationDispatcher({ invitations, organizations, teams, mailer, acceptUrl: (token) => `https://app.example.com/invite/${token}`, now: () => clock });
  const join = async (input, userId) => {
    const row = rows.get(input.invitationId);
    if (!row || row.tokenHash !== input.tokenHash || row.status !== "pending") return { kind: "stale" };
    row.status = "accepted";
    joined.push({ userId, organizationId: row.organizationId, role: row.role, teamId: row.teamId });
    return { kind: "joined", userId };
  };
  const service = createInvitationService({
    invitations,
    invitees: { async standings(_org, list) { return new Map(list.filter((email) => standings.has(email)).map((email) => [email, standings.get(email)])); } },
    organizations,
    teams,
    acceptance: {
      joinExistingAccount: (input) => join(input, input.userId),
      async joinNewAccount(input) { return join(input, "9".repeat(24)); },
    },
    credentials: {
      async findCredentials(email) { const account = accounts.get(email); return account ? { user: { id: account.id, name: "Existing", email }, passwordHash: `hash:${account.password}`, isBlocked: Boolean(account.blocked) } : null; },
      async emailExists(email) { return accounts.has(email); },
    },
    passwords: { async hash(value) { return `hash:${value}`; }, async verify(value, hash) { return hash === `hash:${value}`; } },
    dispatcher,
    audit: { async append(event) { audits.push(event); } },
    now: () => clock,
  });
  const lastToken = () => emails.at(-1).acceptUrl.split("/invite/")[1];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { service, rows, audits, emails, joined, standings, lastToken, settle, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
};

const standing = (overrides = {}) => ({ userId: "5".repeat(24), blocked: false, membershipHere: null, activeElsewhere: false, inLegacyHolding: false, ...overrides });

test("a single invite stores the role and team, emails a link, and audits the invite", async () => {
  const h = harness();
  const outcome = await h.service.create(admin, { email: " New.Planner@Example.com ", role: "planner", teamId: TEAM }, "corr-1");
  assert.equal(outcome.kind, "done");
  const [row] = outcome.rows;
  assert.equal(row.outcome, "invited");
  assert.equal(row.invitation.email, "new.planner@example.com");
  assert.equal(row.invitation.role, "planner");
  assert.equal(row.invitation.teamId, TEAM);
  assert.equal(row.invitation.status, "pending");
  assert.equal(row.invitation.emailDelivery, "sent");
  assert.equal(new Date(row.invitation.expiresAt).getTime() - new Date("2026-11-02T12:00:00Z").getTime(), rules.INVITATION_TTL_MS);
  assert.equal(h.emails.length, 1);
  assert.equal(h.emails[0].organizationName, "Acme Events");
  assert.equal(h.emails[0].inviterName, "Ada Admin");
  assert.ok(rules.looksLikeInvitationToken(h.lastToken()));
  const stored = h.rows.get(row.invitation.id);
  assert.equal(stored.tokenHash, rules.hashInvitationToken(h.lastToken()), "only the hash is stored");
  assert.deepEqual(h.audits.map((event) => [event.action, event.decision, event.targetId]), [["organization.invitation.sent", "created", row.invitation.id]]);
  assert.ok(!JSON.stringify(h.audits).includes(h.lastToken()));
});

test("bulk paste of 200 entries with duplicates and invalid emails is reported per row", async () => {
  const h = harness({
    standings: {
      "member@example.com": standing({ membershipHere: "active" }),
      "elsewhere@example.com": standing({ activeElsewhere: true }),
      "legacy@example.com": standing({ inLegacyHolding: true, activeElsewhere: true }),
      "deactivated@example.com": standing({ membershipHere: "suspended" }),
      "removed@example.com": standing({ membershipHere: "removed" }),
    },
  });
  await h.service.create(admin, { email: "open@example.com", role: "viewer" }, "corr");
  const entries = [];
  for (let i = 0; i < 170; i++) entries.push(`person${i}@example.com`);
  for (let i = 0; i < 15; i++) entries.push(`PERSON${i}@example.com`); // duplicates, different case
  for (let i = 0; i < 9; i++) entries.push(`not-an-email-${i}`);
  entries.push("member@example.com", "elsewhere@example.com", "legacy@example.com", "deactivated@example.com", "removed@example.com", "open@example.com");
  assert.equal(entries.length, 200);

  const outcome = await h.service.createBulk(admin, { emails: entries.join("\n"), role: "planner" }, "corr-bulk");
  assert.equal(outcome.kind, "done");
  assert.equal(outcome.rows.length, 200);
  assert.deepEqual(outcome.rows.map((row) => row.row), entries.map((_, index) => index + 1));
  const codes = (code) => outcome.rows.filter((row) => row.code === code).length;
  assert.equal(outcome.rows.filter((row) => row.outcome === "invited").length, 171); // 170 + removed@
  assert.equal(codes("DUPLICATE_IN_LIST"), 15);
  assert.equal(codes("INVALID_EMAIL"), 9);
  assert.equal(outcome.rows[194].code, "ALREADY_MEMBER");
  assert.equal(outcome.rows[195].code, "EMAIL_IN_ANOTHER_ORGANIZATION");
  assert.equal(outcome.rows[196].code, "LEGACY_ACCOUNT_PENDING_PLACEMENT");
  assert.equal(outcome.rows[197].code, "MEMBER_DEACTIVATED");
  assert.equal(outcome.rows[198].outcome, "invited");
  assert.equal(outcome.rows[199].code, "ALREADY_INVITED");
  for (const row of outcome.rows.filter((entry) => entry.outcome === "refused")) assert.ok(row.message.length > 10);

  // Bulk answers first and sends afterwards.
  await h.settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.emails.length, 1 + 171);
  assert.equal(h.audits.filter((event) => event.action === "organization.invitation.sent").length, 172);
});

test("bulk refuses an empty or oversized paste and a bad role before touching any row", async () => {
  const h = harness();
  assert.equal((await h.service.createBulk(admin, { emails: "", role: "planner" }, "c")).code, "NO_EMAILS");
  const many = Array.from({ length: rules.MAX_BULK_INVITATIONS + 1 }, (_, i) => `p${i}@example.com`);
  assert.equal((await h.service.createBulk(admin, { emails: many, role: "planner" }, "c")).code, "TOO_MANY_EMAILS");
  assert.equal((await h.service.createBulk(admin, { emails: "a@example.com", role: "owner" }, "c")).code, "INVALID_ROLE");
  assert.equal((await h.service.createBulk(admin, { emails: "a@example.com", role: "planner", teamId: "nope" }, "c")).code, "INVALID_TEAM");
  assert.equal(h.rows.size, 0);
});

test("Team Managers invite into their own teams only when the setting is on", async () => {
  const off = harness({ allowManagerInvites: false });
  assert.equal((await off.service.create(manager, { email: "x@example.com", role: "planner", teamId: TEAM }, "c")).code, "MANAGER_INVITES_DISABLED");

  const on = harness({ allowManagerInvites: true, otherTeamExists: true });
  assert.equal((await on.service.create(manager, { email: "x@example.com", role: "planner", teamId: TEAM }, "c")).rows[0].outcome, "invited");
  assert.equal((await on.service.create(manager, { email: "y@example.com", role: "planner", teamId: OTHER_TEAM }, "c")).code, "TEAM_NOT_MANAGED");
  assert.equal((await on.service.create(manager, { email: "y@example.com", role: "planner" }, "c")).code, "TEAM_REQUIRED");
  assert.equal((await on.service.create(manager, { email: "y@example.com", role: "organization_admin", teamId: TEAM }, "c")).code, "ROLE_NOT_ALLOWED");
  assert.equal((await on.service.create(planner, { email: "y@example.com", role: "planner" }, "c")).code, "INVITE_NOT_ALLOWED");

  // Managers see and manage only invitations into teams they manage.
  await on.service.create(admin, { email: "other-team@example.com", role: "planner", teamId: OTHER_TEAM }, "c");
  const visible = await on.service.list(manager, {});
  assert.deepEqual(visible.map((row) => row.email), ["x@example.com"]);
  const otherId = [...on.rows.values()].find((row) => row.teamId === OTHER_TEAM).id;
  assert.equal((await on.service.revoke(manager, otherId, "c")).kind, "not_found");
  assert.equal((await on.service.resend(manager, otherId, "c")).kind, "not_found");
});

test("an unknown team is refused", async () => {
  const h = harness();
  assert.equal((await h.service.create(admin, { email: "x@example.com", role: "planner", teamId: OTHER_TEAM }, "c")).code, "TEAM_NOT_FOUND");
});

test("resend rotates the link: the old one is dead, the new one works, the expiry restarts", async () => {
  const h = harness();
  const created = (await h.service.create(admin, { email: "r@example.com", role: "planner" }, "c")).rows[0].invitation;
  const first = h.lastToken();
  h.advance(3 * 24 * 60 * 60 * 1000);
  const resent = await h.service.resend(admin, created.id, "c2");
  assert.equal(resent.kind, "resent");
  assert.equal(resent.invitation.emailDelivery, "sent");
  assert.equal(h.emails.at(-1).kind, "resend");
  const second = h.lastToken();
  assert.notEqual(second, first);
  assert.equal((await h.service.lookup(first)).code, "INVITATION_SUPERSEDED");
  assert.equal((await h.service.lookup(second)).kind, "found");
  assert.equal(new Date(resent.invitation.expiresAt).getTime(), new Date("2026-11-05T12:00:00Z").getTime() + rules.INVITATION_TTL_MS);
  assert.ok(h.audits.some((event) => event.action === "organization.invitation.resent"));
});

test("a failed email is reported and left for the delivery sweep", async () => {
  const h = harness({ mailFails: true });
  const outcome = await h.service.create(admin, { email: "f@example.com", role: "planner" }, "c");
  assert.equal(outcome.rows[0].invitation.emailDelivery, "failed");
  assert.equal(h.rows.get(outcome.rows[0].invitation.id).delivery.state, "failed");
});

test("revoked, expired, used and garbage tokens are refused distinctly without leaking the invitation", async () => {
  const h = harness();
  const revokedId = (await h.service.create(admin, { email: "rv@example.com", role: "planner" }, "c")).rows[0].invitation.id;
  const revokedToken = h.lastToken();
  assert.equal((await h.service.revoke(admin, revokedId, "c")).kind, "revoked");
  assert.equal((await h.service.revoke(admin, revokedId, "c")).kind, "not_pending");
  assert.ok(h.audits.some((event) => event.action === "organization.invitation.revoked" && event.decision === "revoked"));

  await h.service.create(admin, { email: "used@example.com", role: "planner" }, "c");
  const usedToken = h.lastToken();
  assert.equal((await h.service.acceptWithNewAccount({ token: usedToken, name: "New Person", password: "long-enough-pw" }, "c")).kind, "accepted");

  await h.service.create(admin, { email: "late@example.com", role: "planner" }, "c");
  const lateToken = h.lastToken();
  h.advance(rules.INVITATION_TTL_MS + 1);

  const outcomes = {
    revoked: await h.service.lookup(revokedToken),
    used: await h.service.lookup(usedToken),
    expired: await h.service.lookup(lateToken),
    garbage: await h.service.lookup("x".repeat(43)),
    malformed: await h.service.lookup("not a token"),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(outcomes).map(([key, value]) => [key, value.code])), {
    revoked: "INVITATION_REVOKED",
    used: "INVITATION_ALREADY_USED",
    expired: "INVITATION_EXPIRED",
    garbage: "INVITATION_INVALID",
    malformed: "INVITATION_INVALID",
  });
  for (const value of Object.values(outcomes)) assert.deepEqual(Object.keys(value).sort(), ["code", "kind"]);
  // Accept gets the same answers as lookup.
  assert.equal((await h.service.acceptWithNewAccount({ token: usedToken, name: "Again", password: "long-enough-pw" }, "c")).code, "INVITATION_ALREADY_USED");
  assert.equal((await h.service.acceptWithExistingAccount({ token: revokedToken, email: "rv@example.com", password: "x" }, "c")).code, "INVITATION_REVOKED");
});

test("lookup shows the accept page what it needs for a live link", async () => {
  const h = harness({ accounts: { "has-account@example.com": { id: "6".repeat(24), password: "pw" } } });
  await h.service.create(admin, { email: "has-account@example.com", role: "viewer", teamId: TEAM }, "c");
  const found = await h.service.lookup(h.lastToken());
  assert.equal(found.kind, "found");
  assert.deepEqual(
    { ...found.invitation, expiresAt: undefined },
    { email: "has-account@example.com", role: "viewer", organizationName: "Acme Events", inviterName: "Ada Admin", teamName: "Team", expiresAt: undefined, accountExists: true },
  );
});

test("accept requires the signed-in email to equal the invited one; role and team come from the invitation", async () => {
  const h = harness({
    accounts: { "invitee@example.com": { id: "7".repeat(24), password: "right-password" }, "someone@example.com": { id: "8".repeat(24), password: "pw" } },
    standings: { "invitee@example.com": standing({ userId: "7".repeat(24), membershipHere: "removed" }) },
  });
  await h.service.create(admin, { email: "invitee@example.com", role: "viewer", teamId: TEAM }, "c");
  const token = h.lastToken();
  assert.equal((await h.service.acceptWithExistingAccount({ token, email: "someone@example.com", password: "pw" }, "c")).kind, "email_mismatch");
  assert.equal((await h.service.acceptWithExistingAccount({ token, email: "invitee@example.com", password: "wrong" }, "c")).kind, "wrong_password");
  assert.equal((await h.service.acceptWithExistingAccount({ token }, "c")).kind, "validation");
  const accepted = await h.service.acceptWithExistingAccount(
    { token, email: "INVITEE@example.com", password: "right-password", role: "organization_admin", organizationId: "f".repeat(24), teamId: OTHER_TEAM },
    "c-accept",
  );
  assert.equal(accepted.kind, "accepted");
  assert.deepEqual(h.joined, [{ userId: "7".repeat(24), organizationId: ORG, role: "viewer", teamId: TEAM }]);
  assert.equal(accepted.role, "viewer");
  const audit = h.audits.find((event) => event.action === "organization.invitation.accepted");
  assert.equal(audit.actorUserId, "7".repeat(24));
  assert.equal(audit.organizationId, ORG);
  assert.equal(audit.decision, "allowed");
});

test("accept is refused for an account in another organization, a holding tenant, or a blocked account", async () => {
  const h = harness({
    accounts: {
      "busy@example.com": { id: "1".repeat(24), password: "pw" },
      "legacy@example.com": { id: "2".repeat(24), password: "pw" },
      "blocked@example.com": { id: "3".repeat(24), password: "pw", blocked: true },
    },
  });
  const tokens = {};
  for (const email of ["busy@example.com", "legacy@example.com", "blocked@example.com"]) {
    await h.service.create(admin, { email, role: "planner" }, "c");
    tokens[email] = h.lastToken();
  }
  // Their standing changed after the invitation went out.
  h.standings.set("busy@example.com", standing({ activeElsewhere: true }));
  h.standings.set("legacy@example.com", standing({ inLegacyHolding: true }));
  const accept = (email) => h.service.acceptWithExistingAccount({ token: tokens[email], email, password: "pw" }, "c");
  assert.equal((await accept("busy@example.com")).code, "EMAIL_IN_ANOTHER_ORGANIZATION");
  assert.equal((await accept("legacy@example.com")).code, "LEGACY_ACCOUNT_PENDING_PLACEMENT");
  assert.equal((await accept("blocked@example.com")).kind, "blocked");
  assert.deepEqual(h.joined, []);
  assert.ok(!h.audits.some((event) => event.action === "organization.invitation.accepted"));
});

test("a new account is created only when the email has none, and the password must be strong enough", async () => {
  const h = harness({ accounts: { "exists@example.com": { id: "4".repeat(24), password: "pw" } } });
  await h.service.create(admin, { email: "exists@example.com", role: "planner" }, "c");
  assert.equal((await h.service.acceptWithNewAccount({ token: h.lastToken(), name: "Dup", password: "long-enough-pw" }, "c")).kind, "account_exists");
  await h.service.create(admin, { email: "fresh@example.com", role: "planner" }, "c");
  const token = h.lastToken();
  assert.equal((await h.service.acceptWithNewAccount({ token, name: "Fresh", password: "short" }, "c")).code, "WEAK_PASSWORD");
  assert.equal((await h.service.acceptWithNewAccount({ token, name: " ", password: "long-enough-pw" }, "c")).code, "INVALID_INPUT");
  const accepted = await h.service.acceptWithNewAccount({ token, name: "Fresh", password: "long-enough-pw" }, "c");
  assert.equal(accepted.kind, "accepted");
  assert.equal(h.audits.find((event) => event.action === "organization.invitation.accepted").reason, "new_account");
});

test("expired invitations list as expired and can be resent", async () => {
  const h = harness();
  const created = (await h.service.create(admin, { email: "old@example.com", role: "planner" }, "c")).rows[0].invitation;
  h.advance(rules.INVITATION_TTL_MS + 1);
  assert.deepEqual((await h.service.list(admin, { status: "expired" })).map((row) => row.id), [created.id]);
  assert.deepEqual(await h.service.list(admin, { status: "pending" }), []);
  assert.equal((await h.service.resend(admin, created.id, "c")).kind, "resent");
  assert.equal((await h.service.lookup(h.lastToken())).kind, "found");
});
