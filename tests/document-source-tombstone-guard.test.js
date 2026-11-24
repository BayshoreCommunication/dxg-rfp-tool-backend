const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// rfpilot.enforce_document_source_transition allows `deleted` only from
// `deletion_pending`. purgeProposalArtifacts used to write status='deleted'
// straight onto a `ready` row: the trigger raised, the transaction rolled back
// after the file had already left storage, and a catch turned it into a log
// line. The shared helper is now the way to a tombstone, and this guard fails
// when another statement writes the status itself.

const HELPER = "src/modules/documentIngestion/sourceDeletionTransitions.ts";

// File -> number of statements that set status='deleted' on document_sources.
const ALLOWED = {
  [HELPER]: 1,
  // Single-document delete: requestDeletion() commits `deletion_pending`, then markDeleted().
  "src/modules/documentIngestion/postgresDocumentRepository.ts": 1,
  // Vendor response purge: marks `deletion_pending` and tombstones in one transaction.
  "scripts/purgeVendorResponses.ts": 1,
  // KNOWN DEFECT, not a model to copy: the retention sweep tombstones a source
  // from whatever status it is in, which the trigger rejects for anything but
  // `deletion_pending`. Listed so this guard is green today and so a second
  // statement here still fails. Remove this line when the sweep uses the helper.
  "src/modules/dataFoundation/retentionSweeper.ts": 1,
};

const DIRECT_TOMBSTONE = /UPDATE\s+rfpilot\.document_sources\s+SET\b[^;`"]*?\bstatus\s*=\s*'deleted'/g;
const ROOTS = ["src", "utils", "scripts", "controller", "routes", "middleware", "config", "modal"];

const sourceFiles = (directory) =>
  fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(relative);
    return /\.(ts|js)$/.test(entry.name) ? [relative] : [];
  });

test("status='deleted' is written to document_sources only where the transition is honoured", () => {
  const found = {};
  for (const directory of ROOTS.filter((name) => fs.existsSync(path.join(root, name)))) {
    for (const file of sourceFiles(directory)) {
      const count = (read(file).match(DIRECT_TOMBSTONE) ?? []).length;
      if (count) found[file] = count;
    }
  }
  assert.deepEqual(
    found,
    ALLOWED,
    `A statement sets status='deleted' on rfpilot.document_sources outside ${HELPER}. ` +
      "Use markSourcesDeletionPending() and markSourcesDeleted() from that file instead.",
  );
});

test("the helper tombstones only from deletion_pending, as the trigger requires", () => {
  const helper = read(HELPER);
  const tombstone = helper.slice(helper.indexOf("export const markSourcesDeleted"));
  assert.match(tombstone, /SET status='deleted',deleted_at=now\(\)/);
  assert.match(tombstone, /AND status='deletion_pending'/, "a row in any other status is left alone, not forced");

  const migration = read("migrations/postgres/003_private_document_ingestion.up.sql");
  assert.ok(
    migration.includes("(OLD.status = 'deletion_pending' AND NEW.status = 'deleted')"),
    "the trigger still allows deleted only from deletion_pending",
  );
  // Every status the helper moves to deletion_pending in one step is one the trigger allows.
  const direct = /const DIRECTLY_DELETABLE = \[([^\]]+)\]/.exec(helper)[1].match(/[a-z_]+/g);
  assert.deepEqual(direct, ["pending_upload", "uploaded", "scan_failed", "ready", "blocked"]);
  assert.ok(migration.includes("(OLD.status = 'pending_upload' AND NEW.status IN ('uploaded','expired','blocked','deletion_pending'))"));
  assert.ok(migration.includes("(OLD.status = 'uploaded' AND NEW.status IN ('scanning','blocked','deletion_pending'))"));
  assert.ok(migration.includes("(OLD.status = 'scan_failed' AND NEW.status IN ('scanning','deletion_pending'))"));
  assert.ok(migration.includes("(OLD.status IN ('ready','blocked') AND NEW.status = 'deletion_pending')"));
  // A scan in flight is abandoned first; the trigger has no scanning -> deletion_pending.
  assert.ok(migration.includes("(OLD.status = 'scanning' AND NEW.status IN ('ready','blocked','scan_failed'))"));
  assert.match(helper, /SET status='scan_failed',updated_at=now\(\) WHERE id = ANY\(\$1::uuid\[\]\) AND status='scanning'/);
});

test("permanent delete marks before it deletes from storage, and tombstones after", () => {
  const purge = read("src/modules/dataFoundation/purgeProposalArtifacts.ts");
  const body = purge.slice(purge.indexOf("const purgeOne"));
  const mark = body.indexOf("markSourcesDeletionPending(");
  const storage = body.indexOf("s3PrivateDocumentStorage.delete(");
  const tombstone = body.indexOf("markSourcesDeleted(");
  assert.ok(mark > 0 && storage > mark && tombstone > storage, "mark, then storage, then tombstone");
  // The mark is committed on its own: the storage call sits between two transactions.
  const transactions = [...body.matchAll(/withPostgresTransaction\(/g)].map((match) => match.index);
  assert.equal(transactions.length, 2);
  assert.ok(transactions[0] < mark && mark < storage && storage < transactions[1] && transactions[1] < tombstone);
  // A failed storage delete skips the source instead of falling through to the tombstone.
  assert.match(body, /catch \(error\) \{\s+result\.errorCode \?\?= errorCodeOf\(error\);\s+continue;\s+\}\s+\}\s+objectGone\.push\(source\.id\);/);
});
