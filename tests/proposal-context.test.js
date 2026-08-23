const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  contextEnabled,
  contextInput,
  PROPOSAL_CONTEXT_INPUT_VERSION,
  ProposalContextError,
} = require("../src/modules/proposalContext/domain");
const {
  deterministicContextCandidate,
} = require("../src/modules/proposalContext/deterministicContextModel");
const {
  validateProposalExtractionPatchV1,
} = require("../contracts/proposal/v1/validators");

test("proposal context accepts only fixed synthetic fixtures", () => {
  assert.equal(PROPOSAL_CONTEXT_INPUT_VERSION, "proposal-context.v2");
  const input = contextInput({ fixture: "synthetic-conference-simple" });
  assert.match(input.inputChecksum, /^[0-9a-f]{64}$/);
  assert.throws(
    () => contextInput({ fixture: "caller-provided-text" }),
    ProposalContextError,
  );
  assert.throws(
    () =>
      contextInput({
        fixture: "synthetic-conference-simple",
        sourceId: "private-document",
      }),
    /not authorized/,
  );
});

test("only the current context epoch can be created, executed, read, or applied", () => {
  const root = path.resolve(__dirname, "..");
  const repository = fs.readFileSync(path.join(root, "src/modules/proposalContext/postgresProposalContextRepository.ts"), "utf8");
  const latest = fs.readFileSync(path.join(root, "src/modules/proposalContext/latestProposalContext.ts"), "utf8");
  const candidates = fs.readFileSync(path.join(root, "src/modules/candidateApplication/postgresCandidateApplicationRepository.ts"), "utf8");
  for (const source of [repository, latest, candidates])
    assert.ok(source.includes("PROPOSAL_CONTEXT_INPUT_VERSION"));
  assert.doesNotMatch(repository, /inputVersion:\s*"proposal-context\.v1"/);
  assert.match(repository, /j\.input_version=\$2|j\.input_version=\$3/);
  assert.match(candidates, /j\.input_version=\$3/);
  assert.ok(candidates.includes("candidate_application:${PROPOSAL_CONTEXT_INPUT_VERSION}:"));
});
test("deterministic proposal context emits canonical cited patches", () => {
  const result = deterministicContextCandidate(
    "507f1f77bcf86cd799439011",
    "synthetic-conference-medium",
  );
  assert.equal("invalid" in result, false);
  if ("invalid" in result) return;
  assert.equal(validateProposalExtractionPatchV1(result.patch), true);
  assert.ok(result.patch.candidates.length > 0);
  for (const candidate of result.patch.candidates) {
    assert.match(candidate.path, /^\/content\//);
    assert.ok(candidate.evidence.length > 0);
    assert.equal(candidate.state, "pending");
  }
  assert.equal(result.evidence.length, result.patch.candidates.length);
});
test("prompt injection fixture is ignored and raised as a blocking issue", () => {
  const result = deterministicContextCandidate(
    "507f1f77bcf86cd799439011",
    "prompt-injection",
  );
  assert.equal("invalid" in result, false);
  if ("invalid" in result) return;
  assert.equal(result.patch.candidates.length, 0);
  assert.equal(result.issues[0].code, "PROMPT_INJECTION_IGNORED");
  assert.equal(result.issues[0].severity, "blocking");
});
test("invalid fixture output fails canonical contract validation", () => {
  const result = deterministicContextCandidate(
    "507f1f77bcf86cd799439011",
    "invalid-output",
  );
  assert.equal("invalid" in result, true);
});
test("proposal context is fail-closed outside mock test execution", () => {
  const saved = {
    node: process.env.NODE_ENV,
    flag: process.env.PROPOSAL_CONTEXT_ENABLED,
    provider: process.env.PROPOSAL_CONTEXT_PROVIDER,
  };
  process.env.NODE_ENV = "production";
  process.env.PROPOSAL_CONTEXT_ENABLED = "true";
  process.env.PROPOSAL_CONTEXT_PROVIDER = "mock";
  assert.equal(contextEnabled(), false);
  process.env.NODE_ENV = "test";
  assert.equal(contextEnabled(), true);
  for (const [k, v] of Object.entries(saved))
    v === undefined ? delete process.env[k] : (process.env[k] = v);
});
test("migration preserves tenant isolation, immutable candidates, and proposal-content separation", () => {
  const root = path.resolve(__dirname, ".."),
    migration = fs.readFileSync(
      path.join(root, "migrations/postgres/009_proposal_context.up.sql"),
      "utf8",
    ),
    repository = fs.readFileSync(
      path.join(
        root,
        "src/modules/proposalContext/postgresProposalContextRepository.ts",
      ),
      "utf8",
    );
  for (const required of [
    "FORCE ROW LEVEL SECURITY",
    "tenant_proposal_context_runs",
    "proposal_context_operations_immutable",
    "proposal_reference_id",
    "output_checksum",
  ])
    assert.ok(migration.includes(required), required);
  assert.match(repository, /proposalMutation:\s*false/);
  assert.equal(repository.includes("mongoose"), false);
});
