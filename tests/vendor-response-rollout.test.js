require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  configuredVendorResponseFormat,
  resolveVendorStructuredResponseRollout,
} = require("../src/modules/vendorResponses/domain/rollout");

test("unmarked proposals stay on legacy and require both rollout gates", () => {
  assert.equal(configuredVendorResponseFormat(undefined), "legacy_unstructured");
  assert.equal(configuredVendorResponseFormat({}), "legacy_unstructured");
  assert.equal(
    configuredVendorResponseFormat({ vendorResponseFormat: "structured_v1" }),
    "structured_v1",
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

test("format marker backfill is dry-run by default and cannot touch answer stores", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../scripts/backfillVendorResponseFormatMarkers.ts"),
    "utf8",
  );
  assert.match(source, /process\.argv\.includes\("--apply"\)/);
  assert.match(source, /answerRecordsRead: 0/);
  assert.match(source, /answerRecordsChanged: 0/);
  assert.doesNotMatch(source, /VendorResponse(?:Model|\s+from)|VendorSubmissionDraft|VendorSubmissionVersion/);
});
