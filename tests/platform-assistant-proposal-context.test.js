require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAssistantProposalContextSource,
} = require("../src/modules/platformAssistant/selectedProposalSource");

const context = {
  organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  correlationId: "proposal-context-test",
};

const proposal = (name, overrides = {}) => ({
  status: "unsubmitted",
  isDraft: true,
  version: 3,
  event: {
    eventName: name,
    eventFormat: "Hybrid",
    attendees: "1500",
    startDate: "2027-05-12",
    endDate: "2027-05-14",
  },
  venueSchedule: { city: "Chicago" },
  production: { audio: "Main stage PA" },
  contact: { contactEmail: "private@example.com" },
  uploads: { objectKey: "private-source-key" },
  ...overrides,
});

test("resolves an exact user-named proposal from mixed-language text", async () => {
  const source = createAssistantProposalContextSource(async () => [
    proposal("Momentum 2027 Sales Kickoff"),
    proposal("Launchpad 2027"),
  ]);

  const result = await source.resolve({
    ...context,
    query: "Momentum 2027 Sales Kickoff ei proposal somporke bolo",
    recentUserMessages: [],
  });

  assert.equal(result.state, "matched");
  assert.equal(result.proposalName, "Momentum 2027 Sales Kickoff");
  assert.equal(result.evidence[0].id, "selected-proposal:overview");
  assert.equal(result.evidence[0].sourceType, "selected_proposal");
  assert.match(result.evidence[0].content, /Momentum 2027 Sales Kickoff/);
  assert.match(result.evidence[0].content, /1500/);
  const readiness = result.evidence.find(
    (item) => item.id === "selected-proposal:readiness",
  );
  assert.ok(readiness);
  assert.doesNotMatch(readiness.content, /contact|upload/i);
  assert.doesNotMatch(
    result.evidence.map((item) => item.content).join("\n"),
    /private@example\.com|private-source-key/,
  );
});

test("prefers the longest exact proposal title contained in the message", async () => {
  const source = createAssistantProposalContextSource(async () => [
    proposal("Momentum"),
    proposal("Momentum 2027 Sales Kickoff"),
  ]);

  const result = await source.resolve({
    ...context,
    query: "Tell me about Momentum 2027 Sales Kickoff proposal",
    recentUserMessages: [],
  });

  assert.equal(result.state, "matched");
  assert.equal(result.proposalName, "Momentum 2027 Sales Kickoff");
});

test("does not guess when duplicate owned proposals have the same title", async () => {
  const source = createAssistantProposalContextSource(async () => [
    proposal("Annual Summit"),
    proposal("Annual Summit", { version: 7 }),
  ]);

  const result = await source.resolve({
    ...context,
    query: "Summarize the Annual Summit proposal",
    recentUserMessages: [],
  });

  assert.equal(result.state, "ambiguous");
  assert.equal(result.evidence.length, 0);
});

test("prefers the only active submitted proposal when duplicate titles exist", async () => {
  const source = createAssistantProposalContextSource(async () => [
    proposal("Northstar Leadership Summit 2026"),
    proposal("Northstar Leadership Summit 2026", {
      status: "submitted",
      isDraft: false,
      isActive: true,
      version: 8,
    }),
    proposal("Northstar Leadership Summit 2026", { version: 7 }),
  ]);

  const result = await source.resolve({
    ...context,
    query: "Northstar Leadership Summit 2026",
    recentUserMessages: [],
  });

  assert.equal(result.state, "matched");
  assert.equal(result.proposalName, "Northstar Leadership Summit 2026");
  assert.match(result.evidence[0].content, /"proposalVersion":8/);
});

test("keeps the matched proposal available for a follow-up turn", async () => {
  const source = createAssistantProposalContextSource(async () => [
    proposal("Momentum 2027 Sales Kickoff"),
  ]);

  const result = await source.resolve({
    ...context,
    query: "What is missing?",
    recentUserMessages: [
      "Tell me about Momentum 2027 Sales Kickoff proposal",
    ],
  });

  assert.equal(result.state, "matched");
  assert.equal(result.proposalName, "Momentum 2027 Sales Kickoff");
});

test("returns no evidence when no authorized proposal title matches", async () => {
  const source = createAssistantProposalContextSource(async () => [
    proposal("Launchpad 2027"),
  ]);

  const result = await source.resolve({
    ...context,
    query: "Tell me about a proposal owned by somebody else",
    recentUserMessages: [],
  });

  assert.deepEqual(result, { state: "not_found", evidence: [] });
});

test("returns an exact portfolio count before considering named proposal history", async () => {
  let namedReads = 0;
  let countReads = 0;
  const source = createAssistantProposalContextSource({
    async findOwnedProposals() {
      namedReads += 1;
      return [proposal("Momentum 2027 Sales Kickoff")];
    },
    async countOwnedProposals(input) {
      countReads += 1;
      assert.equal(input.actorUserMongoId, context.actorUserMongoId);
      assert.equal(input.organizationMongoId, context.organizationMongoId);
      return {
        totalCreated: 83,
        all: 68,
        draft: 48,
        live: 4,
        favorite: 0,
        expired: 16,
        archive: 14,
        saved: 1,
      };
    },
  });

  const result = await source.resolve({
    ...context,
    query: "How many proposals have I created?",
    recentUserMessages: [
      "Tell me about Momentum 2027 Sales Kickoff proposal",
    ],
  });

  assert.equal(result.state, "portfolio_summary");
  assert.equal(namedReads, 0);
  assert.equal(countReads, 1);
  assert.equal(result.evidence[0].id, "proposal-portfolio:counts");
  assert.equal(result.evidence[0].sourceType, "proposal_portfolio");
  assert.equal(result.evidence[0].trust, "authorized_private_data");
  assert.equal(result.evidence[0].href, "/proposals");
  assert.deepEqual(JSON.parse(result.evidence[0].content), {
    schemaVersion: "assistant-proposal-portfolio.v1",
    scope: "authenticated_owner_and_organization",
    totalCreated: 83,
    mainList: 68,
    draft: 48,
    live: 4,
    favorite: 0,
    expired: 16,
    archived: 14,
    savedCopies: 1,
  });
});

test("recognizes common proposal-count typing mistakes", async () => {
  let countReads = 0;
  const source = createAssistantProposalContextSource({
    async findOwnedProposals() {
      throw new Error("count questions must not scan proposal names");
    },
    async countOwnedProposals() {
      countReads += 1;
      return {
        totalCreated: 83,
        all: 68,
        draft: 48,
        live: 3,
        favorite: 0,
        expired: 17,
        archive: 14,
        saved: 1,
      };
    },
  });

  const result = await source.resolve({
    ...context,
    query: "how manny proposel do i hav?",
    recentUserMessages: [],
  });

  assert.equal(result.state, "portfolio_summary");
  assert.equal(countReads, 1);
  assert.equal(JSON.parse(result.evidence[0].content).totalCreated, 83);
});

test("carries count evidence into an immediate formatting follow-up", async () => {
  const source = createAssistantProposalContextSource({
    async findOwnedProposals() {
      throw new Error("count follow-ups must not scan proposal names");
    },
    async countOwnedProposals() {
      return {
        totalCreated: 83,
        all: 68,
        draft: 48,
        live: 3,
        favorite: 0,
        expired: 17,
        archive: 14,
        saved: 1,
      };
    },
  });

  const result = await source.resolve({
    ...context,
    query: "Make that answer one short sentence.",
    recentUserMessages: ["how manny proposel do i hav?"],
  });

  assert.equal(result.state, "portfolio_summary");
  assert.equal(JSON.parse(result.evidence[0].content).totalCreated, 83);
});

test("derives proposal counts from bounded candidates for injected sources", async () => {
  const source = createAssistantProposalContextSource(async () => [
    proposal("Draft one"),
    proposal("Live one", {
      status: "submitted",
      isDraft: false,
      isActive: true,
    }),
    proposal("Expired one", {
      status: "submitted",
      isDraft: false,
      isActive: false,
    }),
    proposal("Archived one", { isArchived: true }),
    proposal("Saved one", { isCopy: true }),
  ]);

  const result = await source.resolve({
    ...context,
    query: "What is my proposal count?",
    recentUserMessages: [],
  });

  assert.equal(result.state, "portfolio_summary");
  assert.deepEqual(JSON.parse(result.evidence[0].content), {
    schemaVersion: "assistant-proposal-portfolio.v1",
    scope: "authenticated_owner_and_organization",
    totalCreated: 5,
    mainList: 3,
    draft: 1,
    live: 1,
    favorite: 0,
    expired: 1,
    archived: 1,
    savedCopies: 1,
  });
});
