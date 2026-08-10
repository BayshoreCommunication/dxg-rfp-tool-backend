const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");

const root = path.join(__dirname, "..");

test("provider attempt ledger migration enforces tenancy and bounded states", () => {
  const up = fs.readFileSync(path.join(root, "migrations/postgres/016_ai_provider_attempts.up.sql"), "utf8");
  for (const value of [
    "rfpilot.ai_provider_attempts",
    "FORCE ROW LEVEL SECURITY",
    "current_organization_id()",
    "attempt_fingerprint text NOT NULL UNIQUE",
    "'pending_call','succeeded','failed','orphaned'",
    "UNIQUE(run_type,run_id,attempt_number)",
  ])
    assert.ok(up.includes(value), value);
});

test("live provider commits a ledger attempt before invocation and uses a stable logical-phase idempotency key", () => {
  const provider = fs.readFileSync(path.join(root, "src/modules/liveAi/openAiProvider.ts"), "utf8");
  const beginIndex = provider.indexOf("beginProviderAttempt");
  const callIndex = provider.indexOf("client.responses.create");
  assert.ok(beginIndex > -1 && callIndex > -1 && beginIndex < callIndex, "attempt must be recorded before the provider call");
  assert.ok(provider.includes("idempotencyKey:attempt.idempotencyKey"), "the stable logical-phase key must be sent to the provider");
  const ledger = fs.readFileSync(path.join(root, "src/modules/liveAi/attemptLedger.ts"), "utf8");
  assert.ok(ledger.includes("state='orphaned'"), "stale pending attempts must be marked orphaned");
  assert.match(ledger, /call\.idempotencyPhase \?\? call\.operation/, "provider idempotency must be stable across worker retries");
  assert.match(ledger, /attemptNumber/, "each retry must still receive its own auditable attempt row");
});
