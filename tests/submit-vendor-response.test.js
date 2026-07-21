const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createCheckVendorResponse,
  createSubmitVendorResponse,
} = require("../src/modules/vendorResponses/application/submitVendorResponse");

const dependencies = (capture = {}) => ({
  folderName: "/DXG/",
  now: () => 123456,
  repository: {
    findExisting: async () => null,
    findByTrackingId: async () => null,
    findByProposalAndEmail: async () => null,
    updateExisting: async (input) => {
      capture.update = input;
      return { _id: input.responseId, proposalTitle: "Summit" };
    },
    findProposal: async (proposalId) => ({
      proposalId,
      ownerUserId: "planner-001",
      proposalTitle: "DXG Summit",
    }),
    create: async (input) => {
      capture.create = input;
      return { _id: "response-001", ...input };
    },
  },
  storage: {
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
  assert.equal(capture.create, undefined);
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
  assert.deepEqual(capture.upload, {
    localPath: "/tmp/quote",
    objectKey:
      "DXG/vendor-responses-private/proposal-001/123456-0-quote__final_.pdf",
  });
  assert.equal(capture.create.email, "sales@av.example");
  assert.equal(capture.create.vendorName, "AV Partners");
  assert.equal(capture.create.trackingId, "tracking-001");
  assert.equal(capture.create.documents.length, 1);
  assert.deepEqual(capture.notification, {
    proposalId: "proposal-001",
    ownerUserId: "planner-001",
    proposalTitle: "DXG Summit",
    responseId: "response-001",
    vendorName: "AV Partners",
    submittedBy: "Avery Vendor",
    email: "sales@av.example",
  });
  assert.equal(capture.confirmation.isUpdate, false);
});

test("existing submission updates without creating planner notification", async () => {
  const capture = {};
  const deps = dependencies(capture);
  deps.repository.findExisting = async () => ({
    _id: "response-existing",
    proposalTitle: "Original Summit",
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

  assert.equal(result.kind, "updated");
  assert.equal(capture.update.responseId, "response-existing");
  assert.equal(capture.update.trackingId, "new-campaign");
  assert.equal(capture.notification, undefined);
  assert.equal(capture.confirmation.isUpdate, true);
  assert.equal(capture.confirmation.proposalTitle, "Original Summit");
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
  assert.equal(capture.create, undefined);
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
  assert.equal(capture.create.documents.length, 1);
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
  assert.deepEqual(capture.create.documents, []);
});
