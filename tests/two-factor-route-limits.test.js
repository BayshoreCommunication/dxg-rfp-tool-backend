require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { userIdentity } = require("../routes/twoFactorRoute");

test("the signed-in 2FA limiter counts per user, whatever the IP", () => {
  const fromOffice = userIdentity({ ip: "203.0.113.1", user: { userId: "u1" } });
  const fromPhone = userIdentity({ ip: "198.51.100.7", user: { userId: "u1" } });
  assert.equal(fromOffice, fromPhone);
  assert.notEqual(fromOffice, userIdentity({ ip: "203.0.113.1", user: { userId: "u2" } }));
});
