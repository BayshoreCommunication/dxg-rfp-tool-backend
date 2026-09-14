require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const VendorSubmissionDraft = require("../modal/vendorSubmissionDraftModel").default;
const VendorSubmission = require("../modal/vendorSubmissionModel").default;
const VendorSubmissionVersion = require("../modal/vendorSubmissionVersionModel").default;
const {
  createVendorSubmissionDraftService,
  VendorSubmissionDraftError,
} = require("../src/modules/vendorResponses/application/vendorSubmissionDrafts");
const {
  mongoVendorSubmissionDraftRepository,
} = require("../src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionDraftRepository");
const {
  buildVendorResponseQuestionnaire,
} = require("./fixtures/vendorResponseV1");

const scope = {
  organizationId: "507f1f77bcf86cd799439011",
  proposalId: "507f1f77bcf86cd799439012",
  grantId: "507f1f77bcf86cd799439013",
  grantSubjectHash: "a".repeat(64),
};

const sameScope = (record, input) =>
  record.organizationId === input.organizationId
  && record.proposalId === input.proposalId
  && record.grantId === input.grantId
  && record.grantSubjectHash === input.grantSubjectHash;

const memoryRepository = () => {
  const records = [];
  const submittedDocumentIds = new Set();
  let nextId = 100;
  return {
    records,
    submittedDocumentIds,
    async findActive(input, now) {
      return records.find((record) =>
        sameScope(record, input)
        && record.status === "active"
        && new Date(record.expiresAt) > now) ?? null;
    },
    async findById(input, draftId) {
      return records.find((record) =>
        record.draftId === draftId && sameScope(record, input)) ?? null;
    },
    async createActive(input) {
      const existing = records.find((record) =>
        sameScope(record, input) && record.status === "active");
      if (existing) return { draft: existing, created: false };
      nextId += 1;
      const draft = {
        ...scope,
        ...input,
        draftId: `507f1f77bcf86cd799439${nextId}`,
        submissionId: input.submissionId ?? null,
        documents: [],
        draftRevision: 1,
        status: "active",
        lastSavedAt: input.now.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        abandonedAt: null,
        cleanupCompletedAt: null,
      };
      records.push(draft);
      return { draft, created: true };
    },
    async revisionSubmissionIsAuthorized(input) {
      return input.submissionId === "507f1f77bcf86cd799439099";
    },
    async updateActive(input) {
      const draft = records.find((record) =>
        record.draftId === input.draftId && sameScope(record, input));
      if (
        !draft
        || draft.status !== "active"
        || draft.draftRevision !== input.expectedRevision
        || new Date(draft.expiresAt) <= input.now
      ) return null;
      draft.response = input.response;
      draft.documents = input.documents;
      draft.lastSavedAt = input.now.toISOString();
      draft.expiresAt = input.expiresAt.toISOString();
      draft.draftRevision += 1;
      return draft;
    },
    async abandon(input) {
      const draft = records.find((record) =>
        record.draftId === input.draftId && sameScope(record, input));
      if (!draft || draft.status !== "active" || draft.draftRevision !== input.expectedRevision) {
        return null;
      }
      draft.status = "abandoned";
      draft.abandonedAt = input.now.toISOString();
      draft.lastSavedAt = input.now.toISOString();
      draft.draftRevision += 1;
      return draft;
    },
    async listCleanupCandidates(now, limit) {
      return records.filter((record) =>
        !record.cleanupCompletedAt
        && (record.status === "abandoned"
          || (record.status === "active" && new Date(record.expiresAt) <= now)))
        .slice(0, limit);
    },
    async markExpiredAbandoned(draftId, now) {
      const draft = records.find((record) => record.draftId === draftId);
      if (draft && draft.status === "active" && new Date(draft.expiresAt) <= now) {
        draft.status = "abandoned";
        draft.abandonedAt = now.toISOString();
      }
    },
    async documentIsSubmitted(_organizationId, documentId) {
      return submittedDocumentIds.has(documentId);
    },
    async markDocumentDeleted(draftId, documentId, deletedAt) {
      const draft = records.find((record) => record.draftId === draftId);
      const document = draft?.documents.find((entry) => entry.documentId === documentId);
      if (document) document.objectDeletedAt = deletedAt.toISOString();
    },
    async markCleanupComplete(draftId, completedAt) {
      const draft = records.find((record) => record.draftId === draftId);
      if (draft) draft.cleanupCompletedAt = completedAt.toISOString();
    },
  };
};

const serviceHarness = (options = {}) => {
  const repository = memoryRepository();
  const uploads = [];
  const deletions = [];
  const localCleanup = [];
  let currentTime = new Date("2026-09-14T12:00:00.000Z");
  const storage = {
    async inspect() {
      return options.inspection ?? {
        sizeBytes: 1_000,
        sha256: "b".repeat(64),
        detectedMimeType: "application/pdf",
      };
    },
    async upload(input) {
      uploads.push(input);
      return `rfpilot-private:${encodeURIComponent(input.objectKey)}`;
    },
    async cleanup(path) {
      localCleanup.push(path);
    },
    async delete(objectKey) {
      deletions.push(objectKey);
    },
  };
  const service = createVendorSubmissionDraftService({
    repository,
    storage,
    malwareScan: options.malwareScan ?? (async () => "clean"),
    folderName: "/DXG/",
    now: () => currentTime,
    retentionDays: 30,
  });
  return {
    repository,
    storage,
    uploads,
    deletions,
    localCleanup,
    service,
    setNow(value) { currentTime = new Date(value); },
  };
};

test("draft model pins grant/questionnaire scope and provides one active draft identity", () => {
  assert.ok(VendorSubmissionDraft.schema.path("grantSubjectHash"));
  assert.equal(VendorSubmissionDraft.schema.path("questionnaire").options.immutable, true);
  assert.ok(VendorSubmissionDraft.schema.indexes().some(([keys, options]) =>
    keys.organizationId === 1
    && keys.proposalId === 1
    && keys.grantId === 1
    && options.unique === true
    && options.partialFilterExpression.status === "active"));
});

test("the same validated grant resumes one partial draft and stale saves conflict", async () => {
  const harness = serviceHarness();
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = scope.proposalId;
  const first = await harness.service.createOrResume({ ...scope, questionnaire });
  const resumed = await harness.service.createOrResume({ ...scope, questionnaire });

  assert.equal(first.created, true);
  assert.equal(resumed.created, false);
  assert.equal(resumed.draft.draftId, first.draft.draftId);
  assert.deepEqual(resumed.draft.documentManifest, []);
  assert.equal(JSON.stringify(resumed).includes("grantSubjectHash"), false);

  const response = structuredClone(first.draft.response);
  response.identity.vendorName = "Saved vendor";
  const saved = await harness.service.save({
    ...scope,
    draftId: first.draft.draftId,
    expectedRevision: 1,
    response,
  });
  assert.equal(saved.draftRevision, 2);
  assert.equal(saved.response.identity.vendorName, "Saved vendor");

  await assert.rejects(
    () => harness.service.save({
      ...scope,
      draftId: first.draft.draftId,
      expectedRevision: 1,
      response,
    }),
    (error) => error instanceof VendorSubmissionDraftError
      && error.code === "DRAFT_CONFLICT"
      && error.status === 409
      && error.latestDraftRevision === 2,
  );
});

test("categorized uploads validate scope before storage and return no private location", async () => {
  const harness = serviceHarness();
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = scope.proposalId;
  const { draft } = await harness.service.createOrResume({ ...scope, questionnaire });

  await assert.rejects(
    () => harness.service.uploadDocuments({
      ...scope,
      draftId: draft.draftId,
      expectedRevision: 1,
      purposeId: "dei-policy",
      scopeType: "room",
      scopeId: "room-1",
      files: [{ originalname: "policy.pdf", path: "/tmp/policy", mimetype: "application/pdf" }],
    }),
    (error) => error.code === "DOCUMENT_SCOPE_INVALID",
  );
  assert.equal(harness.uploads.length, 0);
  assert.deepEqual(harness.localCleanup, ["/tmp/policy"]);

  const response = structuredClone(draft.response);
  response.rooms.push({
    roomId: "room-1",
    specResponses: [],
    equipmentLines: [],
    categoryTotals: [],
    laborLines: [],
    laborSubtotal: { amountMinor: 0, currency: "USD" },
    hybrid: {
      feedHandoff: "",
      redundancy: "",
      virtualAudienceExperience: "",
    },
  });
  const saved = await harness.service.save({
    ...scope,
    draftId: draft.draftId,
    expectedRevision: 1,
    response,
  });
  const uploaded = await harness.service.uploadDocuments({
    ...scope,
    draftId: draft.draftId,
    expectedRevision: saved.draftRevision,
    purposeId: "dei-policy",
    scopeType: "room",
    scopeId: "room-1",
    files: [{ originalname: "policy.pdf", path: "/tmp/policy-2", mimetype: "application/pdf" }],
  });

  assert.equal(uploaded.draft.draftRevision, 3);
  assert.equal(uploaded.draft.response.documents.length, 1);
  assert.equal(uploaded.draft.documentManifest.length, 1);
  assert.equal(uploaded.documents.length, 1);
  const serialized = JSON.stringify(uploaded);
  assert.equal(serialized.includes("objectKey"), false);
  assert.equal(serialized.includes("rfpilot-private"), false);
  assert.deepEqual(harness.localCleanup, ["/tmp/policy", "/tmp/policy-2"]);
});

test("a stale upload is not associated and its orphan object is deleted", async () => {
  const harness = serviceHarness();
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = scope.proposalId;
  const { draft } = await harness.service.createOrResume({ ...scope, questionnaire });
  const response = structuredClone(draft.response);
  response.identity.vendorName = "Concurrent save";
  await harness.service.save({
    ...scope,
    draftId: draft.draftId,
    expectedRevision: 1,
    response,
  });

  await assert.rejects(
    () => harness.service.uploadDocuments({
      ...scope,
      draftId: draft.draftId,
      expectedRevision: 1,
      purposeId: "dei-policy",
      scopeType: "proposal",
      files: [{ originalname: "policy.pdf", path: "/tmp/stale", mimetype: "application/pdf" }],
    }),
    (error) => error.code === "DRAFT_CONFLICT" && error.latestDraftRevision === 2,
  );
  assert.equal(harness.uploads.length, 1);
  assert.equal(harness.deletions.length, 1);
  assert.deepEqual(harness.localCleanup, ["/tmp/stale"]);
});

test("categorized uploads enforce questionnaire type, size, count, and malware rules", async () => {
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = scope.proposalId;

  const wrongType = serviceHarness();
  const first = await wrongType.service.createOrResume({ ...scope, questionnaire });
  await assert.rejects(
    () => wrongType.service.uploadDocuments({
      ...scope,
      draftId: first.draft.draftId,
      expectedRevision: 1,
      purposeId: "dei-policy",
      scopeType: "proposal",
      files: [{ originalname: "policy.png", path: "/tmp/type", mimetype: "image/png" }],
    }),
    (error) => error.code === "DOCUMENT_TYPE_INVALID" && error.status === 415,
  );
  assert.equal(wrongType.uploads.length, 0);

  const tooLarge = serviceHarness({
    inspection: {
      sizeBytes: 10_000_001,
      sha256: "b".repeat(64),
      detectedMimeType: "application/pdf",
    },
  });
  const second = await tooLarge.service.createOrResume({ ...scope, questionnaire });
  await assert.rejects(
    () => tooLarge.service.uploadDocuments({
      ...scope,
      draftId: second.draft.draftId,
      expectedRevision: 1,
      purposeId: "dei-policy",
      scopeType: "proposal",
      files: [{ originalname: "policy.pdf", path: "/tmp/size", mimetype: "application/pdf" }],
    }),
    (error) => error.code === "DOCUMENT_SIZE_INVALID" && error.status === 413,
  );
  assert.equal(tooLarge.uploads.length, 0);

  const tooMany = serviceHarness();
  const third = await tooMany.service.createOrResume({ ...scope, questionnaire });
  await assert.rejects(
    () => tooMany.service.uploadDocuments({
      ...scope,
      draftId: third.draft.draftId,
      expectedRevision: 1,
      purposeId: "dei-policy",
      scopeType: "proposal",
      files: ["one", "two", "three"].map((name) => ({
        originalname: `${name}.pdf`,
        path: `/tmp/${name}`,
        mimetype: "application/pdf",
      })),
    }),
    (error) => error.code === "DOCUMENT_COUNT_INVALID",
  );
  assert.equal(tooMany.uploads.length, 0);

  const infected = serviceHarness({ malwareScan: async () => "infected" });
  const fourth = await infected.service.createOrResume({ ...scope, questionnaire });
  await assert.rejects(
    () => infected.service.uploadDocuments({
      ...scope,
      draftId: fourth.draft.draftId,
      expectedRevision: 1,
      purposeId: "dei-policy",
      scopeType: "proposal",
      files: [{ originalname: "policy.pdf", path: "/tmp/infected", mimetype: "application/pdf" }],
    }),
    (error) => error.code === "DOCUMENT_SCAN_FAILED",
  );
  assert.equal(infected.uploads.length, 0);
});

test("retirement removes response links but preserves objects used by submissions", async () => {
  const harness = serviceHarness();
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = scope.proposalId;
  const { draft } = await harness.service.createOrResume({ ...scope, questionnaire });
  const uploaded = await harness.service.uploadDocuments({
    ...scope,
    draftId: draft.draftId,
    expectedRevision: 1,
    purposeId: "dei-policy",
    scopeType: "proposal",
    files: [{ originalname: "policy.pdf", path: "/tmp/policy", mimetype: "application/pdf" }],
  });
  const documentId = uploaded.documents[0].documentId;
  harness.repository.submittedDocumentIds.add(documentId);
  const retired = await harness.service.retireDocument({
    ...scope,
    draftId: draft.draftId,
    documentId,
    expectedRevision: uploaded.draft.draftRevision,
  });

  assert.deepEqual(retired.response.documents, []);
  assert.deepEqual(retired.documentManifest, []);
  assert.equal(harness.deletions.length, 0);
});

test("expiry cleanup deletes only unsubmitted draft objects", async () => {
  const harness = serviceHarness();
  const questionnaire = buildVendorResponseQuestionnaire();
  questionnaire.proposalId = scope.proposalId;
  const { draft } = await harness.service.createOrResume({ ...scope, questionnaire });
  const uploaded = await harness.service.uploadDocuments({
    ...scope,
    draftId: draft.draftId,
    expectedRevision: 1,
    purposeId: "dei-policy",
    scopeType: "proposal",
    files: [
      { originalname: "one.pdf", path: "/tmp/one", mimetype: "application/pdf" },
      { originalname: "two.pdf", path: "/tmp/two", mimetype: "application/pdf" },
    ],
  });
  harness.repository.submittedDocumentIds.add(uploaded.documents[0].documentId);
  harness.setNow("2026-10-15T12:00:00.000Z");

  const result = await harness.service.cleanupExpired();

  assert.deepEqual(result, {
    drafts: 1,
    deletedDocuments: 1,
    retainedDocuments: 1,
    failedDocuments: 0,
  });
  assert.equal(harness.deletions.length, 1);
  assert.equal(harness.repository.records[0].status, "abandoned");
  assert.ok(harness.repository.records[0].cleanupCompletedAt);
});

test("workspace resumes the questionnaire snapshot pinned by its active draft", async () => {
  const harness = serviceHarness();
  const pinned = buildVendorResponseQuestionnaire();
  pinned.proposalId = scope.proposalId;
  const created = await harness.service.createOrResume({ ...scope, questionnaire: pinned });
  const newer = structuredClone(pinned);
  newer.questionnaireVersion = 2;
  newer.questionnaireChecksum = "c".repeat(64);
  const workspace = {
    schemaVersion: "vendor-response-workspace.v1",
    access: { state: "open", canEdit: true, canSubmit: true },
    questionnaire: newer,
    draft: null,
    currentSubmission: null,
  };

  const hydrated = await harness.service.hydrateWorkspace(workspace, scope);

  assert.equal(hydrated.questionnaire.questionnaireVersion, 1);
  assert.equal(hydrated.draft.draftId, created.draft.draftId);
  assert.equal(hydrated.draft.documentManifest, undefined);
});

test("Mongo draft saves compare-and-swap within the full grant and tenant scope", async () => {
  const original = VendorSubmissionDraft.findOneAndUpdate;
  let capturedFilter;
  let capturedUpdate;
  let capturedOptions;
  VendorSubmissionDraft.findOneAndUpdate = (filter, update, options) => {
    capturedFilter = filter;
    capturedUpdate = update;
    capturedOptions = options;
    return { lean: async () => null };
  };

  try {
    const result = await mongoVendorSubmissionDraftRepository.updateActive({
      ...scope,
      draftId: "507f1f77bcf86cd799439099",
      expectedRevision: 7,
      response: {},
      documents: [],
      now: new Date("2026-09-14T12:00:00.000Z"),
      expiresAt: new Date("2026-10-14T12:00:00.000Z"),
    });
    assert.equal(result, null);
    assert.equal(capturedFilter.organizationId, scope.organizationId);
    assert.equal(capturedFilter.proposalId, scope.proposalId);
    assert.equal(capturedFilter.grantId, scope.grantId);
    assert.equal(capturedFilter.grantSubjectHash, scope.grantSubjectHash);
    assert.equal(capturedFilter.draftRevision, 7);
    assert.equal(capturedFilter.status, "active");
    assert.deepEqual(capturedUpdate.$inc, { draftRevision: 1 });
    assert.deepEqual(capturedOptions, { new: true, runValidators: true });
  } finally {
    VendorSubmissionDraft.findOneAndUpdate = original;
  }
});

test("revision authorization is tenant scoped and bound to the grant subject", async () => {
  const original = VendorSubmission.findOne;
  let capturedFilter;
  VendorSubmission.findOne = (filter) => {
    capturedFilter = filter;
    return {
      select: () => ({ lean: async () => ({ primaryEmail: "vendor@example.com" }) }),
    };
  };

  try {
    const crypto = require("node:crypto");
    const grantSubjectHash = crypto
      .createHash("sha256")
      .update("vendor@example.com")
      .digest("hex");
    const authorized = await mongoVendorSubmissionDraftRepository
      .revisionSubmissionIsAuthorized({
        ...scope,
        grantSubjectHash,
        submissionId: "507f1f77bcf86cd799439099",
      });
    assert.equal(authorized, true);
    assert.deepEqual(capturedFilter, {
      _id: "507f1f77bcf86cd799439099",
      organizationId: scope.organizationId,
      proposalId: scope.proposalId,
    });
  } finally {
    VendorSubmission.findOne = original;
  }
});

test("cleanup checks immutable submission versions before deleting draft objects", async () => {
  const original = VendorSubmissionVersion.exists;
  let capturedFilter;
  VendorSubmissionVersion.exists = async (filter) => {
    capturedFilter = filter;
    return { _id: "507f1f77bcf86cd799439099" };
  };

  try {
    const referenced = await mongoVendorSubmissionDraftRepository
      .documentIsSubmitted(scope.organizationId, "document-1");
    assert.equal(referenced, true);
    assert.deepEqual(capturedFilter, {
      organizationId: scope.organizationId,
      "documents.documentId": "document-1",
    });
  } finally {
    VendorSubmissionVersion.exists = original;
  }
});

test("draft HTTP routes validate grants before multipart intake and keep legacy submission", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../routes/vendorResponseRoute.ts"),
    "utf8",
  );
  assert.match(routeSource, /"\/drafts",\s*publicGrantLimit,\s*requirePublicGrant\("vendor:submit", alternateVendorContact\)/);
  assert.match(
    routeSource,
    /"\/drafts\/:draftId\/documents",\s*publicGrantLimit,\s*requirePublicGrant\("vendor:submit", alternateVendorContact\),\s*receiveVendorDocuments/,
  );
  assert.match(routeSource, /router\.post\(\s*"\/",\s*publicGrantLimit,\s*receiveVendorDocuments/);
});
