const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assignContradictionGroups, validateFacts, validateMappings, VendorIntelligenceError } = require("../src/modules/vendorIntelligence/domain");
const { runVendorFactMappingPipeline } = require("../src/modules/vendorIntelligence/pipeline");

const fragmentA = "00000000-0000-4000-8000-000000000101";
const fragmentB = "00000000-0000-4000-8000-000000000102";
const requirement = "00000000-0000-4000-8000-000000000201";
const fact = (overrides = {}) => ({
  factKey: "commercial.total", family: "commercial", factType: "commercial_total",
  statement: "The stated total is USD 148,500.", valueKind: "money",
  value: { text: null, number: 148500, boolean: null, list: [], currency: "USD", unit: null, periodStart: null, periodEnd: null },
  explicitness: "explicit", confidence: 0.98, citations: [{ fragmentId: fragmentA, role: "supports" }], ...overrides,
});

test("gold fixtures cover native, OCR, contradictions, injection, missing values, and vendor isolation", () => {
  const directory = path.join(__dirname, "fixtures/vendor-intelligence");
  const names = fs.readdirSync(directory).sort();
  assert.deepEqual(names, ["contradictory-totals.json", "missing-values.json", "native-staffing-pricing.json", "prompt-injection.json", "scanned-table.json", "vendor-isolation.json"]);
  names.forEach((name) => assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))));
});

test("facts require in-boundary citations and reject decision language", () => {
  assert.equal(validateFacts({ facts: [fact()] }, new Set([fragmentA]))[0].normalizedValue, "USD 148500");
  assert.throws(() => validateFacts({ facts: [fact({ citations: [{ fragmentId: fragmentB, role: "supports" }] })] }, new Set([fragmentA])), (error) => error instanceof VendorIntelligenceError && error.code === "CITATION_VALIDATION_FAILED");
  assert.throws(() => validateFacts({ facts: [fact({ statement: "Select this vendor as the winner." })] }, new Set([fragmentA])), (error) => error.code === "PROHIBITED_DECISION_LANGUAGE");
});

test("typed facts reject incomplete money values", () => {
  assert.throws(() => validateFacts({ facts: [fact({ value: { ...fact().value, currency: null } })] }, new Set([fragmentA])), (error) => error.code === "SCHEMA_VALIDATION_FAILED");
});

test("mappings are complete and none cannot carry citations", () => {
  assert.throws(() => validateMappings({ mappings: [] }, new Set([requirement]), new Set([fragmentA])), (error) => error.code === "SCHEMA_VALIDATION_FAILED");
  assert.throws(() => validateMappings({ mappings: [{ requirementId: requirement, relationship: "none", confidence: 0.7, candidateFragmentIds: [fragmentA], ambiguityReasons: [] }] }, new Set([requirement]), new Set([fragmentA])), (error) => error.code === "CITATION_VALIDATION_FAILED");
});

test("conflicting normalized values receive the same deterministic contradiction group", () => {
  const output = assignContradictionGroups([{ factKey: "commercial.total", normalizedValue: "USD 120000" }, { factKey: "commercial.total", normalizedValue: "USD 128000" }]);
  assert.match(output[0].contradictionGroup, /^contradiction:[0-9a-f]{16}$/);
  assert.equal(output[0].contradictionGroup, output[1].contradictionGroup);
});

test("pipeline sends only the supplied vendor evidence and ledgers stable phases", async () => {
  const seen = [];
  const provider = {
    extractFacts: async (input) => { seen.push({ phase: input.phase, ids: input.evidence.map((row) => row.id), ledger: input.ledger }); return { model: "fixture-model", output: { facts: [fact()] } }; },
    mapRequirements: async (input) => { seen.push({ phase: input.phase, ids: input.evidence.map((row) => row.id), ledger: input.ledger }); return { model: "fixture-model", output: { mappings: [{ requirementId: requirement, relationship: "supports", confidence: 0.9, candidateFragmentIds: [fragmentA], ambiguityReasons: [] }] } }; },
  };
  const output = await runVendorFactMappingPipeline({ requirements: [{ id: requirement, title: "Pricing", text: "Provide total price", kind: "commercial", mandatory: true }], evidence: [{ id: fragmentA, content: "Total price USD 148,500", sourceLabel: "Vendor A.pdf", locator: { page: 2 }, trustClass: "untrusted_vendor_content" }], provider, ledger: { runType: "vendor_requirement_facts", runId: "run-a", organizationId: "org-a" } });
  assert.equal(output.facts.length, 1); assert.equal(output.mappings.length, 1);
  assert.deepEqual(seen.map((call) => call.ids), [[fragmentA], [fragmentA]]);
  assert.deepEqual(seen.map((call) => call.phase), ["facts:1", "mappings:1"]);
  assert.ok(seen.every((call) => call.ledger.runId === "run-a"));
});

test("migration enforces tenant isolation, immutable outputs, and append-only review", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/postgres/047_requirement_mapping_facts.up.sql"), "utf8");
  for (const table of ["vendor_intelligence_runs", "requirement_evidence_mappings", "extracted_facts", "extracted_fact_evidence", "fact_validation_results", "human_review_events"]) assert.match(migration, new RegExp(`FORCE ROW LEVEL SECURITY;[\\s\\S]*tenant_${table}`));
  assert.match(migration, /human_review_events_immutable/);
  assert.match(migration, /vendor_requirement_facts/);
});
