const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assignContradictionGroups, sourceCoverageWarnings, validateFactCorrectionPayload, validateFacts, validateGroundedFacts, validateMappings, VendorIntelligenceError } = require("../src/modules/vendorIntelligence/domain");
const { runVendorFactMappingPipeline, selectMappingEvidence } = require("../src/modules/vendorIntelligence/pipeline");
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

test("vendor evidence is never mislabeled as non-confidential at the provider boundary", () => {
  const provider = fs.readFileSync(path.join(__dirname, "../src/modules/vendorIntelligence/openAiVendorFactMappingProvider.ts"), "utf8");
  assert.equal(provider.includes('classification: "non_confidential"'), false);
  assert.equal((provider.match(/classification: "vendor_confidential"/g) || []).length, 2);
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

test("explicit numeric facts must contain the claimed value in their cited vendor text", () => {
  const validated = validateFacts({ facts: [fact()] }, new Set([fragmentA]));
  assert.doesNotThrow(() => validateGroundedFacts(validated, new Map([[fragmentA, "The all-inclusive total is USD 148,500."]])));
  assert.throws(
    () => validateGroundedFacts(validated, new Map([[fragmentA, "The all-inclusive total is USD 98,500."]])),
    (error) => error.code === "CITATION_GROUNDING_FAILED",
  );
});

test("explicit facts must match both their typed value and semantic fact type", () => {
  const organizationSize = validateFacts({ facts: [fact({
    factKey: "company.organization_size", family: "company_profile", factType: "organization_size",
    statement: "The organization size is Frank Brewster.", valueKind: "string",
    value: { text: "Frank Brewster", number: null, boolean: null, list: [], currency: null, unit: null, periodStart: null, periodEnd: null },
  })] }, new Set([fragmentA]));
  assert.throws(() => validateGroundedFacts(organizationSize, new Map([[fragmentA, "Salesperson: Frank Brewster"]])), (error) => error.code === "CITATION_GROUNDING_FAILED");
  const validSize = validateFacts({ facts: [fact({
    factKey: "company.organization_size", family: "company_profile", factType: "organization_size",
    statement: "The company has 75 employees.", valueKind: "number",
    value: { text: null, number: 75, boolean: null, list: [], currency: null, unit: "employees", periodStart: null, periodEnd: null },
  })] }, new Set([fragmentA]));
  assert.doesNotThrow(() => validateGroundedFacts(validSize, new Map([[fragmentA, "Our company has 75 full-time employees."]])));
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

test("human fact corrections preserve the extracted value type", () => {
  assert.deepEqual(
    validateFactCorrectionPayload("money", {
      normalizedValue: "USD 125000",
      typedValue: { kind: "money", number: 125000, currency: "USD" },
    }),
    {
      normalizedValue: "USD 125000",
      typedValue: { kind: "money", number: 125000, currency: "USD" },
      currency: "USD",
    },
  );
  assert.throws(
    () => validateFactCorrectionPayload("money", {
      normalizedValue: "USD 125000",
      typedValue: { kind: "string", text: "USD 125000" },
    }),
    (error) => error.code === "REVIEW_CORRECTION_INVALID",
  );
});

test("partial, unavailable, and bounded source coverage remain explicit intelligence warnings", () => {
  const result = sourceCoverageWarnings([
    { status: "succeeded", sourceLabel: "Cover message", warnings: [] },
    { status: "partial", sourceLabel: "Technical.pdf", warnings: [{ code: "PAGE_COVERAGE_INCOMPLETE", message: "Some pages were unreadable." }] },
    { status: "unreadable", sourceLabel: "Pricing.pdf", warnings: [] },
  ], 400, 240);
  assert.deepEqual(result.map((warning) => warning.code), ["PAGE_COVERAGE_INCOMPLETE", "SOURCE_COVERAGE_INCOMPLETE", "SOURCE_UNAVAILABLE", "EVIDENCE_COVERAGE_BOUNDED"]);
  assert.ok(result.every((warning) => warning.sourceLabel || warning.code === "EVIDENCE_COVERAGE_BOUNDED"));
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

test("pipeline safely drops an ungrounded fact and completes omitted mappings as not evidenced", async () => {
  const provider = {
    extractFacts: async () => ({
      model: "fixture-model",
      output: {
        facts: [
          fact(),
          fact({
            factKey: "commercial.unrelated_total",
            statement: "The unrelated total is USD 99,999.",
            value: { ...fact().value, number: 99999 },
          }),
        ],
      },
    }),
    mapRequirements: async () => ({ model: "fixture-model", output: { mappings: [] } }),
  };
  const output = await runVendorFactMappingPipeline({
    requirements: [{ id: requirement, title: "Pricing", text: "Provide total price", kind: "commercial", mandatory: true }],
    evidence: [{ id: fragmentA, content: "The all-inclusive total is USD 148,500.", sourceLabel: "Vendor A.pdf", locator: { page: 2 }, trustClass: "untrusted_vendor_content" }],
    provider,
    ledger: { runType: "vendor_requirement_facts", runId: "run-recovery", organizationId: "org-a" },
  });
  assert.equal(output.facts.length, 1);
  assert.equal(output.facts[0].normalizedValue, "USD 148500");
  assert.deepEqual(output.mappings, [{
    requirementId: requirement,
    relationship: "none",
    confidence: 0,
    candidateFragmentIds: [],
    ambiguityReasons: ["No supported evidence mapping was returned; treated as not evidenced."],
  }]);
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

test("long mapping runs use bounded concurrency and report monotonic durable-job progress", async () => {
  const evidence = Array.from({ length: 41 }, (_, index) => ({
    id: `fragment-${index}`,
    content: `Vendor evidence ${index}`,
    sourceLabel: "Vendor.pdf",
    locator: { page: index + 1 },
    trustClass: "untrusted_vendor_content",
  }));
  const requirements = Array.from({ length: 41 }, (_, index) => ({
    id: `requirement-${index}`,
    title: `Requirement ${index}`,
    text: `Provide requirement ${index}`,
    kind: "technical",
    mandatory: false,
  }));
  let active = 0, maximumActive = 0;
  const work = async (output) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { model: "fixture-model", output };
  };
  const provider = {
    extractFacts: async () => work({ facts: [] }),
    mapRequirements: async (input) => work({ mappings: input.requirements.map((item) => ({
      requirementId: item.id,
      relationship: "none",
      confidence: 0.9,
      candidateFragmentIds: [],
      ambiguityReasons: [],
    })) }),
  };
  const progress = [];
  await runVendorFactMappingPipeline({
    requirements,
    evidence,
    provider,
    ledger: { runType: "vendor_requirement_facts", runId: "run-progress", organizationId: "org-a" },
    onProgress: async (value, stage) => { progress.push({ value, stage }); },
  });
  assert.ok(maximumActive > 1, "independent provider chunks should not run serially");
  assert.ok(maximumActive <= 3, "provider concurrency stays bounded");
  assert.deepEqual(progress.map((item) => item.value), [...progress.map((item) => item.value)].sort((a, b) => a - b));
  assert.equal(progress.at(-1).value, 90);
  assert.ok(progress.some((item) => item.stage === "extracting_vendor_facts"));
  assert.ok(progress.some((item) => item.stage === "mapping_requirements"));
});

test("mapping retrieval reserves lexical evidence for late requirements instead of favoring early requirements", () => {
  const requirements = Array.from({ length: 20 }, (_, index) => ({ id: `r-${index}`, title: `Capability keyword${index}`, text: `Provide keyword${index}`, kind: "technical", mandatory: false }));
  const evidence = requirements.flatMap((requirement, requirementIndex) => Array.from({ length: 5 }, (_, evidenceIndex) => ({
    id: `f-${requirementIndex}-${evidenceIndex}`,
    content: `${requirement.title} is explicitly included in the response.`,
    sourceLabel: `source-${evidenceIndex}.pdf`, locator: { page: requirementIndex + 1 }, trustClass: "untrusted_vendor_content",
  })));
  const selected = selectMappingEvidence(requirements, evidence);
  assert.ok(selected.some((item) => item.id.startsWith("f-19-")));
  assert.ok(selected.length <= 70);
});

test("human mapping corrections can cite only the current extraction attempt", () => {
  const repository = fs.readFileSync(path.join(__dirname, "../src/modules/vendorIntelligence/postgresVendorIntelligenceRepository.ts"), "utf8");
  const reviewBoundary = repository.slice(repository.indexOf("async review("));
  assert.match(reviewBoundary, /DISTINCT ON \(source_kind,coalesce\(vendor_document_id::text,'cover_message'\)\)/);
  assert.match(reviewBoundary, /current_sources s ON s\.effective_id=f\.extraction_run_id/);
});

test("failed vendor intelligence creation requeues its durable job instead of returning a cached failure", () => {
  const repository = fs.readFileSync(path.join(__dirname, "../src/modules/vendorIntelligence/postgresVendorIntelligenceRepository.ts"), "utf8");
  assert.match(repository, /prior\.status === "failed"/);
  assert.match(repository, /status='queued',attempt_count=0/);
  assert.match(repository, /vendor-intelligence\.requeued:/);
  assert.match(repository, /vendor_intelligence\.requeued/);
});

test("vendor mapping failures settle the domain run only after durable retries are exhausted", () => {
  const handler = fs.readFileSync(path.join(__dirname, "../src/modules/durableJobs/vendorIntelligenceHandler.ts"), "utf8");
  assert.doesNotMatch(handler, /vendorIntelligenceRepository\.fail/,
    "a retryable provider failure must not prematurely mark the domain run failed");
  const worker = fs.readFileSync(path.join(__dirname, "../src/modules/durableJobs/worker.ts"), "utf8");
  assert.match(worker, /\["failed", "dead_letter"\]\.includes\(failed\.status\)/,
    "the worker settles the domain run after its durable job is terminal");
  assert.match(worker, /setInterval\(\(\) => \{ void renewLease\(\); \}/,
    "long provider work renews its durable lease periodically");
  const repository = fs.readFileSync(path.join(__dirname, "../src/modules/durableJobs/postgresJobRepository.ts"), "utf8");
  assert.match(repository, /row\.job_type === "vendor_requirement_facts"[\s\S]*vendor_intelligence_runs/,
    "an exhausted stale lease also settles the vendor-intelligence domain run");
});

test("migration enforces tenant isolation, immutable outputs, and append-only review", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/postgres/047_requirement_mapping_facts.up.sql"), "utf8");
  for (const table of ["vendor_intelligence_runs", "requirement_evidence_mappings", "extracted_facts", "extracted_fact_evidence", "fact_validation_results", "human_review_events"]) assert.match(migration, new RegExp(`FORCE ROW LEVEL SECURITY;[\\s\\S]*tenant_${table}`));
  assert.match(migration, /human_review_events_immutable/);
  assert.match(migration, /vendor_requirement_facts/);
});
