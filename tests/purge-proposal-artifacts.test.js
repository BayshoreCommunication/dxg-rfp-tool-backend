const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// purgeProposalArtifacts needs a live Postgres and S3 to exercise, so these are
// structural guards against the two specific defects that made it a permanent
// no-op. Behavioural coverage belongs in tests-integration.
const source = read("src/modules/dataFoundation/purgeProposalArtifacts.ts");

test("purge sets the tenant GUC before reading any tenant table", () => {
  // The organization lookup used to run before set_config, so under a role that
  // honours RLS current_organization_id() was NULL, the policy filtered every
  // row, and the purge returned silently — after Mongo had already hard-deleted
  // the proposal.
  const guc = source.indexOf("set_config('app.organization_id'");
  const sourcesRead = source.indexOf("FROM rfpilot.document_sources");
  assert.ok(guc > 0, "tenant GUC is set");
  assert.ok(sourcesRead > 0, "document sources are read");
  assert.ok(guc < sourcesRead, "GUC is set before the first tenant-table read");
});

test("purge reads object_key from document_objects, not document_sources", () => {
  // object_key lives on document_objects. Selecting it from document_sources
  // raised 42703, aborting the transaction into a swallowed catch — so no S3
  // delete, tombstone, or audit event ever ran.
  assert.ok(
    !/SELECT\s+id,object_key\s+FROM\s+rfpilot\.document_sources/.test(source),
    "the non-existent document_sources.object_key column is gone",
  );
  assert.ok(
    /LEFT JOIN rfpilot\.document_objects o ON o\.source_id = s\.id/.test(source),
    "object_key is joined from document_objects",
  );
  // A source can exist before its object row does (upload session created,
  // bytes never PUT), so the join must tolerate a missing object.
  assert.ok(source.includes("if (source.object_key)"), "missing object keys are skipped, not deleted");

  const migration = read("migrations/postgres/003_private_document_ingestion.up.sql");
  const objects = migration.slice(migration.indexOf("CREATE TABLE rfpilot.document_objects"));
  assert.ok(objects.includes("object_key"), "document_objects still owns object_key");
  const sources = migration.slice(
    migration.indexOf("CREATE TABLE rfpilot.document_sources"),
    migration.indexOf("CREATE TABLE rfpilot.document_objects"),
  );
  assert.ok(!sources.includes("object_key"), "document_sources still has no object_key");
});

test("purge failures are reported loudly with a diagnostic code", () => {
  // Mongo has already hard-deleted the proposal by the time this runs, so a
  // failure leaves orphaned storage objects with no other signal. A silent
  // warn is how a permanently broken purge went unnoticed.
  assert.ok(
    /safeLog\(\s*"error",\s*"proposal_artifacts_purge_failed"/.test(source),
    "failure logs at error level",
  );
  assert.ok(source.includes("errorCode:"), "the driver error code is recorded");
});
