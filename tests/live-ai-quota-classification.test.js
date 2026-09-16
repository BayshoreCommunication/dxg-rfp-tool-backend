const test = require("node:test");
const assert = require("node:assert/strict");
require("ts-node/register");
const { classifyProviderFailure } = require("../src/modules/liveAi/openAiProvider");
const { evaluateLedger } = require("../src/modules/aiGateway/providerAvailability");

test("an exhausted account is not a transient failure", () => {
  // The regression: OpenAI answers 429 both for a rate limit, which clears on
  // its own, and for insufficient_quota, which means the account cannot pay
  // and will answer 429 for ever. Treating both as retryable burned the whole
  // attempt budget on an unwinnable call and told the planner to "try again".
  // Production failed every AI request for a week on exactly this.
  for (const code of ["insufficient_quota", "billing_hard_limit_reached", "account_deactivated"])
    assert.equal(classifyProviderFailure(429, code), "LIVE_AI_QUOTA_EXHAUSTED", code);
});

test("genuinely transient failures stay retryable", () => {
  assert.equal(classifyProviderFailure(429, "rate_limit_exceeded"), "LIVE_AI_PROVIDER_TEMPORARY");
  assert.equal(classifyProviderFailure(429, ""), "LIVE_AI_PROVIDER_TEMPORARY", "an unlabelled 429 gets the benefit of the doubt");
  for (const status of [500, 502, 503, 529])
    assert.equal(classifyProviderFailure(status, ""), "LIVE_AI_PROVIDER_TEMPORARY", String(status));
  assert.equal(classifyProviderFailure(0, "", "APIConnectionTimeoutError"), "LIVE_AI_PROVIDER_TEMPORARY");
});

test("everything else is a terminal provider failure", () => {
  for (const status of [400, 401, 403, 404, 422])
    assert.equal(classifyProviderFailure(status, "invalid_request_error"), "LIVE_AI_PROVIDER_FAILED", String(status));
});

test("a quota outage closes the composer's circuit", () => {
  // Quota exhaustion is the outage the availability circuit exists for — it
  // fails every call indefinitely. If its code is missing from the provider
  // failure set the composer keeps accepting sends right through it.
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const quotaFailure = (minutesAgo) => ({
    state: "failed", error_code: "LIVE_AI_QUOTA_EXHAUSTED", updated_at: at(minutesAgo),
  });
  assert.equal(evaluateLedger([quotaFailure(1), quotaFailure(4)], Date.now()).failing, true);
});
