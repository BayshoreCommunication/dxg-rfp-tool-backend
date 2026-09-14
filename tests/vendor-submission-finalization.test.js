require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const VendorSubmissionDraft = require("../modal/vendorSubmissionDraftModel").default;
const VendorSubmissionVersion = require("../modal/vendorSubmissionVersionModel").default;
const {
  createFinalizeVendorSubmissionDraft,
  VendorSubmissionFinalizationError,
} = require("../src/modules/vendorResponses/application/finalizeVendorSubmissionDraft");
const {
  calculateStructuredVendorResponse,
} = require("../src/modules/vendorResponses/domain/structuredResponse");
const {
  vendorSubmissionManifestChecksum,
} = require("../src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionRepository");
const {
  buildCompleteVendorResponse,
  buildVendorResponseQuestionnaire,
} = require("./fixtures/vendorResponseV1");

const scope = {
  organizationId: "507f1f77bcf86cd799439011",
  proposalId: "507f1f77bcf86cd799439012",
  grantId: "507f1f77bcf86cd799439013",
  grantSubjectHash: "a".repeat(64),
};

const document = (overrides = {}) => ({
  documentId: "document-dei-1",
  sourceId: "source-dei-1",
  purposeId: "dei-policy",
  scopeType: "proposal",
  name: "dei-policy.pdf",
  url: "rfpilot-private:private%2Fdei-policy.pdf",
  objectKey: "private/dei-policy.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1250,
  sha256: "b".repeat(64),
  scanStatus: "clean",
  status: "active",
  uploadedAt: "2026-09-14T10:00:00.000Z",
  retiredAt: null,
  objectDeletedAt: null,
  ...overrides,
});

const buildDraft = (overrides = {}) => {
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = scope.proposalId;
  return {
    ...scope,
    draftId: "507f1f77bcf86cd799439014",
    submissionId: null,
    questionnaire,
    response: buildCompleteVendorResponse(questionnaire),
    documents: [document()],
    draftRevision: 4,
    status: "active",
    lastSavedAt: "2026-09-14T10:00:00.000Z",
    expiresAt: "2026-10-14T10:00:00.000Z",
    finalizationKeyHash: null,
    finalizationStartedAt: null,
    submittedVersionId: null,
    submittedAt: null,
    ...overrides,
  };
};

const harness = (draftInput = buildDraft()) => {
  const draft = structuredClone(draftInput);
  const versions = [];
  const sourceIds = new Set();
  let saveCount = 0;
  let plannerNotifications = 0;
  let confirmations = 0;
  const draftRepository = {
    async findById(input, draftId) {
      return draftId === draft.draftId
        && Object.entries(scope).every(([key, value]) => input[key] === value)
        ? draft
        : null;
    },
    async claimFinalization(input) {
      if (
        draft.status !== "active"
        || draft.draftRevision !== input.expectedRevision
        || new Date(draft.expiresAt) <= input.now
        || (draft.finalizationKeyHash
          && draft.finalizationKeyHash !== input.finalizationKeyHash)
      ) return null;
      draft.finalizationKeyHash = input.finalizationKeyHash;
      draft.finalizationStartedAt = input.now.toISOString();
      return draft;
    },
    async releaseFinalization(input) {
      if (
        draft.status === "active"
        && draft.draftRevision === input.expectedRevision
        && draft.finalizationKeyHash === input.finalizationKeyHash
      ) {
        draft.finalizationKeyHash = null;
        draft.finalizationStartedAt = null;
      }
    },
    async completeFinalization(input) {
      if (
        draft.status !== "active"
        || draft.draftRevision !== input.expectedRevision
        || draft.finalizationKeyHash !== input.finalizationKeyHash
      ) return null;
      draft.status = "submitted";
      draft.submittedVersionId = input.submittedVersionId;
      draft.submittedAt = input.now.toISOString();
      draft.draftRevision += 1;
      return draft;
    },
  };
  const submissionRepository = {
    async getReceipt() {
      return null;
    },
    async findVersionByFinalizedDraft(input) {
      return versions.find((entry) =>
        entry.organizationId === input.organizationId
        && entry.finalizedDraftId === input.draftId) ?? null;
    },
    async findVersionByIdempotencyKey(input) {
      return versions.find((entry) =>
        entry.organizationId === input.organizationId
        && entry.idempotencyKey === input.idempotencyKey) ?? null;
    },
    async findProposal(proposalId) {
      return proposalId === scope.proposalId
        ? {
            proposalId,
            organizationId: scope.organizationId,
            ownerUserId: "507f1f77bcf86cd799439020",
            proposalTitle: "Annual Meeting",
          }
        : null;
    },
    async findExisting() {
      return null;
    },
    async saveVersion(input) {
      saveCount += 1;
      const replay = versions.find((entry) =>
        entry.finalizedDraftId === input.structured.finalizedDraftId);
      if (replay) return { record: replay, created: false };
      const versionNumber = input.submissionId ? 2 : 1;
      const record = {
        ...input,
        submissionId: input.submissionId ?? "507f1f77bcf86cd799439030",
        versionId: "507f1f77bcf86cd799439031",
        versionNumber,
        parentVersionId: input.submissionId
          ? "507f1f77bcf86cd799439032"
          : null,
        receivedAt: input.receivedAt.toISOString(),
        manifestChecksum: "c".repeat(64),
        documents: structuredClone(input.newDocuments),
        retiredDocuments: structuredClone(input.structured.retiredDocuments),
        responseSchemaVersion: "vendor-response.v1",
        questionnaire: {
          questionnaireId: input.structured.questionnaire.questionnaireId,
          questionnaireVersion: input.structured.questionnaire.questionnaireVersion,
          questionnaireChecksum: input.structured.questionnaire.questionnaireChecksum,
          proposalVersion: input.structured.questionnaire.proposalVersion,
        },
        questionnaireSnapshot: structuredClone(input.structured.questionnaire),
        structuredResponse: structuredClone(input.structured.response),
        calculationSnapshot: structuredClone(input.structured.calculation),
        finalizedDraftId: input.structured.finalizedDraftId,
        response: { _id: "507f1f77bcf86cd799439040" },
      };
      versions.push(record);
      return { record, created: true };
    },
  };
  const service = createFinalizeVendorSubmissionDraft({
    draftRepository,
    submissionRepository,
    notifier: {
      async notifyPlanner() {
        plannerNotifications += 1;
      },
    },
    confirmation: {
      async send() {
        confirmations += 1;
      },
    },
    sourceRegistry: {
      async register(record) {
        record.documents.forEach((entry) => sourceIds.add(entry.sourceId));
        return { registered: record.documents.length, pending: 0 };
      },
    },
    now: () => new Date("2026-09-14T14:00:00.000Z"),
  });
  return {
    draft,
    versions,
    service,
    counts: () => ({ saveCount, plannerNotifications, confirmations }),
    sourceIds,
  };
};

test("finalization freezes the exact questionnaire, response, calculation, and manifest", async () => {
  const draft = buildDraft();
  draft.response.acknowledgements.forEach((entry) => delete entry.acceptedAt);
  const state = harness(draft);
  const result = await state.service({
    ...scope,
    draftId: state.draft.draftId,
    expectedRevision: 4,
    idempotencyKey: "checkout-1",
  });

  assert.equal(result.kind, "created");
  assert.equal(state.draft.status, "submitted");
  assert.equal(result.receipt.responseSchemaVersion, "vendor-response.v1");
  assert.equal(result.receipt.calculationSnapshot.grandTotalMinor, 33_906);
  assert.ok(state.versions[0].structuredResponse.acknowledgements.every(
    (entry) => entry.acceptedAt === "2026-09-14T14:00:00.000Z",
  ));
  assert.equal(result.receipt.documents[0].versionDisposition, "added");
  assert.equal("url" in result.receipt.documents[0], false);
  assert.equal("objectKey" in result.receipt.documents[0], false);
  assert.equal(JSON.stringify(result.receipt).includes("structuredResponse"), false);

  const frozen = structuredClone(state.versions[0].structuredResponse);
  state.draft.response.identity.vendorName = "Changed after submit";
  assert.deepEqual(state.versions[0].structuredResponse, frozen);
  assert.deepEqual(
    state.versions[0].calculationSnapshot,
    calculateStructuredVendorResponse(
      state.versions[0].questionnaireSnapshot,
      state.versions[0].structuredResponse,
      state.versions[0].receivedAt,
    ),
  );
});

test("replaying finalization returns the original receipt without duplicate effects", async () => {
  const state = harness();
  const first = await state.service({
    ...scope,
    draftId: state.draft.draftId,
    expectedRevision: 4,
    idempotencyKey: "checkout-2",
  });
  const replay = await state.service({
    ...scope,
    draftId: state.draft.draftId,
    expectedRevision: 4,
    idempotencyKey: "a-retry-may-send-another-key",
  });

  assert.equal(replay.kind, "duplicate");
  assert.equal(replay.receipt.versionId, first.receipt.versionId);
  assert.equal(state.versions.length, 1);
  assert.deepEqual(state.counts(), {
    saveCount: 1,
    plannerNotifications: 1,
    confirmations: 1,
  });
  assert.equal(state.sourceIds.size, 1);
});

test("incomplete, expired, stale, and mismatched drafts cannot finalize", async (t) => {
  const cases = [
    {
      name: "incomplete",
      mutate(draft) { draft.response.identity.vendorName = ""; },
      code: "DRAFT_FINAL_INVALID",
    },
    {
      name: "expired",
      mutate(draft) { draft.expiresAt = "2026-09-13T00:00:00.000Z"; },
      code: "DRAFT_EXPIRED",
    },
    {
      name: "document mismatch",
      mutate(draft) { draft.documents[0].purposeId = "wrong-purpose"; },
      code: "DRAFT_DOCUMENT_MISMATCH",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const draft = buildDraft();
      entry.mutate(draft);
      const state = harness(draft);
      await assert.rejects(
        () => state.service({
          ...scope,
          draftId: state.draft.draftId,
          expectedRevision: 4,
          idempotencyKey: entry.name,
        }),
        (error) => error instanceof VendorSubmissionFinalizationError
          && error.code === entry.code,
      );
      assert.equal(state.versions.length, 0);
    });
  }

  const stale = harness();
  await assert.rejects(
    () => stale.service({
      ...scope,
      draftId: stale.draft.draftId,
      expectedRevision: 3,
      idempotencyKey: "stale",
    }),
    (error) => error instanceof VendorSubmissionFinalizationError
      && error.code === "DRAFT_CONFLICT"
      && error.latestDraftRevision === 4,
  );
});

test("revision finalization records inherited, added, and retired document dispositions", async () => {
  const draft = buildDraft({ submissionId: "507f1f77bcf86cd799439050" });
  draft.documents = [
    document({ inheritedFromVersionId: "507f1f77bcf86cd799439032" }),
    document({
      documentId: "retired-document",
      sourceId: "retired-source",
      inheritedFromVersionId: "507f1f77bcf86cd799439032",
      status: "retired",
      retiredAt: "2026-09-14T12:00:00.000Z",
    }),
    document({
      documentId: "new-supplement",
      sourceId: "new-source",
      purposeId: "supplement",
    }),
  ];
  draft.response.documents.push({
    documentId: "new-supplement",
    purposeId: "supplement",
    scopeType: "proposal",
  });
  draft.questionnaire.documents.categories.push({
    purposeId: "supplement",
    label: "Supplement",
    required: false,
    minimumFiles: 0,
    maximumFiles: 2,
    maximumFileBytes: 10_000_000,
    allowedMimeTypes: ["application/pdf"],
  });
  const state = harness(draft);
  const result = await state.service({
    ...scope,
    draftId: state.draft.draftId,
    expectedRevision: 4,
    idempotencyKey: "revision",
  });

  assert.equal(result.receipt.versionNumber, 2);
  assert.deepEqual(
    result.receipt.documents.map((entry) => entry.versionDisposition),
    ["inherited", "added"],
  );
  assert.deepEqual(result.receipt.retiredDocuments, [{
    documentId: "retired-document",
    retiredFromVersionId: "507f1f77bcf86cd799439032",
  }]);
});

test("structured checksums cover frozen response data while legacy checksums stay stable", () => {
  const draft = buildDraft();
  const base = {
    proposalId: scope.proposalId,
    submissionId: "507f1f77bcf86cd799439030",
    versionNumber: 1,
    reason: "initial",
    vendorName: draft.response.identity.vendorName,
    submittedBy: draft.response.identity.submittedBy,
    email: draft.response.identity.email,
    message: draft.response.valueAdds,
    documents: [document()],
  };
  const legacy = vendorSubmissionManifestChecksum(base);
  const structured = {
    finalizedDraftId: draft.draftId,
    questionnaire: draft.questionnaire,
    response: draft.response,
    calculation: calculateStructuredVendorResponse(
      draft.questionnaire,
      draft.response,
      "2026-09-14T14:00:00.000Z",
    ),
    retiredDocuments: [],
  };
  const first = vendorSubmissionManifestChecksum({ ...base, structured });
  structured.response.identity.vendorName = "Another vendor";
  const changed = vendorSubmissionManifestChecksum({ ...base, structured });

  assert.notEqual(first, legacy);
  assert.notEqual(changed, first);
  assert.equal(vendorSubmissionManifestChecksum(base), legacy);
});

test("models enforce one finalized version per draft and routes do not expose storage locations", () => {
  assert.ok(VendorSubmissionDraft.schema.path("finalizationKeyHash"));
  assert.ok(VendorSubmissionDraft.schema.path("submittedVersionId"));
  assert.ok(VendorSubmissionVersion.schema.path("structuredResponse"));
  assert.ok(VendorSubmissionVersion.schema.path("calculationSnapshot"));
  assert.ok(VendorSubmissionVersion.schema.indexes().some(([keys, options]) =>
    keys.finalizedDraftId === 1
    && options.unique === true
    && options.sparse === true));

  const root = path.resolve(__dirname, "..");
  const routes = fs.readFileSync(path.join(root, "routes/vendorResponseRoute.ts"), "utf8");
  const controller = fs.readFileSync(path.join(root, "controller/vendorResponseController.ts"), "utf8");
  assert.ok(routes.includes('"/drafts/:draftId/finalize"'));
  assert.ok(routes.includes('"/:submissionId/revision-drafts"'));
  const handler = controller.slice(controller.indexOf("export const finalizeVendorResponseDraft"));
  assert.ok(!handler.includes("url: document.url"));
  assert.ok(!handler.includes("objectKey: document.objectKey"));
});
