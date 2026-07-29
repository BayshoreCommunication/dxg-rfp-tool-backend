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
