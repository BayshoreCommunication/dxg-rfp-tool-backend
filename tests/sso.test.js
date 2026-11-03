const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  connectionDomains,
  microsoftIssuerFor,
  MICROSOFT_CONSUMER_TENANT,
  parseIssuer,
  personFromCompanyClaims,
  personFromMicrosoftClaims,
} = require("../src/modules/sso/domain/ssoRules");
const { createFederatedSignIn, bindHashFor } = require("../src/modules/sso/application/federatedSignIn");
const { createMemorySsoStateStore } = require("../src/modules/sso/infrastructure/ssoStateStore");
const { decideSecondFactor } = require("../src/modules/twoFactor/domain/secondFactorPolicy");

const TENANT = "11111111-2222-3333-4444-555555555555";
const ISSUER = "https://idp.acme.example";
const metadata = (issuer) => ({
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
});

/* ---------- rules ---------- */

test("Microsoft claims: verified work email becomes tid:oid identity", () => {
  const person = personFromMicrosoftClaims({
    iss: microsoftIssuerFor(TENANT), sub: "s", tid: TENANT, oid: "o1", email: " Pat@Acme.Example ", xms_edov: true, name: "Pat",
  });
  assert.equal(person.email, "pat@acme.example");
  assert.equal(person.subject, `${TENANT}:o1`);
  assert.equal(person.provider, "microsoft");
});

test("Microsoft claims: unverified tenant email is refused (nOAuth), consumer tenant is trusted", () => {
  assert.deepEqual(
    personFromMicrosoftClaims({ iss: "x", sub: "s", tid: TENANT, oid: "o", email: "ceo@victim.example" }),
    { refusal: "MICROSOFT_EMAIL_UNVERIFIED" },
  );
  assert.equal(personFromMicrosoftClaims({ iss: "x", sub: "s", tid: MICROSOFT_CONSUMER_TENANT, oid: "o", email: "a@outlook.com" }).email, "a@outlook.com");
  assert.deepEqual(personFromMicrosoftClaims({ iss: "x", sub: "s", tid: TENANT, xms_edov: true }), { refusal: "EMAIL_MISSING" });
});

test("Microsoft issuer is derived only from a well-formed tenant id", () => {
  assert.equal(microsoftIssuerFor(TENANT), `https://login.microsoftonline.com/${TENANT}/v2.0`);
  assert.equal(microsoftIssuerFor("common"), null);
  assert.equal(microsoftIssuerFor(undefined), null);
});

test("company claims: email fallbacks and email_verified=false refusal", () => {
  assert.equal(personFromCompanyClaims({ iss: ISSUER, sub: "1", preferred_username: "A@Acme.Example" }).email, "a@acme.example");
  assert.deepEqual(personFromCompanyClaims({ iss: ISSUER, sub: "1", email: "a@acme.example", email_verified: false }), { refusal: "COMPANY_EMAIL_UNVERIFIED" });
  assert.deepEqual(personFromCompanyClaims({ iss: ISSUER, sub: "1" }), { refusal: "EMAIL_MISSING" });
});

test("issuer must be https, http allowed only for localhost when permitted", () => {
  assert.equal(parseIssuer("https://idp.acme.example/oauth2/default", false), "https://idp.acme.example/oauth2/default");
  assert.equal(parseIssuer("http://idp.acme.example", true), null);
  assert.equal(parseIssuer("http://localhost:8080/default", true), "http://localhost:8080/default");
  assert.equal(parseIssuer("http://localhost:8080/default", false), null);
  assert.equal(parseIssuer("https://u:p@idp.acme.example", false), null);
  assert.equal(parseIssuer("https://idp.acme.example?x=1", false), null);
  assert.equal(parseIssuer("not a url", false), null);
});

test("connection domains must all be verified by the organization", () => {
  assert.deepEqual(connectionDomains([" Acme.Example ", "acme.example"], ["acme.example"]), { domains: ["acme.example"] });
  assert.deepEqual(connectionDomains(["acme.example", "evil.example"], ["acme.example"]), { unverified: ["evil.example"] });
  assert.equal(connectionDomains([], ["acme.example"]), null);
});

test("company SSO never prompts for our 2FA; Microsoft/Google follow the SSO policy", () => {
  const base = { enrolled: true, organizationRequiresTwoFactor: true, ssoPolicy: "challenge" };
  assert.equal(decideSecondFactor({ ...base, method: "company_sso" }), "none");
  assert.equal(decideSecondFactor({ ...base, method: "sso" }), "challenge");
  assert.equal(decideSecondFactor({ ...base, method: "sso", ssoPolicy: "trust_sso" }), "none");
  assert.equal(decideSecondFactor({ ...base, method: "password" }), "challenge");
});

/* ---------- federated sign-in ---------- */

const BIND = "browser-bind-cookie-value-0123456789";
const BIND_HASH = crypto.createHash("sha256").update(BIND).digest("hex");

const harness = (overrides = {}) => {
  const connection = {
    id: "conn1", organizationId: "org1", issuer: ISSUER, clientId: "client", clientSecret: "secret", domains: ["acme.example"],
  };
  const state = {
    claims: { iss: ISSUER, sub: "sub-1", email: "new@acme.example", name: "New Person" },
    users: [],
    memberships: new Map(),
    joined: [],
    owners: [],
    links: [],
    audits: [],
    verifyInputs: [],
    verifiedDomains: ["acme.example"],
    requireSsoEmails: new Set(),
  };
  const deps = {
    store: createMemorySsoStateStore(),
    oidc: {
      async discover(issuer, expected) { return metadata(expected ?? issuer); },
      authorizationUrl(meta, input) {
        const url = new URL(meta.authorization_endpoint);
        url.searchParams.set("state", input.state);
        url.searchParams.set("nonce", input.nonce);
        if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
        return url.toString();
      },
      async exchangeCode() { return "id-token"; },
      async verifyIdToken(meta, token, input) {
        state.verifyInputs.push(input);
        if (state.verifyError) throw state.verifyError;
        return state.claims;
      },
    },
    microsoft: () => ({ clientId: "ms-client", clientSecret: "ms-secret" }),
    redirectUri: () => "http://localhost:8000/api/auth/sso/callback",
    connections: {
      async activeForDomain(domain) { return connection.domains.includes(domain) ? connection : null; },
      async activeById(id) { return id === connection.id ? connection : null; },
      async organizationVerifiedDomains() { return state.verifiedDomains; },
    },
    accounts: {
      async findByIdentity(issuer, subject) {
        return state.users.find((u) => u.identities.some((i) => i.issuer === issuer && i.subject === subject)) ?? null;
      },
      async findByEmail(email) { return state.users.find((u) => u.email === email) ?? null; },
      async link(userId, person) { state.links.push({ userId, issuer: person.issuer }); },
      async createOwner(person) { state.owners.push(person); return { userId: "owner-new", organizationId: "org-new" }; },
      async joinOrganization(organizationId, person, role) { state.joined.push({ organizationId, email: person.email, role }); return { userId: "joined-1" }; },
      async membership(organizationId, userId) { return state.memberships.get(`${organizationId}:${userId}`) ?? null; },
      async addMembership(organizationId, userId, role) { state.memberships.set(`${organizationId}:${userId}`, { status: "active", roles: [role] }); },
    },
    async ssoRequiredFor(email) { return state.requireSsoEmails.has(email); },
    invitations: {
      async organizationOf() { return state.inviteOrg ?? "org1"; },
      async acceptWithPerson(token, person, method) {
        state.accepted = { token, email: person.email, method };
        return state.inviteOutcome ?? { kind: "accepted", userId: "invitee", organizationId: "org1", role: "approver" };
      },
    },
    async audit(event) { state.audits.push(event); },
    ...overrides,
  };
  return { signIn: createFederatedSignIn(deps), state, connection };
};

const stateFrom = (url) => new URL(url).searchParams.get("state");

const roundTrip = async (h, startInput = { kind: "company", email: "new@acme.example" }) => {
  const started = await h.signIn.start({ bind: BIND_HASH, ...startInput });
  assert.equal(started.kind, "redirect", JSON.stringify(started));
  return h.signIn.callback({ code: "auth-code", state: stateFrom(started.url) }, "corr-1");
};

test("bind hash is lowercase hex sha256 of the cookie (matches the dashboard)", () => {
  assert.equal(bindHashFor(BIND), BIND_HASH);
});

test("start refuses a missing or malformed bind and unknown kinds", async () => {
  const h = harness();
  assert.deepEqual(await h.signIn.start({ kind: "company", email: "a@acme.example" }), { kind: "error", code: "SSO_INVALID_REQUEST" });
  assert.deepEqual(await h.signIn.start({ kind: "company", email: "a@acme.example", bind: "abc" }), { kind: "error", code: "SSO_INVALID_REQUEST" });
  assert.deepEqual(await h.signIn.start({ kind: "saml", bind: BIND_HASH }), { kind: "error", code: "SSO_INVALID_REQUEST" });
});

test("company start: unknown domain gets SSO_NOT_CONFIGURED; known domain redirects with login_hint", async () => {
  const h = harness();
  assert.deepEqual(await h.signIn.start({ kind: "company", email: "a@other.example", bind: BIND_HASH }), { kind: "error", code: "SSO_NOT_CONFIGURED" });
  const started = await h.signIn.start({ kind: "company", email: "A@Acme.Example", bind: BIND_HASH });
  assert.equal(new URL(started.url).searchParams.get("login_hint"), "a@acme.example");
});

test("Microsoft start without configuration is refused", async () => {
  const h = harness({ microsoft: () => null });
  assert.deepEqual(await h.signIn.start({ kind: "microsoft", bind: BIND_HASH }), { kind: "error", code: "MICROSOFT_NOT_CONFIGURED" });
});

test("first company sign-in joins as Planner, audits it, and redeems once with the right bind", async () => {
  const h = harness();
  const result = await roundTrip(h);
  assert.equal(result.kind, "handoff");
  assert.deepEqual(h.state.joined, [{ organizationId: "org1", email: "new@acme.example", role: "planner" }]);
  assert.equal(h.state.audits[0].action, "organization.member.sso_joined");
  assert.equal(h.state.verifyInputs[0].issuer, ISSUER);

  assert.deepEqual(await h.signIn.exchange({ handoff: result.handoff, bind: "wrong-cookie" }), { kind: "error", code: "SSO_HANDOFF_INVALID" });
  // A failed redemption burns the handoff too.
  assert.deepEqual(await h.signIn.exchange({ handoff: result.handoff, bind: BIND }), { kind: "error", code: "SSO_HANDOFF_INVALID" });
});

test("handoff redeems with the bind cookie and cannot be replayed", async () => {
  const h = harness();
  const result = await roundTrip(h);
  const exchanged = await h.signIn.exchange({ handoff: result.handoff, bind: BIND });
  assert.equal(exchanged.kind, "signed_in");
  assert.deepEqual(exchanged.outcome, {
    userId: "joined-1", organizationId: "org1", method: "company_sso", isNewUser: true, role: "planner",
  });
  assert.deepEqual(await h.signIn.exchange({ handoff: result.handoff, bind: BIND }), { kind: "error", code: "SSO_HANDOFF_INVALID" });
});

test("state is single use", async () => {
  const h = harness();
  const started = await h.signIn.start({ kind: "company", email: "new@acme.example", bind: BIND_HASH });
  const state = stateFrom(started.url);
  assert.equal((await h.signIn.callback({ code: "c", state }, "c1")).kind, "handoff");
  assert.deepEqual(await h.signIn.callback({ code: "c", state }, "c2"), { kind: "error", code: "SSO_STATE_INVALID", inviteToken: null });
  assert.deepEqual(await h.signIn.callback({ code: "c", state: "made-up" }, "c3"), { kind: "error", code: "SSO_STATE_INVALID", inviteToken: null });
});

test("IdP error and bad ID token are refused without touching accounts", async () => {
  const h = harness();
  const started = await h.signIn.start({ kind: "company", email: "new@acme.example", bind: BIND_HASH });
  assert.equal((await h.signIn.callback({ error: "access_denied", state: stateFrom(started.url) }, "c")).code, "SSO_CANCELLED");

  h.state.verifyError = Object.assign(new Error("nonce mismatch"), { code: "ID_TOKEN_INVALID" });
  assert.equal((await roundTrip(h)).code, "SSO_IDENTITY_INVALID");
  h.state.verifyError = Object.assign(new Error("down"), { code: "TOKEN_EXCHANGE_FAILED" });
  assert.equal((await roundTrip(h)).code, "SSO_PROVIDER_UNAVAILABLE");
  assert.equal(h.state.joined.length, 0);
});

test("company IdP may only sign in emails on the connection's still-verified domains", async () => {
  const h = harness();
  h.state.claims = { iss: ISSUER, sub: "x", email: "someone@gmail.com" };
  assert.equal((await roundTrip(h)).code, "SSO_DOMAIN_NOT_ALLOWED");

  h.state.claims = { iss: ISSUER, sub: "x", email: "pat@acme.example" };
  h.state.verifiedDomains = [];
  assert.equal((await roundTrip(h)).code, "SSO_DOMAIN_NOT_ALLOWED");
  assert.equal(h.state.joined.length, 0);
});

test("existing member signs in by email, gets linked, keeps their membership", async () => {
  const h = harness();
  h.state.users.push({ userId: "u1", email: "new@acme.example", organizationId: "org1", isBlocked: false, identities: [] });
  h.state.memberships.set("org1:u1", { status: "active", roles: ["approver"] });
  const result = await roundTrip(h);
  const { outcome } = await h.signIn.exchange({ handoff: result.handoff, bind: BIND });
  assert.equal(outcome.userId, "u1");
  assert.equal(outcome.isNewUser, false);
  assert.deepEqual(h.state.links, [{ userId: "u1", issuer: ISSUER }]);
  assert.deepEqual(h.state.memberships.get("org1:u1").roles, ["approver"]);
});

test("company sign-in refuses other-org emails, deactivated members, blocked users and re-linked subjects", async () => {
  const other = harness();
  other.state.users.push({ userId: "u2", email: "new@acme.example", organizationId: "org9", isBlocked: false, identities: [] });
  assert.equal((await roundTrip(other)).code, "EMAIL_IN_ANOTHER_ORGANIZATION");

  const removed = harness();
  removed.state.users.push({ userId: "u3", email: "new@acme.example", organizationId: "org1", isBlocked: false, identities: [] });
  removed.state.memberships.set("org1:u3", { status: "removed", roles: ["planner"] });
  assert.equal((await roundTrip(removed)).code, "MEMBER_DEACTIVATED");

  const blocked = harness();
  blocked.state.users.push({ userId: "u4", email: "new@acme.example", organizationId: "org1", isBlocked: true, identities: [] });
  assert.equal((await roundTrip(blocked)).code, "USER_BLOCKED");

  const relinked = harness();
  relinked.state.users.push({
    userId: "u5", email: "new@acme.example", organizationId: "org1", isBlocked: false, identities: [{ issuer: ISSUER, subject: "someone-else" }],
  });
  assert.equal((await roundTrip(relinked)).code, "SSO_IDENTITY_MISMATCH");
});

test("invite accepted through company SSO keeps the invited role; foreign-org invite is refused", async () => {
  const token = "invite-token-abcdefghijklmnop";
  const h = harness();
  const result = await roundTrip(h, { kind: "company", email: "new@acme.example", invite: token });
  const { outcome } = await h.signIn.exchange({ handoff: result.handoff, bind: BIND });
  assert.equal(outcome.role, "approver");
  assert.deepEqual(h.state.accepted, { token, email: "new@acme.example", method: "company_sso" });
  assert.equal(h.state.joined.length, 0);

  const foreign = harness();
  foreign.state.inviteOrg = "org2";
  const refused = await roundTrip(foreign, { kind: "company", email: "new@acme.example", invite: token });
  assert.deepEqual(refused, { kind: "error", code: "SSO_INVITE_ORG_MISMATCH", inviteToken: token });
});

test("Microsoft: new person becomes an Owner; Require SSO blocks them", async () => {
  const h = harness();
  h.state.claims = { iss: microsoftIssuerFor(TENANT), sub: "s", tid: TENANT, oid: "o1", email: "pat@fabrikam.example", xms_edov: true };
  const result = await roundTrip(h, { kind: "microsoft" });
  const { outcome } = await h.signIn.exchange({ handoff: result.handoff, bind: BIND });
  assert.deepEqual(outcome, { userId: "owner-new", organizationId: "org-new", method: "sso", isNewUser: true });
  assert.equal(h.state.verifyInputs[0].issuerFor({ tid: TENANT }), `https://login.microsoftonline.com/${TENANT}/v2.0`);

  const required = harness();
  required.state.claims = { ...h.state.claims, email: "pat@acme.example" };
  required.state.requireSsoEmails.add("pat@acme.example");
  assert.equal((await roundTrip(required, { kind: "microsoft" })).code, "SSO_REQUIRED");
  assert.equal(required.state.owners.length, 0);
});

test("Microsoft: unverified tenant email is refused before any account work", async () => {
  const h = harness();
  h.state.claims = { iss: microsoftIssuerFor(TENANT), sub: "s", tid: TENANT, oid: "o1", email: "ceo@acme.example" };
  assert.equal((await roundTrip(h, { kind: "microsoft" })).code, "MICROSOFT_EMAIL_UNVERIFIED");
  assert.equal(h.state.owners.length + h.state.links.length, 0);
});

/* ---------- password gate ---------- */

test("password sign-in routes answer 410 unless PASSWORD_SIGN_IN_ENABLED=true", () => {
  const { requirePasswordSignIn } = require("../middleware/passwordSignIn");
  const previous = process.env.PASSWORD_SIGN_IN_ENABLED;
  const run = () => {
    let status; let body; let nexted = false;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    requirePasswordSignIn({}, res, () => { nexted = true; });
    return { status, body, nexted };
  };
  try {
    delete process.env.PASSWORD_SIGN_IN_ENABLED;
    const off = run();
    assert.equal(off.status, 410);
    assert.equal(off.body.code, "PASSWORD_SIGN_IN_DISABLED");
    assert.equal(off.nexted, false);
    process.env.PASSWORD_SIGN_IN_ENABLED = "true";
    assert.equal(run().nexted, true);
  } finally {
    if (previous === undefined) delete process.env.PASSWORD_SIGN_IN_ENABLED;
    else process.env.PASSWORD_SIGN_IN_ENABLED = previous;
  }
});
