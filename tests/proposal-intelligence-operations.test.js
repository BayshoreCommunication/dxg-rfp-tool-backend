const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ExcelJS = require("exceljs");
const { PDFDocument } = require("pdf-lib");
const { buildProposalIntelligenceReport } = require("../src/modules/proposalIntelligenceOperations/reportBuilder");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const workspace = (viewCommercial = true) => ({
  run: { runId: "019ff44e-6fd9-7450-98a7-3ba8e912e61a", status: "succeeded", createdAt: "2026-08-12T00:00:00.000Z", completedAt: "2026-08-12T00:10:00.000Z" },
  freshness: { state: "current", reasons: [] },
  manifest: { checksum: "a".repeat(64), requirementSetVersion: 2, evaluationMatrixVersion: 1, policies: { extraction: "v1", assessment: "v1", commercial: "v1", scoring: "v1" } },
  participants: [{ participantId: "p1", vendorLabel: "Vendor One", versionId: "v1" }, { participantId: "p2", vendorLabel: "Vendor Two", versionId: "v2" }],
  intelligence: {
    permissions: { viewCommercial }, overview: { responseCount: 2, approvedRequirementCount: 1, mandatoryGapCount: 1, unresolvedReviewCount: 1 },
    requirements: [{ title: "Provide plenary audio", kind: "technical", mandatoryStatus: "mandatory", vendors: [{ participantId: "p1", vendorLabel: "Vendor One", verdict: "addressed", needsHumanReview: false, rationale: "A cited audio plan was supplied.", evidence: [{ sourceLabel: "response.pdf", locator: { page: 4 } }] }, { participantId: "p2", vendorLabel: "Vendor Two", verdict: "missing", needsHumanReview: true, rationale: "No cited audio plan was supplied.", evidence: [] }] }],
    commercial: viewCommercial ? [{ participantId: "p1", vendorLabel: "Vendor One", submittedTotal: 100000, submittedCurrency: "USD", comparable: true, normalizedTotal: 100000, normalizedCurrency: "USD", refusalCodes: [], policyVersion: "v1" }, { participantId: "p2", vendorLabel: "Vendor Two", submittedTotal: 90000, submittedCurrency: "USD", comparable: false, normalizedTotal: null, normalizedCurrency: null, refusalCodes: ["UNRESOLVED_OPTIONS"], policyVersion: "v1" }] : [],
    risks: [{ vendorLabel: "Vendor Two", severity: "high", category: "mandatory_gap", title: "Plenary audio gap", basis: "The mandatory requirement is missing.", question: "Confirm the plenary audio plan." }],
    evaluation: [{ participantId: "p1", vendorLabel: "Vendor One", weightedContributionTotal: 72, submittedScores: 3, completedEvaluatorCount: 1, evaluatorCount: 2, conflictCount: 0 }, { participantId: "p2", vendorLabel: "Vendor Two", weightedContributionTotal: 68, submittedScores: 3, completedEvaluatorCount: 1, evaluatorCount: 2, conflictCount: 0 }],
    decisions: [{ decisionType: "shortlist", selectedParticipantIds: ["p1", "p2"], rationale: "Both vendors advance for final human review.", staleAcknowledged: false, createdAt: "2026-08-12T01:00:00.000Z" }],
  },
});
const clarifications = [{ setVersion: 1, status: "approved", contentChecksum: "b".repeat(64), questions: [{ vendorLabel: "Vendor Two", disposition: "included", question: "Confirm the plenary audio plan." }] }];
const audit = { events: [{ occurred_at: "2026-08-12T00:00:00.000Z", action: "comparison.created", decision: "allow", correlation_id: "correlation" }] };

test("operations migration is tenant isolated, hold aware, and append only", () => {
  const up = read("migrations/postgres/051_proposal_intelligence_operations.up.sql"), down = read("migrations/postgres/051_proposal_intelligence_operations.down.sql");
  for (const table of ["proposal_intelligence_retention_policies", "proposal_intelligence_legal_hold_events", "comparison_clarification_sets", "comparison_clarification_questions", "comparison_clarification_events", "comparison_report_exports"])
    assert.match(up, new RegExp(`CREATE TABLE rfpilot\\.${table}`));
  assert.match(up, /FORCE ROW LEVEL SECURITY/);
  assert.match(up, /comparison_report_exports_immutable/);
  assert.match(up, /approved clarification questions are immutable/);
  assert.match(down, /DROP TABLE IF EXISTS rfpilot\.proposal_intelligence_retention_policies/);
});

test("operations routes separate authorized reads, writes, and report downloads", () => {
  const routes = read("routes/comparisonOrchestrationRoute.ts"), controller = read("controller/proposalIntelligenceOperationsController.ts");
  for (const route of ["/audit", "/operations", "/clarification-sets", "/reports/:reportType", "/governance/retention-policy", "/governance/legal-holds"])
    assert.match(routes, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(routes, /authorizeAction\("proposal:read"\)/);
  assert.match(routes, /authorizeAction\("proposal:write"\)/);
  assert.match(routes, /governance\/retention-policy`[^\n]+authorizeAction\("organization:manage"\)/);
  assert.match(controller, /REPORT_TYPES|Content-Disposition/);
  assert.doesNotMatch(controller, /sendEmail|nodemailer|awardVendor|recommendedWinner/);
});

test("executive PDF contains multiple polished pages and frozen provenance", async () => {
  const report = await buildProposalIntelligenceReport({ reportType: "executive_pdf", proposalTitle: "GIH Annual Conference", workspace: workspace(), clarifications, audit });
  assert.equal(report.mediaType, "application/pdf");
  assert.equal(report.body.subarray(0, 5).toString(), "%PDF-");
  assert.equal(report.contentChecksum.length, 64);
  assert.equal(report.reportManifest.manifestChecksum, "a".repeat(64));
  const pdf = await PDFDocument.load(report.body);
  assert.ok(pdf.getPageCount() >= 1);
});

test("comparison workbook carries full matrix and omits sealed commercial values", async () => {
  const open = await buildProposalIntelligenceReport({ reportType: "comparison_xlsx", proposalTitle: "GIH Annual Conference", workspace: workspace(), clarifications, audit });
  const openBook = new ExcelJS.Workbook(); await openBook.xlsx.load(open.body);
  assert.ok(openBook.getWorksheet("Requirements")); assert.ok(openBook.getWorksheet("Commercial")); assert.ok(openBook.getWorksheet("Manifest"));
  const sealed = await buildProposalIntelligenceReport({ reportType: "comparison_xlsx", proposalTitle: "GIH Annual Conference", workspace: workspace(false), clarifications, audit });
  const sealedBook = new ExcelJS.Workbook(); await sealedBook.xlsx.load(sealed.body);
  assert.equal(sealedBook.getWorksheet("Commercial"), undefined);
});

test("HTML report escapes persisted content and never introduces a winner", async () => {
  const unsafe = workspace(); unsafe.intelligence.risks[0].title = "<script>alert(1)</script>";
  const report = await buildProposalIntelligenceReport({ reportType: "executive_html", proposalTitle: "GIH Annual Conference", workspace: unsafe, clarifications, audit });
  const html = report.body.toString();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Report provenance/);
  assert.match(html, /does not rank vendors or recommend an award/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /recommended winner|award recommendation/i);
});

test("clarification dispatch is record-only and governance does not delete procurement records", () => {
  const repository = read("src/modules/proposalIntelligenceOperations/postgresProposalIntelligenceOperationsRepository.ts");
  assert.match(repository, /dispatch_recorded/);
  assert.match(repository, /externalReference/);
  assert.match(repository, /comparison\.legal_hold\.placed/);
  assert.doesNotMatch(repository, /DELETE FROM rfpilot\.(comparison|proposal_intelligence)/i);
  assert.doesNotMatch(repository, /sendEmail|nodemailer/);
});

test("real GIH asset acceptance fixture is checksum-bound and defines release thresholds", () => {
  const fixture = JSON.parse(read("tests/fixtures/proposal-intelligence/gih-real-assets.json"));
  assert.equal(fixture.schemaVersion, "proposal-intelligence-gold.v1");
  assert.equal(fixture.sourceContentCommitted, false);
  assert.equal(fixture.sources.length, 3);
  assert.equal(fixture.sources.filter((source) => source.role === "rfp").length, 1);
  assert.equal(fixture.sources.filter((source) => source.role === "vendor_response").length, 2);
  for (const source of fixture.sources) {
    assert.match(source.filename, /\.pdf$/i);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.pages > 0);
    assert.ok(source.bytes > 0);
  }
  assert.ok(fixture.expectedRfpSignals.responseRequirements.includes("detailed_line_item_costs_and_budget_narrative"));
  assert.ok(fixture.expectedRfpSignals.responseRequirements.includes("staffing_team_and_resumes"));
  assert.equal(fixture.releaseThresholds.mandatory_assessment_citation_rate, 1);
  assert.equal(fixture.releaseThresholds.cross_vendor_contamination_count_max, 0);
  assert.equal(fixture.releaseThresholds.sealed_price_leakage_count_max, 0);
  assert.equal(fixture.releaseThresholds.unsupported_winner_language_count_max, 0);
});
