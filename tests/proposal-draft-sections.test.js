const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { DRAFT_SECTION_KEYS, parseSectionKey, parseSectionDecision, ProposalDraftError } = require("../src/modules/proposalDraft/domain");
const { deterministicProposalDraft } = require("../src/modules/proposalDraft/deterministicDraftProvider");

const root = path.join(__dirname, "..");

test("section keys parse strictly", () => {
  for (const key of DRAFT_SECTION_KEYS) assert.equal(parseSectionKey(key), key);
  assert.throws(() => parseSectionKey("budget"), ProposalDraftError);
  assert.throws(() => parseSectionKey(""), ProposalDraftError);
});

test("section decisions are bounded to accepted/rejected with optional short reason", () => {
  assert.deepEqual(parseSectionDecision({ decision: "accepted" }), { decision: "accepted", reason: "" });
  assert.deepEqual(parseSectionDecision({ decision: "rejected", reason: " too generic " }), { decision: "rejected", reason: "too generic" });
  assert.throws(() => parseSectionDecision({ decision: "maybe" }), ProposalDraftError);
  assert.throws(() => parseSectionDecision({ decision: "accepted", reason: "x".repeat(501) }), ProposalDraftError);
});

test("scoped filtering keeps exactly the requested section", () => {
  const draft = deterministicProposalDraft({
    event: { eventName: "Conf", eventFormat: "Hybrid", eventObjectives: "Connect." },
    venueSchedule: { numberOfEventRooms: "4" },
  });
  assert.ok(draft.sections.length > 1);
  const scope = draft.sections[0].key;
  const filtered = draft.sections.filter((section) => section.key === scope);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].key, scope);
});

test("migration 018 adds decisions table, scope column and parent link with RLS", () => {
  const up = fs.readFileSync(path.join(root, "migrations/postgres/018_draft_section_lifecycle.up.sql"), "utf8");
  for (const value of [
    "ADD COLUMN parent_run_id uuid REFERENCES rfpilot.proposal_draft_runs(id)",
    "ADD COLUMN section_scope text",
    "rfpilot.proposal_draft_section_decisions",
    "UNIQUE(run_id,section_key)",
    "decision text NOT NULL CHECK(decision IN('accepted','rejected'))",
    "FORCE ROW LEVEL SECURITY",
    "current_organization_id()",
  ])
    assert.ok(up.includes(value), value);
});

test("live draft narrows the output schema when a section scope is set", () => {
  const source = fs.readFileSync(path.join(root, "src/modules/liveAi/operations.ts"), "utf8");
  assert.ok(source.includes("enum:[scope]"), "scoped schema must restrict the section key enum");
  assert.ok(source.includes("rfpilot_proposal_draft_section"), "scoped runs use a distinct schema name");
  assert.ok(source.includes("Draft only the"), "scoped instructions must target one section");
});

test("regeneration endpoint links parent run and requires completed parent", () => {
  const controller = fs.readFileSync(path.join(root, "controller/proposalDraftController.ts"), "utf8");
  assert.ok(controller.includes("parentRunId"), "parent link required");
  assert.ok(controller.includes("DRAFT_RUN_NOT_REVIEWABLE"), "incomplete parents must be rejected");
  const route = fs.readFileSync(path.join(root, "routes/proposalDraftRoute.ts"), "utf8");
  assert.ok(route.includes("regenerate-jobs"));
  assert.ok(route.includes("sections/:sectionKey/decision"));
});

const readFile = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("draft section keys stay in sync across code, model schema, and database CHECKs", () => {
  // Three-way drift is the exact failure mode this codebase keeps hitting: a
  // limit written when the feature was smaller, surviving into a larger one and
  // failing behind a generic error. A code-only key addition passes request
  // validation and then fails at INSERT against migration 018's CHECK.
  const migration = readFile("migrations/postgres/026_draft_section_coverage.up.sql");
  const constraints = migration.split("ADD CONSTRAINT").slice(1);
  assert.equal(constraints.length, 3, "all section-key CHECKs are widened");
  for (const key of DRAFT_SECTION_KEYS) {
    for (const constraint of constraints) {
      assert.ok(constraint.includes(`'${key}'`), `migration 026 admits ${key}`);
    }
  }

  // The model must only ever be offered keys the API and database accept, so
  // the JSON-schema enum is derived from DRAFT_SECTION_KEYS rather than copied.
  const operations = readFile("src/modules/liveAi/operations.ts");
  assert.ok(
    operations.includes("enum:[...DRAFT_SECTION_KEYS]"),
    "draft schema derives its enum from the shared key list",
  );
  assert.ok(
    operations.includes("maxItems:DRAFT_MAX_SECTIONS"),
    "section cap tracks the database persistence limit",
  );
  assert.ok(operations.includes("validateDraftOutput(result.output)"), "provider output is validated before persistence");

  // The down migration narrows the domain, so it must clear data written under
  // the wider set or the constraints cannot be re-added. Draft results are
  // guarded by BEFORE UPDATE OR DELETE immutability triggers (migration 011)
  // and joined by NOT NULL foreign keys with no ON DELETE CASCADE, so a plain
  // DELETE raises 'proposal draft results are immutable'. The rollback has to
  // suspend those guards and clear dependants innermost-outward.
  const down = readFile("migrations/postgres/026_draft_section_coverage.down.sql");
  for (const trigger of [
    "draft_citations_immutable",
    "draft_paragraphs_immutable",
    "draft_sections_immutable",
  ]) {
    assert.ok(down.includes(`DISABLE TRIGGER ${trigger}`), `rollback suspends ${trigger}`);
    assert.ok(down.includes(`ENABLE TRIGGER ${trigger}`), `rollback restores ${trigger}`);
  }
  assert.ok(
    down.indexOf("DELETE FROM rfpilot.proposal_draft_citations") <
      down.indexOf("DELETE FROM rfpilot.proposal_draft_paragraphs"),
    "citations are cleared before the paragraphs they reference",
  );
  assert.ok(
    down.indexOf("DELETE FROM rfpilot.proposal_draft_paragraphs") <
      down.indexOf("DELETE FROM rfpilot.proposal_draft_sections\n"),
    "paragraphs are cleared before the sections they reference",
  );
  assert.ok(down.includes("DELETE FROM rfpilot.proposal_draft_section_decisions"));
  assert.ok(down.includes("DELETE FROM rfpilot.proposal_draft_sections"));
  assert.ok(down.includes("UPDATE rfpilot.proposal_draft_runs SET section_scope=NULL"));
});

test("draft generation reads every RFP-content proposal section", () => {
  // The draft used to select only event and venueSchedule, so a "full proposal
  // draft" was built from 2 of 12 content sections and could not describe
  // production, rooms, venue technical needs, budget, or procurement dates.
  const repository = readFile("src/modules/proposalDraft/postgresProposalDraftRepository.ts");
  const select = repository.match(/\.select\(\s*"([^"]+)"/)?.[1] ?? "";
  for (const section of [
    "event", "venueSchedule", "roomByRoom", "production", "hybridVirtual",
    "contentCreative", "videoRecordingStep", "venue", "uploads", "budget",
  ]) {
    assert.ok(select.split(/\s+/).includes(section), `draft evidence includes ${section}`);
  }
  // Contact details are personal data the draft prose never needs; keeping them
  // out of the projection keeps them out of the provider payload.
  for (const excluded of ["contact", "additionalContacts"]) {
    assert.ok(!select.split(/\s+/).includes(excluded), `${excluded} stays out of the provider payload`);
  }
});

test("draft worker marks the domain run failed when execution fails", () => {
  const handler = readFile("src/modules/durableJobs/proposalDraftHandler.ts");
  assert.ok(handler.includes("catch (error)"));
  assert.ok(handler.includes("proposalDraftRepository.fail"));
  assert.ok(handler.includes('status: "failed"'));
});
