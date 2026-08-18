const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, "..");
const {assertLiveAiReady}=require("../src/modules/liveAi/openAiProvider");
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
test("live provider secret remains server-only", (t) => {
  // Cross-repository guard, only enforceable in the multi-repo workspace.
  // CI checks out this repository alone, so skip (never fail) when the
  // sibling repositories are absent.
  const dashboardPath = path.join(root, "../dxg-rfp-tool-dashboard/app/actions/proposalDraft.ts");
  const adminPath = path.join(root, "../dxg-rfp-tool-admin/app/actions/liveAiPilot.ts");
  if (!fs.existsSync(dashboardPath) || !fs.existsSync(adminPath)) {
    t.skip("sibling dashboard/admin repositories are not checked out");
    return;
  }
  const dashboard = fs.readFileSync(dashboardPath, "utf8"),
    admin = fs.readFileSync(adminPath, "utf8");
  assert.equal(dashboard.includes("OPENAI_API_KEY"), false);
  assert.equal(admin.includes("OPENAI_API_KEY"), false);
});
test("proposal-source live AI requires explicit classification and preserves source evidence",()=>{
  const migration=fs.readFileSync(path.join(root,"migrations/postgres/014_live_proposal_sources.up.sql"),"utf8"),repository=fs.readFileSync(path.join(root,"src/modules/proposalContext/postgresProposalContextRepository.ts"),"utf8"),controller=fs.readFileSync(path.join(root,"controller/proposalContextController.ts"),"utf8"),operations=fs.readFileSync(path.join(root,"src/modules/liveAi/operations.ts"),"utf8"),pipeline=fs.readFileSync(path.join(root,"src/modules/liveAi/extractionPipeline.ts"),"utf8");
  assert.ok(migration.includes("source_id uuid REFERENCES rfpilot.document_sources"));
  for(const boundary of ["status='ready'","confidentiality='non_confidential'","proposal_reference_id=$3","deleted_at IS NULL"])assert.ok(repository.includes(boundary),boundary);
  assert.ok(controller.includes("LIVE_AI_PROPOSAL_SOURCE_ENABLED"));
  assert.ok(operations.includes("prepareSourceExtractionEvidence"));
  assert.ok(pipeline.includes("sourceVersionId: `source:${source.sourceId}`"));
  assert.equal(repository.includes("Proposal.update"),false);
});
test("multi-source runs are bounded, tenant isolated, and surface conflicts",()=>{
  const migration=fs.readFileSync(path.join(root,"migrations/postgres/015_multi_source_context.up.sql"),"utf8"),domain=fs.readFileSync(path.join(root,"src/modules/proposalContext/domain.ts"),"utf8"),repository=fs.readFileSync(path.join(root,"src/modules/proposalContext/postgresProposalContextRepository.ts"),"utf8"),pipeline=fs.readFileSync(path.join(root,"src/modules/liveAi/extractionPipeline.ts"),"utf8"),application=fs.readFileSync(path.join(root,"src/modules/candidateApplication/postgresCandidateApplicationRepository.ts"),"utf8");
  assert.ok(migration.includes("FORCE ROW LEVEL SECURITY"));
  assert.ok(migration.includes("UNIQUE(run_id,ordinal)"));
  assert.ok(domain.includes("sourceIds.length>5"));
  assert.ok(repository.includes("proposal_context_run_sources"));
  assert.ok(pipeline.includes("CROSS_SOURCE_CONFLICT"));
  assert.ok(pipeline.includes('severity: "blocking"'));
  assert.ok(application.includes("CONFLICTING_APPLICATION_SELECTION"));
});
test("vendor-confidential AI use has a separate fail-closed authorization gate",()=>{
  const names=["NODE_ENV","AI_ENVIRONMENT","LIVE_AI_PILOT_ENABLED","LIVE_AI_PROVIDER","LIVE_AI_KILL_SWITCH","LIVE_AI_VENDOR_CONFIDENTIAL_ENABLED","OPENAI_API_KEY"];
  const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try{
    process.env.NODE_ENV="test";
    process.env.AI_ENVIRONMENT="test";
    process.env.LIVE_AI_PILOT_ENABLED="true";
    process.env.LIVE_AI_PROVIDER="openai";
    delete process.env.LIVE_AI_KILL_SWITCH;
    delete process.env.LIVE_AI_VENDOR_CONFIDENTIAL_ENABLED;
    process.env.OPENAI_API_KEY="test-placeholder";
    assert.throws(()=>assertLiveAiReady("extractStructured","vendor_confidential"),error=>error.code==="LIVE_AI_CLASSIFICATION_DENIED");
    process.env.LIVE_AI_VENDOR_CONFIDENTIAL_ENABLED="true";
    assert.doesNotThrow(()=>assertLiveAiReady("extractStructured","vendor_confidential"));
  }finally{
    for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
  }
});
