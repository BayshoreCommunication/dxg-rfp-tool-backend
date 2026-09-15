const test = require("node:test");
const assert = require("node:assert/strict");
require("ts-node/register");
const {
  evaluateLedger,
  configuredReason,
  availabilitySettings,
} = require("../src/modules/aiGateway/providerAvailability");

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const failure = (minutesAgo, code = "LIVE_AI_PROVIDER_TEMPORARY") => ({
  state: "failed", error_code: code, updated_at: at(minutesAgo),
});
const success = (minutesAgo) => ({ state: "succeeded", error_code: null, updated_at: at(minutesAgo) });

test("consecutive provider failures close the circuit", () => {
  const oldest = failure(3);
  const verdict = evaluateLedger([failure(1), oldest, success(40)], Date.now());
  assert.equal(verdict.failing, true);
  assert.equal(verdict.since, oldest.updated_at, "reports when the outage began, not the last attempt");
});

test("a recent success keeps the circuit open", () => {
  // Ledger order is newest first: a success at the head means the provider
  // answered after the failures, so the product must not be halted.
  assert.equal(evaluateLedger([success(1), failure(3), failure(5)], Date.now()).failing, false);
});

test("stale failures never halt the product for ever", () => {
  // THE DEADLOCK GUARD. Blocking the composer stops new attempts, so without
  // a cooldown the ledger freezes on its last failure and nothing can ever
  // reopen the circuit. Failures older than the cooldown must go stale.
  const { cooldownMs } = availabilitySettings();
  const staleMinutes = cooldownMs / 60_000 + 5;
  assert.equal(evaluateLedger([failure(staleMinutes), failure(staleMinutes + 2)], Date.now()).failing, false);
});

test("content failures are not provider outages", () => {
  // One unparseable document must never halt the product for everyone.
  for (const code of ["LIVE_AI_MALFORMED_OUTPUT", "LIVE_AI_CITATION_INVALID", "LIVE_AI_INPUT_TOO_LARGE"])
    assert.equal(evaluateLedger([failure(1, code), failure(2, code)], Date.now()).failing, false, code);
});

test("a single failure is noise, not an outage", () => {
  assert.equal(evaluateLedger([failure(1), success(10)], Date.now()).failing, false);
  assert.equal(evaluateLedger([], Date.now()).failing, false, "a brand new organization is available");
});

test("configuration gates are reported separately from provider health", () => {
  const saved = { ...process.env };
  try {
    process.env.AI_ENVIRONMENT = "production";
    process.env.LIVE_AI_PILOT_ENABLED = "true";
    process.env.LIVE_AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.LIVE_AI_KILL_SWITCH;
    delete process.env.LIVE_AI_KILL_SWITCH_EXTRACTSTRUCTURED;
    assert.equal(configuredReason(), null, "fully configured");

    process.env.LIVE_AI_KILL_SWITCH = "true";
    assert.equal(configuredReason(), "KILL_SWITCH");
    process.env.LIVE_AI_KILL_SWITCH = "false";
    process.env.LIVE_AI_KILL_SWITCH_EXTRACTSTRUCTURED = "true";
    assert.equal(configuredReason(), "KILL_SWITCH", "the per-operation switch also halts the composer");

    delete process.env.LIVE_AI_KILL_SWITCH_EXTRACTSTRUCTURED;
    delete process.env.OPENAI_API_KEY;
    assert.equal(configuredReason(), "CREDENTIAL_MISSING");

    process.env.OPENAI_API_KEY = "test-key";
    process.env.LIVE_AI_PILOT_ENABLED = "false";
    assert.equal(configuredReason(), "PILOT_DISABLED");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
