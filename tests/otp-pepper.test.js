const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveOtpPepper } = require("../src/modules/auth/infrastructure/security/hmacOtpCodeHasher");

test("production needs OTP_PEPPER and never falls back to JWT_SECRET", () => {
  assert.throws(() => resolveOtpPepper({ NODE_ENV: "production", JWT_SECRET: "jwt" }), /OTP_PEPPER must be configured in production/);
  assert.throws(() => resolveOtpPepper({ NODE_ENV: "production", OTP_PEPPER: "  " }), /OTP_PEPPER/);
  assert.equal(resolveOtpPepper({ NODE_ENV: "production", OTP_PEPPER: "pepper", JWT_SECRET: "jwt" }), "pepper");
});

test("development and tests keep the fallback", () => {
  assert.equal(resolveOtpPepper({ NODE_ENV: "test", JWT_SECRET: "jwt" }), "jwt");
  assert.equal(resolveOtpPepper({ NODE_ENV: "development" }), "rfpilot-development-otp-pepper");
});

test("a production process without it fails when the module loads, not on the first code", () => {
  const env = { ...process.env, NODE_ENV: "production", JWT_SECRET: "jwt" };
  delete env.OTP_PEPPER;
  const load = (extra) => spawnSync(process.execPath, ["--require", "ts-node/register/transpile-only", "-e", 'require("./src/modules/auth/infrastructure/security/hmacOtpCodeHasher")'], {
    cwd: path.join(__dirname, ".."), env: { ...env, ...extra }, encoding: "utf8",
  });
  const failed = load({});
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /OTP_PEPPER must be configured in production/);
  assert.equal(load({ OTP_PEPPER: "pepper" }).status, 0);
});
