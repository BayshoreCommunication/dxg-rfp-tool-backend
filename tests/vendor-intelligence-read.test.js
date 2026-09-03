const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("reading a response's current intelligence prefers the newest successful run over a later failed attempt", () => {
  const repository = read("src/modules/vendorIntelligence/postgresVendorIntelligenceRepository.ts");
  // A rerun that fails (provider outage, malformed output) used to become the
  // "current" analysis and blank out a response that was already fully mapped:
  // no facts, no requirement coverage, no stated total. Only fall back to a
  // non-succeeded run when nothing has ever succeeded for that version.
  assert.match(repository, /ORDER BY \(r\.status='succeeded'\) DESC,r\.created_at DESC LIMIT 1/);
  // Reading a specific run by id stays exact, whatever its status.
  assert.match(repository, /WHERE r\.id=\$1 AND r\.proposal_reference_id=\$2 AND r\.vendor_submission_version_mongo_id=\$3`/);
});
