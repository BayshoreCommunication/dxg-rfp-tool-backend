require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { runWithTenant } = require("../src/modules/shared/tenancy/tenantContext");
const { closePostgres } = require("../config/postgres");
const { postgresProposalReferenceSynchronizer } = require("../src/modules/proposals/infrastructure/references/postgresProposalReferenceSynchronizer");

test("disabled dual write performs no PostgreSQL work", async () => {
  const before = process.env.PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED;
  process.env.PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED = "false";
  await postgresProposalReferenceSynchronizer.synchronize({ proposal: { _id: "not-called" }, ownerUserId: "owner", eventType: "proposal.reference.updated" });
  if (before === undefined) delete process.env.PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED; else process.env.PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED = before;
});

test("PostgreSQL outage defers secondary synchronization without failing Mongo workflow", async () => {
  const original = { foundation: process.env.POSTGRES_FOUNDATION_ENABLED, dual: process.env.PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED, url: process.env.POSTGRES_URL, timeout: process.env.POSTGRES_CONNECT_TIMEOUT_MS };
  Object.assign(process.env, {
    POSTGRES_FOUNDATION_ENABLED: "true",
    PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED: "true",
    POSTGRES_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
    POSTGRES_CONNECT_TIMEOUT_MS: "50",
  });
  const oldError = console.error;
  let deferred = false;
  console.error = (message) => { if (message === "Proposal reference synchronization deferred") deferred = true; };
  try {
    await runWithTenant({ organizationId: "6a58a2d07dac2b57c12d5247", userId: "6a58a2d07dac2b57c12d5247" }, () =>
      postgresProposalReferenceSynchronizer.synchronize({
        proposal: { _id: "6a58a2d07dac2b57c12d5247", __v: 1 },
        ownerUserId: "6a58a2d07dac2b57c12d5247",
        eventType: "proposal.reference.updated",
      }),
    );
    assert.equal(deferred, true);
  } finally {
    console.error = oldError;
    await closePostgres();
    for (const [key, value] of Object.entries({ POSTGRES_FOUNDATION_ENABLED: original.foundation, PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED: original.dual, POSTGRES_URL: original.url, POSTGRES_CONNECT_TIMEOUT_MS: original.timeout })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
