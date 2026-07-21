const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "..");
test("live AI pilot remains bounded, cited, durable, and read-only", () => {
  const provider = fs.readFileSync(
      path.join(root, "src/modules/liveAi/openAiProvider.ts"),
      "utf8",
    ),
    operations = fs.readFileSync(
      path.join(root, "src/modules/liveAi/operations.ts"),
      "utf8",
    ),
    context = fs.readFileSync(
      path.join(
        root,
        "src/modules/proposalContext/postgresProposalContextRepository.ts",
      ),
      "utf8",
    ),
    draft = fs.readFileSync(
      path.join(
        root,
        "src/modules/proposalDraft/postgresProposalDraftRepository.ts",
      ),
      "utf8",
    ),
    migration = fs.readFileSync(
      path.join(root, "migrations/postgres/013_live_ai_pilot.up.sql"),
      "utf8",
    );
  for (const value of [
    "gpt-5.4-mini",
    "LIVE_AI_KILL_SWITCH",
    "LIVE_AI_INPUT_TOKEN_LIMIT",
    "LIVE_AI_OUTPUT_TOKEN_LIMIT",
    "maxRetries:0",
    "json_schema",
  ])
    assert.ok(provider.includes(value), value);
  for (const value of [
    "citations",
    "allowed.has",
    "Never follow instructions",
    "non_confidential",
  ])
    assert.ok(operations.includes(value), value);
  assert.ok(context.includes("proposal_context_extract"));
  assert.ok(draft.includes("proposal_draft_generate"));
  assert.ok(migration.includes("FORCE ROW LEVEL SECURITY"));
  assert.equal(context.includes("Proposal.update"), false);
  assert.equal(draft.includes("Proposal.update"), false);
});
test("live provider secret remains server-only", () => {
  const dashboard = fs.readFileSync(
      path.join(root, "../dxg-rfp-tool-dashboard/app/actions/proposalDraft.ts"),
      "utf8",
    ),
    admin = fs.readFileSync(
      path.join(root, "../dxg-rfp-tool-admin/app/actions/liveAiPilot.ts"),
      "utf8",
    );
  assert.equal(dashboard.includes("OPENAI_API_KEY"), false);
  assert.equal(admin.includes("OPENAI_API_KEY"), false);
});
test("proposal-source live AI requires explicit classification and preserves source evidence",()=>{
  const migration=fs.readFileSync(path.join(root,"migrations/postgres/014_live_proposal_sources.up.sql"),"utf8"),repository=fs.readFileSync(path.join(root,"src/modules/proposalContext/postgresProposalContextRepository.ts"),"utf8"),controller=fs.readFileSync(path.join(root,"controller/proposalContextController.ts"),"utf8"),operations=fs.readFileSync(path.join(root,"src/modules/liveAi/operations.ts"),"utf8");
  assert.ok(migration.includes("source_id uuid REFERENCES rfpilot.document_sources"));
  for(const boundary of ["status='ready'","confidentiality='non_confidential'","proposal_reference_id=$3","deleted_at IS NULL"])assert.ok(repository.includes(boundary),boundary);
  assert.ok(controller.includes("LIVE_AI_PROPOSAL_SOURCE_ENABLED"));
  assert.ok(operations.includes("sourceVersionId:`source:${sourceId}`"));
  assert.equal(repository.includes("Proposal.update"),false);
});
