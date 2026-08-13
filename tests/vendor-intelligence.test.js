const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assignContradictionGroups, validateFacts, validateMappings, VendorIntelligenceError } = require("../src/modules/vendorIntelligence/domain");
const { runVendorFactMappingPipeline } = require("../src/modules/vendorIntelligence/pipeline");
const { factSchemaFor, mappingSchemaFor } = require("../src/modules/vendorIntelligence/openAiVendorFactMappingProvider");

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

test("facts collapse duplicate provider citations before immutable persistence", () => {
  const citations = [
    { fragmentId: fragmentA, role: "supports" },
    { fragmentId: fragmentA, role: "supports" },
    { fragmentId: fragmentA, role: "context" },
  ];
  assert.deepEqual(validateFacts({ facts: [fact({ citations })] }, new Set([fragmentA]))[0].citations, [
    { fragmentId: fragmentA, role: "supports" },
    { fragmentId: fragmentA, role: "context" },
  ]);
});

test("facts retain the first identical provider fact and discard exact duplicates", () => {
  const output = validateFacts({ facts: [fact(), fact()] }, new Set([fragmentA]));
  assert.equal(output.length, 1);
  assert.equal(output[0].factKey, "commercial.total");
});

test("typed facts discard incomplete values without failing valid output", () => {
  const incomplete = fact({ value: { ...fact().value, currency: null } });
  assert.deepEqual(validateFacts({ facts: [incomplete, fact()] }, new Set([fragmentA])), validateFacts({ facts: [fact()] }, new Set([fragmentA])));
});

test("mappings are complete and none cannot carry citations", () => {
  assert.throws(() => validateMappings({ mappings: [] }, new Set([requirement]), new Set([fragmentA])), (error) => error.code === "SCHEMA_VALIDATION_FAILED");
  assert.throws(() => validateMappings({ mappings: [{ requirementId: requirement, relationship: "none", confidence: 0.7, candidateFragmentIds: [fragmentA], ambiguityReasons: [] }] }, new Set([requirement]), new Set([fragmentA])), (error) => error.code === "CITATION_VALIDATION_FAILED");
});

test("provider schemas constrain all cited identities to the current input boundary", () => {
  const factSchema = factSchemaFor([fragmentA, fragmentB]);
  assert.deepEqual(factSchema.properties.facts.items.properties.citations.items.properties.fragmentId.enum, [fragmentA, fragmentB]);
  const mappingSchema = mappingSchemaFor([requirement], [fragmentA]);
  assert.deepEqual(mappingSchema.properties.mappings.items.properties.requirementId.enum, [requirement]);
  assert.deepEqual(mappingSchema.properties.mappings.items.properties.candidateFragmentIds.items.enum, [fragmentA]);
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

test("pipeline bounds fact extraction chunks to fit the structured-output ceiling", async () => {
  const evidence = Array.from({ length: 21 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
    content: `Vendor evidence page ${index + 1}`,
    sourceLabel: "Vendor.pdf",
    locator: { page: index + 1 },
    trustClass: "untrusted_vendor_content",
  }));
  const factChunkSizes = [];
  const provider = {
    extractFacts: async (input) => { factChunkSizes.push(input.evidence.length); return { model: "fixture-model", output: { facts: [] } }; },
    mapRequirements: async () => ({ model: "fixture-model", output: { mappings: [{ requirementId: requirement, relationship: "none", confidence: 0.9, candidateFragmentIds: [], ambiguityReasons: [] }] } }),
  };
  await runVendorFactMappingPipeline({
    requirements: [{ id: requirement, title: "Pricing", text: "Provide total price", kind: "commercial", mandatory: true }],
    evidence,
    provider,
    ledger: { runType: "vendor_requirement_facts", runId: "run-b", organizationId: "org-a" },
  });
  assert.deepEqual(factChunkSizes, [10, 10, 1]);
});

test("migration enforces tenant isolation, immutable outputs, and append-only review", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/postgres/047_requirement_mapping_facts.up.sql"), "utf8");
  for (const table of ["vendor_intelligence_runs", "requirement_evidence_mappings", "extracted_facts", "extracted_fact_evidence", "fact_validation_results", "human_review_events"]) assert.match(migration, new RegExp(`FORCE ROW LEVEL SECURITY;[\\s\\S]*tenant_${table}`));
  assert.match(migration, /human_review_events_immutable/);
  assert.match(migration, /vendor_requirement_facts/);
});
