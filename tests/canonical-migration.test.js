const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildCanonicalMigrationCandidate,
  hashLegacyProposal,
} = require("../src/modules/proposals/application/canonicalMigration");
const {
  migrateLegacyProposalBatch,
  rollbackCanonicalMigrationRun,
} = require("../src/modules/proposals/infrastructure/mongo/canonicalMigrationRepository");

const legacyProposal = {
  _id: { toString: () => "507f1f77bcf86cd799439011" },
  userId: { toString: () => "507f191e810c19729de860ea" },
  status: "submitted",
  event: {
    eventName: "DXG Annual Summit",
    startDate: "2026-10-10",
    eventFormat: "Hybrid",
  },
  venueSchedule: { numberOfEventRooms: "1" },
  roomByRoom: [{ roomFunction: "General Session" }],
  contact: {
    contactFirstName: "Avery",
    contactLastName: "Planner",
    contactEmail: "avery@example.com",
  },
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

const dependencies = (overrides = {}) => ({
  findLegacyProposals: async () => [legacyProposal],
  insertSnapshotIfAbsent: async () => true,
  countSnapshots: async () => 1,
  deleteSnapshots: async () => 1,
  ...overrides,
});

test("legacy hash is stable across object key order", () => {
  assert.equal(
    hashLegacyProposal({ a: 1, nested: { b: 2, c: 3 } }),
    hashLegacyProposal({ nested: { c: 3, b: 2 }, a: 1 }),
  );
});

test("invalid legacy values route a candidate to review without guessing", () => {
  const candidate = buildCanonicalMigrationCandidate(
    {
      ...legacyProposal,
      event: { ...legacyProposal.event, startDate: "October sometime" },
    },
    { organizationId: "org-001" },
  );

  assert.equal(candidate.status, "needs_review");
  assert.ok(candidate.issues.some((issue) => issue.path === "/event/startDate"));
});

test("dry-run scans and classifies without writing snapshots", async () => {
  let writes = 0;
  const result = await migrateLegacyProposalBatch(
    {
      organizationId: "org-001",
      sourceOwnerUserId: "507f191e810c19729de860ea",
      runId: "run-dry",
      apply: false,
    },
    dependencies({
      insertSnapshotIfAbsent: async () => {
        writes += 1;
        return true;
      },
    }),
  );

  assert.equal(result.mode, "dry_run");
  assert.equal(result.scanned, 1);
  assert.equal(result.inserted, 0);
  assert.equal(writes, 0);
});

test("apply is idempotent for the same legacy hash and release", async () => {
  const seen = new Set();
  const deps = dependencies({
    insertSnapshotIfAbsent: async ({ candidate }) => {
      const key = `${candidate.legacyHash}:${candidate.migrationRelease}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  });
  const options = {
    organizationId: "org-001",
    sourceOwnerUserId: "507f191e810c19729de860ea",
    runId: "run-apply",
    apply: true,
  };

  const first = await migrateLegacyProposalBatch(options, deps);
  const second = await migrateLegacyProposalBatch(options, deps);

  assert.equal(first.inserted, 1);
  assert.equal(first.alreadyPresent, 0);
  assert.equal(second.inserted, 0);
  assert.equal(second.alreadyPresent, 1);
});

test("migration scopes legacy reads to the selected owner", async () => {
  let received;
  await migrateLegacyProposalBatch(
    {
      organizationId: "org-001",
      sourceOwnerUserId: "507f191e810c19729de860ea",
      runId: "run-scoped",
      apply: false,
    },
    dependencies({
      findLegacyProposals: async (options) => {
        received = options;
        return [];
      },
    }),
  );

  assert.equal(received.sourceOwnerUserId, "507f191e810c19729de860ea");
});

test("rollback is preview-only unless apply is explicit", async () => {
  let deletes = 0;
  const deps = dependencies({
    countSnapshots: async () => 3,
    deleteSnapshots: async () => {
      deletes += 1;
      return 3;
    },
  });

  const preview = await rollbackCanonicalMigrationRun(
    { organizationId: "org-001", runId: "run-001", apply: false },
    deps,
  );
  assert.deepEqual(preview, { mode: "dry_run", matched: 3, deleted: 0 });
  assert.equal(deletes, 0);

  const applied = await rollbackCanonicalMigrationRun(
    { organizationId: "org-001", runId: "run-001", apply: true },
    deps,
  );
  assert.deepEqual(applied, { mode: "apply", matched: 3, deleted: 3 });
  assert.equal(deletes, 1);
});
