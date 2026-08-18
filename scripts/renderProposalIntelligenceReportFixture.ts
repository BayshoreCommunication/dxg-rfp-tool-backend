import fs from "node:fs";
import path from "node:path";
import { buildProposalIntelligenceReport } from "../src/modules/proposalIntelligenceOperations/reportBuilder";

const runId = "019ff44e-6fd9-7450-98a7-3ba8e912e61a";
const participants = ["Northstar AV", "Civic Events", "Summit Production"].map((vendorLabel, index) => ({
  participantId: `participant-${index + 1}`,
  vendorLabel,
  versionId: `version-${index + 1}`,
}));

const workspace = {
  run: { runId, status: "succeeded", createdAt: "2026-08-13T00:00:00.000Z", completedAt: "2026-08-13T00:10:00.000Z" },
  freshness: { state: "current", reasons: [] },
  manifest: { checksum: "a".repeat(64), requirementSetVersion: 3, evaluationMatrixVersion: 2, policies: { extraction: "v1", assessment: "v1", commercial: "v1", scoring: "v1" } },
  participants,
  intelligence: {
    permissions: { viewCommercial: true },
    overview: { responseCount: 3, approvedRequirementCount: 12, mandatoryGapCount: 3, unresolvedReviewCount: 3 },
    requirements: [],
    commercial: participants.map((participant, index) => ({ participantId: participant.participantId, vendorLabel: participant.vendorLabel, submittedTotal: 95_000 + (index * 12_000), submittedCurrency: "USD", comparable: index !== 2, normalizedTotal: index === 2 ? null : 98_000 + (index * 10_000), normalizedCurrency: index === 2 ? null : "USD", refusalCodes: index === 2 ? ["UNRESOLVED_OPTIONS"] : [], policyVersion: "v1" })),
    risks: Array.from({ length: 10 }, (_, index) => ({ vendorLabel: participants[index % participants.length]?.vendorLabel, severity: index % 3 === 0 ? "high" : "medium", category: "mandatory_gap", title: `Review risk ${index + 1}`, basis: "The persisted evidence requires procurement review before a human decision is recorded.", question: `Please clarify requirement ${index + 1} and provide a cited response.` })),
    evaluation: participants.map((participant, index) => ({ participantId: participant.participantId, vendorLabel: participant.vendorLabel, weightedContributionTotal: 60 + (index * 5), submittedScores: 8, completedEvaluatorCount: 2, evaluatorCount: 3, conflictCount: 0 })),
    decisions: [{ decisionType: "shortlist", selectedParticipantIds: [participants[0]?.participantId, participants[1]?.participantId], rationale: "The committee advanced two vendors for final review after inspecting the frozen evidence and commercial assumptions.", staleAcknowledged: false, createdAt: "2026-08-13T01:00:00.000Z" }],
  },
};

const clarifications = [{ setVersion: 1, status: "approved", contentChecksum: "b".repeat(64), questions: Array.from({ length: 8 }, (_, index) => ({ vendorLabel: participants[index % participants.length]?.vendorLabel, disposition: "included", question: `Confirm the proposed approach for clarification item ${index + 1}.` })) }];

const main = async () => {
  const report = await buildProposalIntelligenceReport({ reportType: "executive_pdf", proposalTitle: "Grantmakers In Health Annual Conference", workspace, clarifications, audit: { events: [] } });
  const outputDir = path.resolve("tmp/pdfs/task10-render");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "proposal-intelligence-acceptance.pdf");
  fs.writeFileSync(outputPath, report.body);
  console.log(JSON.stringify({ outputPath, filename: report.filename, bytes: report.body.length, checksum: report.contentChecksum }));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
