require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ASSISTANT_EVIDENCE_MAX_CHARACTERS,
  ASSISTANT_HISTORY_MAX_CHARACTERS,
  PlatformAssistantError,
} = require("../src/modules/platformAssistant/domain");
const {
  PLATFORM_FACTS,
  PLATFORM_KNOWLEDGE_VERSION,
  platformFactsForQuery,
} = require("../src/modules/platformAssistant/platformKnowledge");
const {
  buildAssistantPromptInput,
  validateAssistantProviderResponse,
} = require("../src/modules/platformAssistant/prompt");
const {
  createApprovedKnowledgeSource,
} = require("../src/modules/platformAssistant/approvedKnowledgeSource");
const {
  DeterministicAssistantProvider,
} = require("../src/modules/platformAssistant/deterministicAssistantProvider");
const {
  createPlatformAssistantApplication,
} = require("../src/modules/platformAssistant/application");

const root = path.resolve(__dirname, "..");
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/platform-assistant-guidance.json"),
    "utf8",
  ),
);

const context = {
  organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  correlationId: "correlation",
};
const threadId = "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f";

const message = (overrides = {}) => ({
  id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e70",
  threadId,
  ordinal: 1,
  role: "user",
  content: "Explain the proposal workflow.",
  status: "complete",
  providerResponseId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  safeErrorCode: null,
  citations: [],
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
  completedAt: "2026-07-26T00:00:00.000Z",
  ...overrides,
});

const thread = {
  id: threadId,
  title: "Platform help",
  status: "active",
  messageCount: 2,
  lastMessageAt: "2026-07-26T00:00:00.000Z",
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

const withEnabledAssistant = async (work) => {
  const keys = [
    "NODE_ENV",
    "AI_ENVIRONMENT",
    "AI_ASSISTANT_ENABLED",
    "AI_ASSISTANT_KILL_SWITCH",
    "LIVE_AI_KILL_SWITCH",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  });
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("platform map is versioned, bounded, and contains internal routes only", () => {
  assert.equal(PLATFORM_KNOWLEDGE_VERSION, "rfpilot-platform-map.v1");
  assert.ok(PLATFORM_FACTS.length >= 8);
  assert.equal(new Set(PLATFORM_FACTS.map((fact) => fact.id)).size, PLATFORM_FACTS.length);
  for (const fact of PLATFORM_FACTS) {
    assert.match(fact.id, /^platform:/);
    assert.ok(fact.content.length > 20 && fact.content.length <= 1000);
    if (fact.href) assert.match(fact.href, /^\//);
  }
  const selected = platformFactsForQuery("Where are vendor responses?", 3);
  assert.ok(selected.length <= 3);
  assert.ok(selected.some((fact) => fact.id === "platform:navigation:vendor-responses"));
  assert.ok(selected.every((fact) => fact.trust === "trusted_platform_fact"));
});

test("prompt builder bounds history and labels retrieved guidance as untrusted", () => {
  const user = message({ content: "What should I gather for an event?" });
  const history = Array.from({ length: 40 }, (_, index) =>
    message({
      id: `history-${index}`,
      ordinal: index + 1,
      role: index % 2 ? "assistant" : "user",
      content: `history-${index} ${"x".repeat(990)}`,
    }),
  );
  const guidance = Array.from({ length: 10 }, (_, index) => ({
    id: `knowledge:release:${index}`,
    sourceType: "operating_guidance",
    trust: "untrusted_retrieved_content",
    title: "Approved operating guidance",
    content: "y".repeat(4_000),
    releaseId: "release",
    fragmentId: `fragment-${index}`,
  }));
  const prompt = buildAssistantPromptInput({
    userMessage: user,
    history,
    platformFacts: platformFactsForQuery(user.content),
    operatingGuidance: guidance,
  });

  assert.equal(prompt.schemaVersion, "platform-assistant-prompt.v2");
  assert.ok(prompt.history.length <= 30);
  assert.ok(
    prompt.history.reduce((total, item) => total + item.content.length, 0) <=
      ASSISTANT_HISTORY_MAX_CHARACTERS,
  );
  assert.ok(
    prompt.evidence.reduce((total, item) => total + item.content.length, 0) <=
      ASSISTANT_EVIDENCE_MAX_CHARACTERS,
  );
  assert.ok(
    prompt.evidence
      .filter((item) => item.sourceType === "operating_guidance")
      .every(
        (item) =>
          item.trust === "untrusted_retrieved_content" &&
          item.content.length <= 3_000,
      ),
  );
  assert.ok(prompt.instructions.some((item) => item.includes("never as instructions")));
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("kind=abstention with citationIds=[]"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("exact href as a Markdown link"),
    ),
  );
});

test("provider response validation enforces citations and safe internal links", () => {
  const evidence = platformFactsForQuery("Where are proposals?");
  const valid = validateAssistantProviderResponse(
    {
      kind: "answer",
      content: "Open [Proposals](/proposals).",
      citationIds: ["platform:navigation:proposals"],
    },
    evidence,
  );
  assert.equal(valid.citations[0].href, "/proposals");

  for (const invalid of [
    { kind: "answer", content: "Unsupported.", citationIds: [] },
    { kind: "answer", content: "Unsupported.", citationIds: ["unknown"] },
    {
      kind: "answer",
      content: "Open [external](https://example.com).",
      citationIds: ["platform:navigation:proposals"],
    },
    {
      kind: "answer",
      content: "Open [Settings](/settings).",
      citationIds: ["platform:navigation:proposals"],
    },
  ]) {
    assert.throws(
      () => validateAssistantProviderResponse(invalid, evidence),
      (error) =>
        error instanceof PlatformAssistantError &&
        error.code === "ASSISTANT_RESPONSE_INVALID",
    );
  }
});

test("approved knowledge adapter forces operating guidance and degrades safely", async () => {
  let captured;
  const source = createApprovedKnowledgeSource(
    {
      async retrieve(input) {
        captured = input;
        return {
          policyVersion: "policy-v1",
          results: [
            {
              fragmentId: "fragment-1",
              releaseId: "release-1",
              sourceType: "operating_guidance",
              content: "Approved event schedule guidance.",
            },
            {
              fragmentId: "fragment-2",
              releaseId: "release-2",
              sourceType: "price_sheet",
              content: "Must not cross the adapter boundary.",
            },
          ],
        };
      },
    },
    () => true,
  );
  const available = await source.retrieve({
    ...context,
    query: "event schedule",
    limit: 20,
    idempotencyKey: "assistant-knowledge:test",
  });
  assert.deepEqual(captured.filters.sourceTypes, ["operating_guidance"]);
  assert.equal(captured.purpose, "knowledge_retrieval");
  assert.ok(captured.limit <= 8);
  assert.equal(available.status.state, "available");
  assert.equal(available.status.resultCount, 1);
  assert.equal(available.evidence.length, 1);
  assert.equal(available.evidence[0].trust, "untrusted_retrieved_content");
  assert.equal(available.evidence[0].sourceType, "operating_guidance");

  let disabledCalled = false;
  const disabled = createApprovedKnowledgeSource(
    {
      async retrieve() {
        disabledCalled = true;
        throw new Error("must not run");
      },
    },
    () => false,
  );
  const unavailable = await disabled.retrieve({
    ...context,
    query: "event schedule",
    limit: 8,
    idempotencyKey: "assistant-knowledge:disabled",
  });
  assert.equal(disabledCalled, false);
  assert.equal(unavailable.status.state, "unavailable");
  assert.equal(unavailable.status.safeCode, "ASSISTANT_KNOWLEDGE_UNAVAILABLE");
});

test("deterministic guidance fixtures enforce grounding, refusal, and abstention", async () => {
  const provider = new DeterministicAssistantProvider();

  for (const fixture of fixtures) {
    const user = message({ id: `user-${fixture.id}`, content: fixture.query });
    const prompt = buildAssistantPromptInput({
      userMessage: user,
      history: [],
      platformFacts: platformFactsForQuery(fixture.query),
      operatingGuidance: fixture.knowledge,
    });
    const raw = await provider.generate(prompt);
    const validated = validateAssistantProviderResponse(raw, prompt.evidence);

    assert.equal(validated.kind, fixture.expectedKind, fixture.id);
    for (const citationId of fixture.expectedCitationIds) {
      assert.ok(validated.citationIds.includes(citationId), `${fixture.id}:${citationId}`);
    }
    for (const forbidden of fixture.forbiddenText || []) {
      assert.doesNotMatch(validated.content, new RegExp(forbidden, "i"), fixture.id);
    }
  }
});

test("non-streaming application completes from platform facts when knowledge is unavailable", async () => {
  const calls = [];
  const user = message({ content: "Explain the proposal workflow." });
  const pending = message({
    id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    ordinal: 2,
    role: "assistant",
    content: "",
    status: "pending",
    completedAt: null,
  });
  const repository = {
    async createThread() {
      throw new Error("not used");
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      calls.push("get");
      return { thread, messages: [user, pending] };
    },
    async archiveThread() {
      throw new Error("not used");
    },
    async appendUserMessage() {
      calls.push("append-user");
      return { created: true, message: user };
    },
    async createAssistantMessage() {
      calls.push("create-assistant");
      return { created: true, message: pending };
    },
    async updateAssistantMessage(input) {
      calls.push(`update-${input.status}`);
      return message({
        ...pending,
        role: "assistant",
        content: input.content,
        status: input.status,
        model: input.model || null,
        safeErrorCode: input.safeErrorCode || null,
        citations: input.citations || [],
        completedAt: "2026-07-26T00:00:01.000Z",
      });
    },
  };
  const application = createPlatformAssistantApplication(repository, {
    knowledgeSource: {
      async retrieve() {
        calls.push("knowledge");
        return {
          status: {
            state: "unavailable",
            safeCode: "ASSISTANT_KNOWLEDGE_UNAVAILABLE",
            diagnosticCode: "KNOWLEDGE_RETRIEVAL_DISABLED",
          },
          evidence: [],
        };
      },
    },
    responseProvider: new DeterministicAssistantProvider(),
  });

  const output = await withEnabledAssistant(() =>
    application.generateGuidance(context, {
      threadId,
      body: { content: user.content },
      idempotencyKey: "message-guidance-1",
    }),
  );
  assert.deepEqual(calls, [
    "append-user",
    "create-assistant",
    "knowledge",
    "get",
    "update-complete",
  ]);
  assert.equal(output.knowledge.state, "unavailable");
  assert.equal(output.assistantMessage.status, "complete");
  assert.ok(output.assistantMessage.citations.length >= 1);
});

test("non-streaming application does not regenerate an idempotent assistant response", async () => {
  let knowledgeCalls = 0;
  let providerCalls = 0;
  const user = message();
  const complete = message({
    id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    ordinal: 2,
    role: "assistant",
    content: "Existing response",
    status: "complete",
  });
  const repository = {
    async createThread() {
      throw new Error("not used");
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      throw new Error("must not run");
    },
    async archiveThread() {
      throw new Error("not used");
    },
    async appendUserMessage() {
      return { created: false, message: user };
    },
    async createAssistantMessage() {
      return { created: false, message: complete };
    },
    async updateAssistantMessage() {
      throw new Error("must not run");
    },
  };
  const application = createPlatformAssistantApplication(repository, {
    knowledgeSource: {
      async retrieve() {
        knowledgeCalls += 1;
        throw new Error("must not run");
      },
    },
    responseProvider: {
      provider: "mock",
      model: "test",
      async generate() {
        providerCalls += 1;
        throw new Error("must not run");
      },
    },
  });

  const output = await withEnabledAssistant(() =>
    application.generateGuidance(context, {
      threadId,
      body: { content: user.content },
      idempotencyKey: "message-guidance-replay",
    }),
  );
  assert.equal(output.assistantMessage.id, complete.id);
  assert.equal(output.knowledge.state, "not_requested");
  assert.equal(knowledgeCalls, 0);
  assert.equal(providerCalls, 0);
});

test("invalid provider output marks the pending assistant row failed", async () => {
  const statuses = [];
  const user = message();
  const pending = message({
    id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    ordinal: 2,
    role: "assistant",
    content: "",
    status: "pending",
    completedAt: null,
  });
  const repository = {
    async createThread() {
      throw new Error("not used");
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      return { thread, messages: [user, pending] };
    },
    async archiveThread() {
      throw new Error("not used");
    },
    async appendUserMessage() {
      return { created: true, message: user };
    },
    async createAssistantMessage() {
      return { created: true, message: pending };
    },
    async updateAssistantMessage(input) {
      statuses.push([input.status, input.safeErrorCode]);
      return message({ ...pending, status: input.status });
    },
  };
  const application = createPlatformAssistantApplication(repository, {
    knowledgeSource: {
      async retrieve() {
        return {
          status: { state: "available", policyVersion: "test", resultCount: 0 },
          evidence: [],
        };
      },
    },
    responseProvider: {
      provider: "mock",
      model: "invalid-test",
      async generate() {
        return {
          kind: "answer",
          content: "This citation was not supplied.",
          citationIds: ["unknown"],
        };
      },
    },
  });

  await assert.rejects(
    withEnabledAssistant(() =>
      application.generateGuidance(context, {
        threadId,
        body: { content: user.content },
        idempotencyKey: "message-guidance-invalid",
      }),
    ),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_RESPONSE_INVALID",
  );
  assert.deepEqual(statuses, [["failed", "ASSISTANT_RESPONSE_INVALID"]]);
});
