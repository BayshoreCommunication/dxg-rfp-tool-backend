const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  createGetOwnedVendorSubmissionDetail,
  createGetOwnedVendorResponse,
  createListOwnedVendorResponseProposals,
  createListOwnedVendorResponses,
} = require("../src/modules/vendorResponses/application/readVendorResponses");

test("proposal summary aggregation uses object identifiers for tenant matching", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "../src/modules/vendorResponses/infrastructure/mongo/mongoVendorResponseReadRepository.ts",
    ),
    "utf8",
  );
  assert.match(source, /organizationId:\s*tenantObjectId\(\)/);
});

test("vendor-response proposal summaries normalize paging and preserve complete counts", async () => {
  let repositoryInput;
  const list = createListOwnedVendorResponseProposals({
    listOwnedProposalSummaries: async (input) => {
      repositoryInput = input;
      return {
        proposals: [
          {
            proposalId: "proposal-001",
            proposalTitle: "Annual Summit",
            responseCount: 4,
            unreadCount: 2,
            latestResponseAt: "2026-08-16T10:00:00.000Z",
            latestVendorName: "Apex Events",
          },
        ],
        total: 13,
        responseCount: 45,
        unreadCount: 7,
      };
    },
  });

  const result = await list({
    ownerUserId: "planner-001",
    query: { page: "2", limit: "500", search: `  ${"x".repeat(150)}  ` },
  });

  assert.deepEqual(repositoryInput, {
    ownerUserId: "planner-001",
    search: "x".repeat(120),
    page: 2,
    limit: 50,
  });
  assert.deepEqual(result.pagination, {
    total: 13,
    page: 2,
    limit: 50,
    totalPages: 1,
  });
  assert.equal(result.responseCount, 45);
  assert.equal(result.unreadCount, 7);
  assert.equal(result.proposals[0].responseCount, 4);
});

test("vendor-response list normalizes filters and carries planner ownership", async () => {
  let repositoryInput;
  const list = createListOwnedVendorResponses({
    listOwned: async (input) => {
      repositoryInput = input;
      return {
        responses: [{ _id: "response-001" }],
        total: 45,
        unreadCount: 3,
        filteredUnreadCount: 2,
      };
    },
  });

  const result = await list({
    ownerUserId: "planner-001",
    query: {
      page: "2",
      limit: "500",
      unreadOnly: "true",
      proposalId: "proposal-001",
      campaignId: "campaign-001",
    },
  });

  assert.deepEqual(repositoryInput, {
    ownerUserId: "planner-001",
    unreadOnly: true,
    proposalId: "proposal-001",
    campaignId: "campaign-001",
    page: 2,
    limit: 100,
  });
  assert.deepEqual(result.pagination, {
    total: 45,
    page: 2,
    limit: 100,
    totalPages: 1,
  });
  assert.equal(result.unreadCount, 3);
  assert.equal(result.filteredUnreadCount, 2);
});

test("invalid vendor-response paging uses safe defaults", async () => {
  let repositoryInput;
  const list = createListOwnedVendorResponses({
    listOwned: async (input) => {
      repositoryInput = input;
      return {
        responses: [],
        total: 0,
        unreadCount: 0,
        filteredUnreadCount: 0,
      };
    },
  });

  await list({
    ownerUserId: "planner-001",
    query: { page: "-3", limit: "0", unreadOnly: "yes" },
  });

  assert.equal(repositoryInput.ownerUserId, "planner-001");
  assert.equal(repositoryInput.page, 1);
  assert.equal(repositoryInput.limit, 20);
  assert.equal(repositoryInput.unreadOnly, false);
});

test("private document urls are presigned while legacy urls pass through", async () => {
  const signer = {
    presignDocumentUrl: async (url) =>
      url.includes("/vendor-responses-private/")
        ? `${url}?signed=short-lived`
        : url,
  };
  const list = createListOwnedVendorResponses(
    {
      listOwned: async () => ({
        responses: [
          {
            _id: "response-001",
            documents: [
              {
                name: "quote.pdf",
                url: "https://bucket.region.digitaloceanspaces.com/DXG/vendor-responses-private/p1/1-0-quote.pdf",
              },
              {
                name: "legacy.pdf",
                url: "https://bucket.region.digitaloceanspaces.com/DXG/vendor-responses/p1/1-0-legacy.pdf",
              },
            ],
          },
        ],
        total: 1,
        unreadCount: 0,
        filteredUnreadCount: 0,
      }),
    },
    signer,
  );

  const result = await list({ ownerUserId: "planner-001", query: {} });

  assert.equal(
    result.responses[0].documents[0].url,
    "https://bucket.region.digitaloceanspaces.com/DXG/vendor-responses-private/p1/1-0-quote.pdf?signed=short-lived",
  );
  assert.equal(
    result.responses[0].documents[1].url,
    "https://bucket.region.digitaloceanspaces.com/DXG/vendor-responses/p1/1-0-legacy.pdf",
  );
});

test("detail read presigns private documents on the marked-read record", async () => {
  const getResponse = createGetOwnedVendorResponse(
    {
      markOwnedRead: async () => ({
        _id: "response-001",
        documents: [
          {
            name: "quote.pdf",
            url: "https://bucket.region.digitaloceanspaces.com/DXG/vendor-responses-private/p1/1-0-quote.pdf",
          },
        ],
      }),
    },
    {
      presignDocumentUrl: async (url) => `${url}?signed=1`,
    },
  );

  const result = await getResponse({
    responseId: "response-001",
    ownerUserId: "planner-001",
  });

  assert.equal(result.kind, "found");
  assert.equal(
    result.response.documents[0].url,
    "https://bucket.region.digitaloceanspaces.com/DXG/vendor-responses-private/p1/1-0-quote.pdf?signed=1",
  );
});

test("vendor-response detail read is owner-scoped and hides cross-owner records", async () => {
  let repositoryInput;
  const getResponse = createGetOwnedVendorResponse({
    markOwnedRead: async (input) => {
      repositoryInput = input;
      return null;
    },
  });

  const result = await getResponse({
    responseId: "response-other-owner",
    ownerUserId: "planner-001",
  });

  assert.deepEqual(repositoryInput, {
    responseId: "response-other-owner",
    ownerUserId: "planner-001",
  });
  assert.deepEqual(result, { kind: "not_found" });
});

test("submission detail returns immutable versions with separately signed documents", async () => {
  const detail = createGetOwnedVendorSubmissionDetail(
    {
      markOwnedRead: async () => ({ _id: "response-001", documents: [] }),
      getOwnedSubmissionTimeline: async () => ({
        submission: {
          submissionId: "submission-001",
          status: "active",
          currentVersionId: "version-002",
          currentVersionNumber: 2,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
        versions: [
          {
            versionId: "version-002",
            versionNumber: 2,
            parentVersionId: "version-001",
            reason: "clarification_response",
            sourceSystem: "public_portal",
            receivedAt: "2026-08-02T00:00:00.000Z",
            manifestChecksum: "a".repeat(64),
            vendorName: "Apex",
            submittedBy: "Alex",
            email: "alex@example.com",
            message: "Clarification",
            documents: [
              {
                name: "clarification.pdf",
                url: "private/clarification.pdf",
                scanStatus: "clean",
              },
            ],
          },
        ],
      }),
    },
    { presignDocumentUrl: async (url) => `${url}?signed=1` },
  );
  const result = await detail({
    responseId: "response-001",
    ownerUserId: "planner-001",
  });
  assert.equal(result.kind, "found");
  assert.equal(result.detail.versions[0].reason, "clarification_response");
  assert.equal(
    result.detail.versions[0].documents[0].url,
    "private/clarification.pdf?signed=1",
  );
});

test("submission detail fails closed before timeline reads for another owner", async () => {
  let timelineRead = false;
  const detail = createGetOwnedVendorSubmissionDetail({
    markOwnedRead: async () => null,
    getOwnedSubmissionTimeline: async () => {
      timelineRead = true;
      return null;
    },
  });
  const result = await detail({
    responseId: "response-other-owner",
    ownerUserId: "planner-001",
  });
  assert.deepEqual(result, { kind: "not_found" });
  assert.equal(timelineRead, false);
});
