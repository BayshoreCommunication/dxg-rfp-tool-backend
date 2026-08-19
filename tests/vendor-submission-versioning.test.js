const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  vendorSubmissionManifestChecksum,
} = require("../src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionRepository");
const {
  governedVendorObjectKey,
  governedVendorObjectUrl,
} = require("../src/modules/vendorResponses/infrastructure/storage/spacesVendorDocumentStorage");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("vendor submission manifest checksum is deterministic and content sensitive", () => {
  const input = {
    proposalId: "507f1f77bcf86cd799439011",
    submissionId: "507f1f77bcf86cd799439012",
    versionNumber: 1,
    reason: "initial",
    vendorName: "Apex AV",
    submittedBy: "Alex",
    email: "alex@apex.example",
    message: "Attached",
    documents: [
      {
        documentId: "8f243bec-7e6d-4d09-b1fc-1a523de93099",
        sourceId: "975f09d6-4260-459c-9fc0-42160a38e884",
        name: "quote.pdf",
        url: "https://private.example/quote.pdf",
        objectKey: "private/quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 123,
        sha256: "a".repeat(64),
        scanStatus: "clean",
      },
    ],
  };
  const first = vendorSubmissionManifestChecksum(input);
  const replay = vendorSubmissionManifestChecksum({ ...input });
  const changed = vendorSubmissionManifestChecksum({ ...input, message: "Revised" });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(replay, first);
  assert.notEqual(changed, first);
});

test("new private vendor objects use the governed document-storage reference", () => {
  const objectKey = "rfp-tool/vendor-responses-private/proposal/sources/source-response.pdf";
  const storedReference = governedVendorObjectUrl(objectKey);
  assert.match(storedReference, /^rfpilot-private:/);
  assert.equal(governedVendorObjectKey(storedReference), objectKey);
  assert.equal(governedVendorObjectKey("https://legacy.example/response.pdf"), null);
});

test("vendor source migration is tenant isolated, version linked, and reversible", () => {
  const up = read("migrations/postgres/044_vendor_submission_sources.up.sql");
  const down = read("migrations/postgres/044_vendor_submission_sources.down.sql");
  for (const required of [
    "vendor_submission",
    "vendor_submission_mongo_id",
    "vendor_submission_version_mongo_id",
    "vendor_document_id",
    "document_sources_vendor_document_idx",
    "skipped",
  ]) {
    assert.ok(up.includes(required), required);
  }
  assert.ok(down.includes("DELETE FROM rfpilot.document_sources WHERE purpose='vendor_submission'"));
  assert.ok(down.includes("ALTER COLUMN uploader_external_user_id SET NOT NULL"));
});

test("source registry stores checksums and scan outcomes without public file URLs", () => {
  const source = read(
    "src/modules/vendorResponses/infrastructure/postgres/postgresVendorSubmissionSourceRegistry.ts",
  );
  for (const required of [
    "set_config('app.organization_mongo_id'",
    "'vendor_submission'",
    "document.sha256",
    "document.scanStatus",
    "vendor_submission.source.register",
  ]) {
    assert.ok(source.includes(required), required);
  }
  assert.ok(!source.includes("document.url,"));
});

test("backfill is dry-run by default, idempotent, journaled, and source-aware", () => {
  const script = read("scripts/backfillVendorSubmissionVersions.ts");
  for (const required of [
    'const apply = args.get("--apply") === "true"',
    "vendor_submission:legacy:",
    "migration_journal",
    "vendor_submission_version_backfill",
    "postgresVendorSubmissionSourceRegistry.register",
  ]) {
    assert.ok(script.includes(required), required);
  }
});

test("public receipt projection never returns stored document URLs", () => {
  const controller = read("controller/vendorResponseController.ts");
  const receipt = controller.slice(controller.indexOf("export const getVendorResponseReceipt"));
  assert.ok(receipt.includes("versionNumber"));
  assert.ok(receipt.includes("manifestChecksum"));
  assert.ok(receipt.includes("scanStatus"));
  assert.ok(!receipt.includes("url: document.url"));
});
