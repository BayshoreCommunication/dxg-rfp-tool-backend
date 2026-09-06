const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { generateProposalUploadTicket, verifyProposalUploadTicket, generateAccessToken, verifyAccessToken } = require("../config/jwt");
const payload = { userId: "user-test", organizationId: "org-test", sessionId: "session-test", role: "customer", email: "test@example.com", rolesVersion: 1 };

test("upload tickets round-trip identity and expire after two minutes", () => {
  const { ticket, expiresAt } = generateProposalUploadTicket(payload);
  assert.deepEqual(verifyProposalUploadTicket(ticket), payload);
  const claims = jwt.decode(ticket);
  assert.equal(claims.exp - claims.iat, 120);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 120000);
});

test("upload-only tickets cannot authorize normal APIs and access tokens cannot authorize direct uploads", () => {
  assert.throws(() => verifyAccessToken(generateProposalUploadTicket(payload).ticket));
  assert.throws(() => verifyProposalUploadTicket(generateAccessToken(payload).accessToken));
});

test("rejects malformed or tampered tickets and missing active-session claims", () => {
  assert.throws(() => verifyProposalUploadTicket("not-a-token"));
  const ticket = generateProposalUploadTicket(payload).ticket;
  const parts = ticket.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...jwt.decode(ticket), sub: "another-user" })).toString("base64url");
  assert.throws(() => verifyProposalUploadTicket(parts.join(".")));
  assert.throws(() => generateProposalUploadTicket({ ...payload, sessionId: undefined }));
  assert.throws(() => verifyProposalUploadTicket(generateProposalUploadTicket({ ...payload, rolesVersion: undefined }).ticket));
});

test("expired upload tickets fail validation", () => {
  const ticket = generateProposalUploadTicket(payload).ticket;
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 121000;
    assert.throws(() => verifyProposalUploadTicket(ticket), /expired/);
  } finally { Date.now = originalNow; }
});
