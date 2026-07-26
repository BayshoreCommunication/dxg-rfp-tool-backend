const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  retentionSweepEnabled,
  retentionSweepApplies,
} = require("../src/modules/dataFoundation/retentionSweeper");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const source = read("src/modules/dataFoundation/retentionSweeper.ts");

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("the sweep is deny-by-default and deleting is a second, separate decision", () => {
  withEnv({ RETENTION_SWEEP_ENABLED: undefined, RETENTION_SWEEP_APPLY: undefined }, () => {
    assert.equal(retentionSweepEnabled(), false);
    assert.equal(retentionSweepApplies(), false);
  });
  // Enabling the sweep alone must not delete anything — it reports only.
  withEnv({ RETENTION_SWEEP_ENABLED: "true", RETENTION_SWEEP_APPLY: undefined }, () => {
    assert.equal(retentionSweepEnabled(), true);
    assert.equal(retentionSweepApplies(), false);
  });
  withEnv({ RETENTION_SWEEP_ENABLED: "true", RETENTION_SWEEP_APPLY: "true" }, () =>
    assert.equal(retentionSweepApplies(), true),
  );
  // Anything other than the exact opt-in string stays closed.
  for (const value of ["1", "yes", "TRUE", ""]) {
    withEnv({ RETENTION_SWEEP_APPLY: value }, () => assert.equal(retentionSweepApplies(), false));
  }
});

test("an expired parent is never deleted while a longer-retained child survives", () => {
  // proposal_context_runs expire after 30 days, but candidate_applications
  // referencing them are kept for a YEAR. Deleting the parent on its own expiry
  // would destroy application records still inside their own window — the
  // single most dangerous thing this sweeper could do.
  const contextQuery = source.slice(
    source.indexOf("FROM rfpilot.proposal_context_runs r"),
    source.indexOf("clarification_questions"),
  );
  assert.match(
    contextQuery,
    /NOT EXISTS \(SELECT 1 FROM rfpilot\.candidate_applications a WHERE a\.run_id = r\.id\)/,
    "context runs are held by any surviving application",
  );
  assert.match(
    contextQuery,
    /candidate_review_sets s ON s\.id = a\.review_set_id/,
    "context runs are also held through the review-set path",
  );
  // A scoped regeneration points at its parent run, so parents wait for children.
  assert.match(
    source,
    /child\.parent_run_id = r\.id AND child\.retention_until >= now\(\)/,
    "a draft run is held by an unexpired regeneration",
  );
});

test("children are deleted before the parents they reference", () => {
  // Every FK in this schema is ON DELETE RESTRICT, so ordering is load-bearing:
  // a wrong order aborts the transaction rather than silently corrupting, but
  // the sweep would then never make progress.
  const order = [
    "candidate_application_items",
    "candidate_applications",
    "vendor_analysis_findings",
    "vendor_analysis_runs",
    "proposal_draft_citations",
    "proposal_draft_paragraphs",
    "proposal_draft_sections",
    "proposal_draft_runs",
    "proposal_context_evidence",
    "candidate_review_decisions",
    "candidate_review_sets",
    "proposal_context_runs",
  ];
  let previous = -1;
  for (const table of order) {
    const at = source.indexOf(`"${table}"`);
    assert.ok(at > previous, `${table} is deleted after its dependants`);
    previous = at;
  }
});

test("legal hold and live references always win over expiry", () => {
  const sourcesQuery = source.slice(source.indexOf("FROM rfpilot.document_sources s"));
  assert.match(sourcesQuery, /s\.legal_hold = false/, "legal hold is never swept");
  assert.match(sourcesQuery, /s\.deleted_at IS NULL/, "already-tombstoned rows are skipped");
  for (const referencing of [
    "proposal_context_run_sources",
    "conversation_message_attachments",
    "knowledge_import_documents",
  ]) {
    assert.ok(
      sourcesQuery.includes(referencing),
      `a source still referenced by ${referencing} is retained`,
    );
  }
  // Scan results hang off document_objects by object_id, not off the source —
  // the same mistake that made purgeProposalArtifacts a permanent no-op.
  assert.match(
    source,
    /DELETE FROM rfpilot\.document_scan_results\s*\n?\s*WHERE object_id IN/,
    "scan results are resolved through document_objects",
  );

  const migration = read("migrations/postgres/003_private_document_ingestion.up.sql");
  const scanResults = migration.slice(migration.indexOf("CREATE TABLE rfpilot.document_scan_results"));
  assert.ok(scanResults.includes("object_id uuid NOT NULL"), "scan results still key on object_id");
});

test("migration 027 narrows draft immutability to UPDATE without allowing edits", () => {
  const up = read("migrations/postgres/027_retention_sweep.up.sql");
  const down = read("migrations/postgres/027_retention_sweep.down.sql");
  for (const trigger of [
    "draft_sections_immutable",
    "draft_paragraphs_immutable",
    "draft_citations_immutable",
    "draft_gaps_immutable",
  ]) {
    assert.ok(
      up.includes(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON`),
      `${trigger} still blocks edits`,
    );
    assert.ok(
      !up.includes(`CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE`),
      `${trigger} no longer blocks retention deletes`,
    );
    assert.ok(
      down.includes(`CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE ON`),
      `${trigger} rollback restores the wider guard`,
    );
  }
});
