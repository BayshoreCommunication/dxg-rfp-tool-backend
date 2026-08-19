const assert = require("node:assert/strict");
const test = require("node:test");
const VendorResponse = require("../modal/vendorResponseModel").default;
const VendorSubmission = require("../modal/vendorSubmissionModel").default;
const VendorSubmissionVersion = require("../modal/vendorSubmissionVersionModel").default;
const {
  createCheckVendorResponse,
  createSubmitVendorResponse,
} = require("../src/modules/vendorResponses/application/submitVendorResponse");

test("vendor responses persist the tenant organization field", () => {
  const organizationPath = VendorResponse.schema.path("organizationId");
  assert.ok(organizationPath);
  assert.equal(organizationPath.options.required[0], true);
});

test("submission and immutable version schemas enforce stable version identity", () => {
  assert.ok(VendorSubmission.schema.path("currentVersionId"));
  assert.equal(VendorSubmission.schema.path("organizationId").options.required, true);
  assert.ok(VendorSubmissionVersion.schema.path("manifestChecksum"));
  assert.ok(VendorSubmissionVersion.schema.indexes().some(([keys, options]) =>
    keys.submissionId === 1 && keys.versionNumber === 1 && options.unique === true));
  assert.ok(VendorSubmissionVersion.schema.indexes().some(([keys, options]) =>
    keys.organizationId === 1 && keys.idempotencyKey === 1 && options.unique === true));
});

const dependencies = (capture = {}) => ({
  folderName: "/DXG/",
  now: () => 123456,
  repository: {
    findExisting: async () => null,
    findByTrackingId: async () => null,
    findByProposalAndEmail: async () => null,
    findVersionByIdempotencyKey: async () => null,
    findProposal: async (proposalId) => ({
      proposalId,
      organizationId: "507f1f77bcf86cd799439011",
      ownerUserId: "planner-001",
      proposalTitle: "DXG Summit",
    }),
    saveVersion: async (input) => {
      capture.save = input;
      const versionNumber = input.existingResponse ? 2 : 1;
      const response = {
        _id: input.existingResponse?._id || "response-001",
        proposalTitle: input.proposalTitle,
        currentVersionNumber: versionNumber,
        ...input,
      };
      return {
        created: true,
        record: {
          submissionId: "507f1f77bcf86cd799439012",
          versionId: versionNumber === 1 ? "507f1f77bcf86cd799439013" : "507f1f77bcf86cd799439014",
          versionNumber,
          parentVersionId: versionNumber === 1 ? null : "507f1f77bcf86cd799439013",
          reason: input.reason,
          receivedAt: new Date(123456).toISOString(),
          manifestChecksum: "a".repeat(64),
          proposalId: input.proposalId,
          organizationId: input.organizationId,
          ownerUserId: input.ownerUserId,
          proposalTitle: input.proposalTitle,
          vendorName: input.vendorName,
          submittedBy: input.submittedBy,
          email: input.email,
          message: input.message,
          documents: input.newDocuments,
          response,
        },
      };
    },
    getReceipt: async () => null,
  },
  storage: {
    inspect: async () => ({ sizeBytes: 1234, sha256: "b".repeat(64) }),
    upload: async (input) => {
      capture.upload = input;
      return `https://storage.example/${input.objectKey}`;
    },
    cleanup: async (path) => {
      capture.cleanup = path;
    },
  },
  notifier: {
    notifyPlanner: async (input) => {
      capture.notification = input;
    },
  },
  confirmation: {
    send: async (input) => {
      capture.confirmation = input;
    },
  },
  sourceRegistry: {
    register: async (record) => {
      capture.sourceRecord = record;
      return { registered: record.documents.length, pending: 0 };
    },
  },
});

test("tracking-id check takes precedence over proposal and email", async () => {
  const calls = [];
  const check = createCheckVendorResponse({
    findByTrackingId: async (trackingId) => {
      calls.push({ type: "tracking", trackingId });
      return { _id: "response-001" };
    },
    findByProposalAndEmail: async (input) => {
      calls.push({ type: "fallback", input });
      return null;
    },
  });

  const result = await check({
    proposalId: "proposal-001",
    email: "VENDOR@EXAMPLE.COM",
    trackingId: " campaign-token ",
  });

  assert.deepEqual(calls, [{ type: "tracking", trackingId: "campaign-token" }]);
  assert.equal(result.alreadySubmitted, true);
});

test("invalid public submission stops before storage or persistence", async () => {
  const capture = {};
  const submit = createSubmitVendorResponse(dependencies(capture));

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: " ",
    submittedBy: "Avery",
    email: "vendor@example.com",
    files: [{ originalname: "quote.pdf", path: "/tmp/quote" }],
  });

  assert.deepEqual(result, { kind: "invalid", field: "vendorName" });
  assert.equal(capture.upload, undefined);
  assert.equal(capture.save, undefined);
});

test("new submission normalizes data, scopes storage, and notifies planner", async () => {
  const capture = {};
  const submit = createSubmitVendorResponse(dependencies(capture));

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: "  AV Partners  ",
    submittedBy: "  Avery Vendor ",
    email: " SALES@AV.EXAMPLE ",
    message: "  Attached quote. ",
    trackingId: " tracking-001 ",
    files: [{ originalname: "quote (final).pdf", path: "/tmp/quote" }],
  });

  assert.equal(result.kind, "created");
  assert.equal(capture.upload.localPath, "/tmp/quote");
  assert.equal(
    capture.upload.objectKey,
    `DXG/vendor-responses-private/proposal-001/sources/${capture.save.newDocuments[0].sourceId}-0-quote__final_.pdf`,
  );
  assert.equal(capture.save.email, "sales@av.example");
  assert.equal(capture.save.vendorName, "AV Partners");
  assert.equal(capture.save.trackingId, "tracking-001");
  assert.equal(capture.save.newDocuments.length, 1);
  assert.equal(capture.save.newDocuments[0].sha256, "b".repeat(64));
  assert.match(capture.save.newDocuments[0].sourceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(capture.notification, {
    proposalId: "proposal-001",
    organizationId: "507f1f77bcf86cd799439011",
    ownerUserId: "planner-001",
    proposalTitle: "DXG Summit",
    responseId: "response-001",
    vendorName: "AV Partners",
    submittedBy: "Avery Vendor",
    email: "sales@av.example",
  });
  assert.equal(capture.confirmation.isUpdate, false);
});

test("existing submission creates an immutable next version without creating planner notification", async () => {
  const capture = {};
  const deps = dependencies(capture);
  deps.repository.findExisting = async () => ({
    _id: "response-existing",
    proposalTitle: "Original Summit",
    currentVersionId: "507f1f77bcf86cd799439013",
    currentVersionNumber: 1,
  });
  const submit = createSubmitVendorResponse(deps);

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: "AV Partners",
    submittedBy: "Avery",
    email: "vendor@example.com",
    message: "Revised",
    trackingId: "new-campaign",
    files: [],
  });

  assert.equal(result.kind, "version_created");
  assert.equal(result.submission.versionNumber, 2);
  assert.equal(capture.save.existingResponse._id, "response-existing");
  assert.equal(capture.save.trackingId, "new-campaign");
  assert.equal(capture.notification, undefined);
  assert.equal(capture.confirmation.isUpdate, true);
  assert.equal(capture.confirmation.proposalTitle, "DXG Summit");
});

test("infected upload rejects the submission before storage or persistence", async () => {
  const capture = {};
  const deps = dependencies(capture);
  const cleaned = [];
  deps.storage.cleanup = async (path) => {
    cleaned.push(path);
  };
  deps.malwareScan = async (path) =>
    path === "/tmp/malware" ? "infected" : "clean";
  const submit = createSubmitVendorResponse(deps);

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: "AV Partners",
    submittedBy: "Avery",
    email: "vendor@example.com",
    files: [
      { originalname: "quote.pdf", path: "/tmp/clean-quote" },
      { originalname: "payload.pdf", path: "/tmp/malware" },
    ],
  });

  assert.deepEqual(result, { kind: "infected", fileName: "payload.pdf" });
  assert.deepEqual(cleaned.sort(), ["/tmp/clean-quote", "/tmp/malware"]);
  assert.equal(capture.upload, undefined);
  assert.equal(capture.save, undefined);
  assert.equal(capture.notification, undefined);
});

test("unscannable upload rejects the submission before storage or persistence", async () => {
  const capture = {};
  const deps = dependencies(capture);
  const cleaned = [];
  deps.storage.cleanup = async (path) => {
    cleaned.push(path);
  };
  // Scanner unconfigured, down, or errored. This is the only unauthenticated
  // file intake in the system, so it must fail closed rather than store the
  // bytes and serve them to the planner later through a presigned URL.
  deps.malwareScan = async () => "unavailable";
  const submit = createSubmitVendorResponse(deps);

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: "AV Partners",
    submittedBy: "Avery",
    email: "vendor@example.com",
    files: [{ originalname: "quote.pdf", path: "/tmp/clean-quote" }],
  });

  assert.deepEqual(result, { kind: "scan_unavailable" });
  assert.deepEqual(cleaned, ["/tmp/clean-quote"]);
  assert.equal(capture.upload, undefined);
  assert.equal(capture.save, undefined);
  assert.equal(capture.notification, undefined);
});

test("clean scan outcome lets the submission proceed to storage", async () => {
  const capture = {};
  const deps = dependencies(capture);
  deps.malwareScan = async () => "clean";
  const submit = createSubmitVendorResponse(deps);

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: "AV Partners",
    submittedBy: "Avery",
    email: "vendor@example.com",
    files: [{ originalname: "quote.pdf", path: "/tmp/quote" }],
  });

  assert.equal(result.kind, "created");
  assert.equal(capture.save.newDocuments.length, 1);
});

test("failed attachment upload is cleaned up and submission can continue", async () => {
  const capture = {};
  const deps = dependencies(capture);
  deps.storage.upload = async () => {
    throw new Error("storage unavailable");
  };
  const submit = createSubmitVendorResponse(deps);

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: "AV Partners",
    submittedBy: "Avery",
    email: "vendor@example.com",
    files: [{ originalname: "quote.pdf", path: "/tmp/failed-upload" }],
  });

  assert.equal(result.kind, "created");
  assert.equal(capture.cleanup, "/tmp/failed-upload");
  assert.deepEqual(capture.save.newDocuments, []);
});

test("idempotent replay returns the original version before scanning or uploading", async () => {
  const capture = {};
  const deps = dependencies(capture);
  deps.malwareScan = async () => {
    capture.scanned = true;
    return "clean";
  };
  deps.repository.findVersionByIdempotencyKey = async () => ({
    submissionId: "507f1f77bcf86cd799439012",
    versionId: "507f1f77bcf86cd799439013",
    versionNumber: 1,
    parentVersionId: null,
    reason: "initial",
    receivedAt: new Date(123456).toISOString(),
    manifestChecksum: "a".repeat(64),
    proposalId: "proposal-001",
    organizationId: "507f1f77bcf86cd799439011",
    ownerUserId: "planner-001",
    proposalTitle: "DXG Summit",
    vendorName: "AV Partners",
    submittedBy: "Avery",
    email: "vendor@example.com",
    message: "Attached",
    documents: [],
    response: { _id: "response-001", currentVersionNumber: 1 },
  });
  const submit = createSubmitVendorResponse(deps);

  const result = await submit({
    proposalId: "proposal-001",
    vendorName: "AV Partners",
    submittedBy: "Avery",
    email: "vendor@example.com",
    message: "Attached",
    idempotencyKey: "retry-key",
    files: [{ originalname: "quote.pdf", path: "/tmp/retry", size: 1234 }],
  });

  assert.equal(result.kind, "duplicate");
  assert.equal(result.submission.versionId, "507f1f77bcf86cd799439013");
  assert.equal(capture.cleanup, "/tmp/retry");
  assert.equal(capture.scanned, undefined);
  assert.equal(capture.upload, undefined);
  assert.equal(capture.save, undefined);
});
