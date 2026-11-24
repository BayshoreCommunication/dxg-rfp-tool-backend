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
// when any statement that is not listed below writes the status itself.
//
// What it cannot see: a table or column name built at run time (a template
// placeholder or a variable in place of `document_sources` or `status`), and a
// query builder. Review those by hand.

const HELPER = "src/modules/documentIngestion/sourceDeletionTransitions.ts";

// Every statement, anywhere in the application, that writes `status` on
// document_sources: file -> the exact statements (whitespace collapsed). A new
// statement, or a changed one, fails the guard until it is reviewed and listed.
const ALLOWED = {
  // The shared helper: the only way to a tombstone for new code.
  [HELPER]: [
    "UPDATE rfpilot.document_sources SET status='scan_failed',updated_at=now() WHERE id = ANY($1::uuid[]) AND status='scanning'",
    "UPDATE rfpilot.document_sources SET status='deletion_pending',updated_at=now() WHERE id = ANY($1::uuid[]) AND status = ANY($2::text[])",
    "UPDATE rfpilot.document_sources SET status='deleted',deleted_at=now(),updated_at=now() WHERE id = ANY($1::uuid[]) AND status='deletion_pending' AND deleted_at IS NULL RETURNING id",
  ],
  // The ingestion lifecycle of one document: complete, beginScan, finishScan
  // (ready | blocked | scan_failed, computed from the scan result),
  // requestDeletion, markDeleted (reached only after requestDeletion).
  "src/modules/documentIngestion/postgresDocumentRepository.ts": [
    "UPDATE rfpilot.document_sources SET status='uploaded',updated_at=now() WHERE id=$1",
    "UPDATE rfpilot.document_sources SET status='scanning',updated_at=now() WHERE id=$1",
    "UPDATE rfpilot.document_sources SET status=$2,updated_at=now() WHERE id=$1",
    "UPDATE rfpilot.document_sources SET status='deletion_pending',updated_at=now() WHERE id=$1",
    "UPDATE rfpilot.document_sources SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1",
  ],
  // Vendor response cutover purge: marks `deletion_pending`, then tombstones, in one transaction.
  "scripts/purgeVendorResponses.ts": [
    "UPDATE rfpilot.document_sources SET status='deletion_pending',updated_at=now() WHERE ${sourcePredicate} AND status <> 'deletion_pending'",
    "UPDATE rfpilot.document_sources SET deleted_at=now(),status='deleted',updated_at=now() WHERE ${sourcePredicate} AND status='deletion_pending'",
  ],
  // KNOWN DEFECTS, not models to copy. Both delete the object first and then
  // tombstone a source from whatever status it is in, which the trigger
  // rejects for anything but `deletion_pending`: the same failure permanent
  // delete had. They are pinned to their exact text so the guard is green
  // today; remove each entry when that file uses the helper.
  //   - the retention sweep (only acts with RETENTION_SWEEP_APPLY=true)
  "src/modules/dataFoundation/retentionSweeper.ts": [
    "UPDATE rfpilot.document_sources SET deleted_at=now(),status='deleted',updated_at=now() WHERE id = ANY($1::uuid[])",
  ],
  //   - a planner permanently deleting vendor responses
  "src/modules/vendorResponses/infrastructure/postgres/purgeVendorResponseArtifacts.ts": [
    "UPDATE rfpilot.document_sources SET deleted_at=now(),status='deleted',updated_at=now() WHERE organization_id=$1 AND deleted_at IS NULL AND ( vendor_submission_mongo_id = ANY($2::varchar[]) OR id::text = ANY($3::varchar[]) )",
  ],
};

// String pieces joined with + are read as one string, and whitespace is collapsed.
const normalise = (text) => text.replace(/(["'`])\s*\+\s*(["'`])/g, "").replace(/\s+/g, " ");
// Qualified or not, quoted or not, with or without ONLY and an alias. A
// statement is read twice: to the end of its string (the text that is pinned),
// and on to the next semicolon or backtick, so that a quoted identifier inside
// a single-quoted string ('UPDATE "rfpilot"."document_sources" SET "status"…')
// does not end the reading early. Flagged by the second reading alone, the
// text is whatever was read, which is never on the list: it fails closed.
const TABLE = String.raw`(?:"?rfpilot"?\s*\.\s*)?"?document_sources"?(?![A-Za-z0-9_])`;
const statement = (prefix, rest) => new RegExp(String.raw`\b${prefix}${TABLE}${rest}`, "gi");
const READINGS = [
  [statement(String.raw`UPDATE\s+(?:ONLY\s+)?`, '[^;`"]*'), statement(String.raw`UPDATE\s+(?:ONLY\s+)?`, "[^;`]*")],
  [
    statement(String.raw`INSERT\s+INTO\s+`, String.raw`[^;\`"]*\bDO\s+UPDATE\s+SET\b[^;\`"]*`),
    statement(String.raw`INSERT\s+INTO\s+`, String.raw`[^;\`]*\bDO\s+UPDATE\s+SET\b[^;\`]*`),
  ],
];
const setsStatus = (text) => {
  const assignments = /\bDO\s+UPDATE\s+SET\b/i.test(text)
    ? text.slice(text.search(/\bDO\s+UPDATE\s+SET\b/i))
    : text.split(/\bWHERE\b/i)[0];
  return /\bSET\b.*?(?<![A-Za-z0-9_.])"?status"?\s*=/i.test(assignments);
};
/** Every statement in `text` that writes `status` on document_sources, to any value. */
const statusWrites = (text) => {
  const flat = normalise(text);
  const found = [];
  for (const [strict, permissive] of READINGS) {
    const strictTexts = (flat.match(strict) ?? []).map((match) => match.trim());
    (flat.match(permissive) ?? []).forEach((wide, index) => {
      const narrow = strictTexts[index] ?? "";
      if (setsStatus(narrow)) found.push(narrow);
      else if (setsStatus(wide)) found.push(wide.trim());
    });
  }
  return found;
};

const ROOTS = ["src", "utils", "scripts", "controller", "routes", "middleware", "config", "modal"];

const sourceFiles = (directory) =>
  fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(relative);
    return /\.(ts|js)$/.test(entry.name) ? [relative] : [];
  });

test("every statement that writes a document source's status is one that was reviewed", () => {
  const found = {};
  for (const directory of ROOTS.filter((name) => fs.existsSync(path.join(root, name)))) {
    for (const file of sourceFiles(directory)) {
      const statements = statusWrites(read(file));
      if (statements.length) found[file] = statements;
    }
  }
  assert.deepEqual(
    found,
    ALLOWED,
    `A statement writes status on document_sources that is not listed in this guard. To tombstone a source use ` +
      `markSourcesDeletionPending() and markSourcesDeleted() from ${HELPER}; the trigger rejects any other way to 'deleted'.`,
  );
});

test("the scan sees a status write however it is spelled", () => {
  // Each of these is a way the first version of this guard could be walked past.
  const caught = {
    plain: `client.query("UPDATE rfpilot.document_sources SET deleted_at=now(),status='deleted' WHERE id=$1", [id])`,
    aliased: `client.query("UPDATE rfpilot.document_sources s SET status='deleted' WHERE s.id=$1", [id])`,
    aliasedWithAs: `client.query("UPDATE rfpilot.document_sources AS s SET status='deleted' WHERE s.id=$1", [id])`,
    parameterised: `client.query("UPDATE rfpilot.document_sources SET status=$2,updated_at=now() WHERE id=$1", [id, "deleted"])`,
    concatenated: `client.query("UPDATE rfpilot.document_sources " +\n      "SET deleted_at=now(), " + 'status=$2 ' +\n      "WHERE id=$1", [id, next])`,
    unqualified: `client.query("UPDATE document_sources SET status='deleted' WHERE id=$1", [id])`,
    template: "client.query(`UPDATE rfpilot.document_sources\n   SET status = 'deleted'\n WHERE id = $1`, [id])",
    only: `client.query("UPDATE ONLY rfpilot.document_sources SET status='deleted' WHERE id=$1", [id])`,
    quoted: "client.query('UPDATE \"rfpilot\".\"document_sources\" SET \"status\"=$2 WHERE id=$1', [id, next])",
    lowercase: `client.query("update rfpilot.document_sources set status='deleted' where id=$1", [id])`,
    upsert: `client.query("INSERT INTO rfpilot.document_sources(id,status) VALUES($1,'ready') ON CONFLICT (id) DO UPDATE SET status='deleted'", [id])`,
  };
  for (const [name, code] of Object.entries(caught)) {
    assert.equal(statusWrites(code).length, 1, `${name} is seen`);
  }
  // Not status writes: another column, a status only read in WHERE, another table.
  const ignored = [
    `client.query("UPDATE rfpilot.document_sources SET updated_at=now() WHERE status='ready' AND id=$1", [id])`,
    `client.query("UPDATE rfpilot.document_sources_archive SET status='deleted' WHERE id=$1", [id])`,
    `client.query("UPDATE rfpilot.conversations SET status='archived' WHERE proposal_reference_id=$1", [id])`,
    `client.query("UPDATE rfpilot.document_sources SET scan_status=$2 WHERE id=$1", [id, next])`,
  ];
  for (const code of ignored) assert.deepEqual(statusWrites(code), [], code);
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
  // A failed storage delete skips the source instead of falling through to the
  // tombstone. Only "the object is already gone" (NoSuchKey) passes.
  assert.match(body, /catch \(error\) \{\s+if \(!objectAlreadyGone\(error\)\) \{\s+result\.errorCode \?\?= errorCodeOf\(error\);\s+continue;\s+\}\s+\}\s+\}\s+objectGone\.push\(source\.id\);/);
  assert.match(purge, /const objectAlreadyGone = \(error: unknown\): boolean => \(error as \{ name\?: unknown \} \| null\)\?\.name === "NoSuchKey";/);
});
