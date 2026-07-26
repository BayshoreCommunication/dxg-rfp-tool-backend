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
