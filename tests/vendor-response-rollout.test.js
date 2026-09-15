require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  configuredVendorResponseFormat,
  resolveVendorStructuredResponseRollout,
} = require("../src/modules/vendorResponses/domain/rollout");

test("new proposals default to structured while explicit rollback markers remain fail-safe", () => {
  assert.equal(configuredVendorResponseFormat(undefined), "structured_v1");
  assert.equal(configuredVendorResponseFormat({}), "structured_v1");
  assert.equal(
    configuredVendorResponseFormat({ vendorResponseFormat: "structured_v1" }),
    "structured_v1",
  );
  assert.equal(
    configuredVendorResponseFormat({ vendorResponseFormat: "legacy_unstructured" }),
    "legacy_unstructured",
  );
  assert.deepEqual(resolveVendorStructuredResponseRollout("structured_v1", false), {
    structuredResponse: false,
    responseFormat: "legacy_unstructured",
    reason: "global_flag_disabled",
  });
  assert.deepEqual(resolveVendorStructuredResponseRollout("legacy_unstructured", true), {
    structuredResponse: false,
    responseFormat: "legacy_unstructured",
    reason: "proposal_not_enabled",
  });
  assert.deepEqual(resolveVendorStructuredResponseRollout("structured_v1", true), {
    structuredResponse: true,
    responseFormat: "structured_v1",
    reason: "enabled",
  });
});

test("the retired public legacy submission endpoints are not registered", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../routes/vendorResponseRoute.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /router\.get\(\s*"\/check"/);
  assert.doesNotMatch(source, /router\.post\(\s*"\/"/);
});

test("format marker backfill is dry-run by default and cannot touch answer stores", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../scripts/backfillVendorResponseFormatMarkers.ts"),
    "utf8",
  );
  assert.match(source, /process\.argv\.includes\("--apply"\)/);
  assert.match(source, /answerRecordsRead: 0/);
  assert.match(source, /answerRecordsChanged: 0/);
  assert.match(source, /vendorResponseFormat: "structured_v1"/);
  assert.doesNotMatch(source, /VendorResponse(?:Model|\s+from)|VendorSubmissionDraft|VendorSubmissionVersion/);
});

test("production purge is dry-run by default and requires two destructive gates", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../scripts/purgeVendorResponses.ts"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.join(__dirname, "../.github/workflows/purge-production-vendor-responses.yml"),
    "utf8",
  );
  assert.match(source, /process\.argv\.includes\("--apply"\)/);
  assert.match(source, /process\.env\.NODE_ENV !== "production"/);
  assert.match(source, /DELETE_ALL_VENDOR_RESPONSES/);
  assert.match(source, /externalDocumentsWithoutCurrentKey > 0/);
  assert.match(source, /legal_hold/);
  assert.match(source, /retention_until > now\(\)/);
  const deletionPending = source.indexOf("SET status='deletion_pending'");
  const deleted = source.indexOf("SET deleted_at=now(),status='deleted'");
  assert.ok(deletionPending >= 0 && deleted > deletionPending);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /Assume production deploy role via OIDC/);
  assert.match(workflow, /DELETE_ALL_VENDOR_RESPONSES/);
  assert.match(workflow, /select\(startswith\("\{\\"phase\\":"\)\)/);
});
