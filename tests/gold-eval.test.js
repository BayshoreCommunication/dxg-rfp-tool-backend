const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { activeCandidatePaths, approvedCandidatePaths, normalizeCandidate } = require("../src/modules/candidateApplication/canonicalMapping");

const fixtureDir = path.join(__dirname, "..", "docs", "testing", "gold-fixtures");
const fixtureFiles = fs.readdirSync(fixtureDir).filter((file) => file.endsWith(".json") && file !== "last-run.json").sort();
const fixtures = fixtureFiles.map((file) => ({ file, ...JSON.parse(fs.readFileSync(path.join(fixtureDir, file), "utf8")) }));

// Mirrors the eventFormat post-processing in liveRequirementExtraction/goldEval.ts.
const canonicalEventFormat = (value) => {
  const key = String(value).trim().toLowerCase().replace(/[_-]+/g, " ");
  return key.includes("hybrid") ? "Hybrid" : key.includes("virtual") ? "Virtual" : key.includes("in person") || key.includes("inperson") ? "In-Person" : value;
};
const containsForbidden = (value, forbidden) => forbidden.some((fragment) => String(value).toLowerCase().includes(String(fragment).toLowerCase()));

test("at least 6 gold fixtures exist", () => {
  assert.ok(fixtures.length >= 6, `expected at least 6 gold fixtures, found ${fixtures.length}`);
});

test("every gold fixture has a valid shape", () => {
  for (const fixture of fixtures) {
    assert.equal(typeof fixture.name, "string", `${fixture.file}: name must be a string`);
    assert.ok(fixture.name.trim(), `${fixture.file}: name must be non-empty`);
    assert.equal(typeof fixture.description, "string", `${fixture.file}: description must be a string`);
    assert.ok(fixture.description.trim(), `${fixture.file}: description must be non-empty`);
    assert.ok(Array.isArray(fixture.evidence) && fixture.evidence.length, `${fixture.file}: evidence must be a non-empty array`);
    for (const item of fixture.evidence) {
      assert.equal(typeof item.id, "string", `${fixture.file}: evidence id must be a string`);
      assert.ok(item.id, `${fixture.file}: evidence id must be non-empty`);
      assert.equal(typeof item.text, "string", `${fixture.file}: evidence text must be a string`);
      assert.ok(item.text, `${fixture.file}: evidence text must be non-empty`);
    }
    assert.equal(new Set(fixture.evidence.map((item) => item.id)).size, fixture.evidence.length, `${fixture.file}: evidence ids must be unique`);
    assert.ok(fixture.expected && Array.isArray(fixture.expected.candidates), `${fixture.file}: expected.candidates must be an array`);
    assert.equal(fixture.expected.allowAdditional, false, `${fixture.file}: expected.allowAdditional must be false`);
    for (const candidate of fixture.expected.candidates) {
      assert.equal(typeof candidate.path, "string", `${fixture.file}: candidate path must be a string`);
      assert.equal(typeof candidate.value, "string", `${fixture.file}: candidate value must be a string`);
    }
  }
});

test("every expected path is in approvedCandidatePaths and every expected value survives normalizeCandidate", () => {
  for (const fixture of fixtures) {
    for (const candidate of fixture.expected.candidates) {
      assert.ok(approvedCandidatePaths.includes(candidate.path), `${fixture.file}: ${candidate.path} is not an approved candidate path`);
      const prepared = candidate.path === "/content/event/eventFormat" ? canonicalEventFormat(candidate.value) : candidate.value;
      assert.doesNotThrow(() => normalizeCandidate(candidate.path, prepared), `${fixture.file}: normalizeCandidate rejected ${candidate.path}=${JSON.stringify(candidate.value)}`);
    }
  }
});

test("dormant recording expectations remain documented but are not active predictions", () => {
  const documented = fixtures.flatMap((fixture) => fixture.expected.candidates);
  assert.ok(documented.some((candidate) => candidate.path.startsWith("/content/videoRecordingStep/")));
  assert.ok(!activeCandidatePaths.some((candidatePath) => candidatePath.startsWith("/content/videoRecordingStep/")));
  const harness = fs.readFileSync(path.join(__dirname, "..", "scripts", "goldEval.ts"), "utf8");
  assert.ok(harness.includes("activeExpectedCandidates"));
});

test("the prompt-injection fixture exists and its expectations exclude the injected content", () => {
  const injectionFixtures = fixtures.filter((fixture) => fixture.injection === true);
  assert.ok(injectionFixtures.length >= 1, "a prompt-injection fixture (injection: true) is required");
  for (const fixture of injectionFixtures) {
    assert.ok(Array.isArray(fixture.forbiddenSubstrings) && fixture.forbiddenSubstrings.length, `${fixture.file}: injection fixture must declare forbiddenSubstrings`);
    assert.ok(fixture.evidence.some((item) => containsForbidden(item.text, fixture.forbiddenSubstrings)), `${fixture.file}: injection fixture evidence must actually contain the forbidden content`);
    for (const candidate of fixture.expected.candidates) {
      assert.ok(!containsForbidden(candidate.value, fixture.forbiddenSubstrings), `${fixture.file}: expected candidate ${candidate.path} leaks injected content`);
    }
  }
});

test("a conflicting-evidence fixture and an empty/no-facts fixture exist", () => {
  const conflictFixtures = fixtures.filter((fixture) => fixture.expectConflict === true);
  assert.ok(conflictFixtures.length >= 1, "a conflicting-evidence fixture (expectConflict: true) is required");
  for (const fixture of conflictFixtures) {
    const paths = fixture.expected.candidates.map((candidate) => candidate.path);
    assert.ok(new Set(paths).size < paths.length, `${fixture.file}: expectConflict fixture must expect two candidates for at least one path`);
  }
  assert.ok(fixtures.some((fixture) => fixture.expected.candidates.length === 0), "an empty/no-facts fixture with zero expected candidates is required");
});

test("goldEval.ts enforces all six DXG release thresholds and guards live mode", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "goldEval.ts"), "utf8");
  const requiredLiterals = [
    "SCHEMA_VALIDITY_REQUIRED = 1",
    "CITATION_VALIDITY_REQUIRED = 1",
    "PRECISION_THRESHOLD = 0.9",
    "RECALL_THRESHOLD = 0.9",
    "FABRICATION_LIMIT = 0",
    "P95_LATENCY_LIMIT_MS = 60_000",
  ];
  for (const literal of requiredLiterals) assert.ok(source.includes(literal), `goldEval.ts must declare threshold: ${literal}`);
  for (const name of ["schemaValidity >= SCHEMA_VALIDITY_REQUIRED", "citationValidity >= CITATION_VALIDITY_REQUIRED", "precision >= PRECISION_THRESHOLD", "recall >= RECALL_THRESHOLD", "fabrications <= FABRICATION_LIMIT", "p95LatencyMs <= P95_LATENCY_LIMIT_MS"]) {
    assert.ok(source.includes(name), `goldEval.ts must enforce: ${name}`);
  }
  for (const guard of ["--live", "aiRuntimeAuthorized", "LIVE_AI_PILOT_ENABLED", "LIVE_AI_SYNTHETIC_ENABLED", "OPENAI_API_KEY", "LIVE_AI_KILL_SWITCH"]) {
    assert.ok(source.includes(guard), `goldEval.ts must guard live mode with: ${guard}`);
  }
});
