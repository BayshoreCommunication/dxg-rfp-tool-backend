const assert = require("node:assert/strict");
const test = require("node:test");

const {
  structuredProvenanceFragments,
} = require("../src/modules/vendorResponses/infrastructure/postgres/postgresVendorSubmissionSourceRegistry");
const {
  renderVendorResponsePrintHtml,
  vendorResponseExportPayload,
} = require("../src/modules/vendorResponses/application/vendorResponseExport");

const structuredRecord = {
  submissionId: "submission-1",
  versionId: "version-2",
  versionNumber: 2,
  manifestChecksum: "a".repeat(64),
  receivedAt: "2026-09-14T10:00:00.000Z",
  proposalId: "proposal-1",
  proposalTitle: "Annual Summit",
  vendorName: "Northstar AV",
  submittedBy: "Jordan Lee",
  email: "jordan@example.com",
  message: "",
  documents: [{
    documentId: "document-1",
    sourceId: "source-1",
    name: "pricing.pdf",
    url: "https://private.example.invalid/pricing.pdf",
    mimeType: "application/pdf",
    sizeBytes: 100,
    sha256: "b".repeat(64),
    scanStatus: "clean",
    purposeId: "pricing",
    scopeType: "proposal",
    scopeId: null,
    versionDisposition: "added",
    inheritedFromVersionId: null,
  }],
  retiredDocuments: [],
  questionnaire: {
    questionnaireId: "questionnaire-1",
    questionnaireVersion: 3,
    questionnaireChecksum: "c".repeat(64),
    proposalVersion: 4,
  },
  questionnaireSnapshot: {
    context: { currency: "USD", decimalPrecision: 2 },
    rooms: [{ roomId: "ballroom", name: "Ballroom", specs: [{ specId: "screens", label: "Screens", requirementText: "Two screens" }] }],
    crew: { roles: [] },
    documents: { categories: [{ purposeId: "pricing", label: "Pricing" }] },
    acknowledgements: [],
  },
  structuredResponse: {
    schemaVersion: "vendor-response.v1",
    identity: { vendorName: "Northstar AV" },
    rooms: [{
      roomId: "ballroom",
      specResponses: [{ specId: "screens", status: "comply", note: "Included" }],
      equipmentLines: [],
      laborLines: [],
    }],
    acknowledgements: [],
    crew: [],
    travel: { lodgingRequests: [] },
    pricing: { assumptionsExclusions: [] },
    alternates: [],
    references: [],
    valueAdds: "On-site spare kit",
  },
  calculationSnapshot: {
    schemaVersion: "vendor-response-calculation.v1",
    currency: "USD",
    grandTotalMinor: 12500000,
    equipmentSubtotalMinor: 10000000,
    laborSubtotalMinor: 2000000,
    travelSubtotalMinor: 500000,
    feeSubtotalMinor: 0,
    taxSubtotalMinor: 0,
    discountMinor: 0,
    specCounts: { total: 1, answered: 1, comply: 1, substitute: 0, exception: 0 },
    completion: { percent: 100 },
    requestedRoomNights: 0,
    roomTotals: [{ roomId: "ballroom", roomTotalMinor: 12500000 }],
  },
};

test("structured provenance uses stable field paths and distinct trust origins", () => {
  const fragments = structuredProvenanceFragments(structuredRecord);
  assert.ok(fragments.some((fragment) =>
    fragment.path === "/response/rooms/ballroom/specResponses/screens/status"
      && fragment.value === "comply"
      && fragment.provenance === "vendor_stated"));
  assert.ok(fragments.some((fragment) =>
    fragment.path === "/calculation/grandTotalMinor"
      && fragment.value === 12500000
      && fragment.provenance === "server_calculated"));
});

test("exports preserve immutable provenance and never expose stored document URLs", () => {
  const version = {
    ...structuredRecord,
    parentVersionId: "version-1",
    reason: "vendor_revision",
    sourceSystem: "public_portal",
    format: "structured_v1",
    questionnaire: structuredRecord.questionnaireSnapshot,
  };
  const payload = vendorResponseExportPayload({
    proposalTitle: structuredRecord.proposalTitle,
    version,
  });
  assert.equal(payload.submissionVersion.versionId, "version-2");
  assert.equal(payload.documents[0].url, undefined);
  assert.equal(payload.provenanceVocabulary.server_calculated.includes("frozen"), true);

  const html = renderVendorResponsePrintHtml({
    proposalTitle: structuredRecord.proposalTitle,
    version,
  });
  assert.match(html, /\$125,000\.00/);
  assert.match(html, /server calculated/);
  assert.match(html, /vendor stated/);
  assert.doesNotMatch(html, /private\.example\.invalid/);
});
