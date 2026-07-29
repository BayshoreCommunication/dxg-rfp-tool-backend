require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPlatformAssistantStreamingApplication,
} = require("../src/modules/platformAssistant/streamingApplication");

const context = {
  organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  correlationId: "correlation-stream-app",
};
const threadId = "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f";

const message = (overrides = {}) => ({
  id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e70",
  threadId,
  ordinal: 1,
  role: "user",
  content: "Where are proposals?",
  status: "complete",
  providerResponseId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  safeErrorCode: null,
  citations: [],
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  completedAt: "2026-07-27T00:00:00.000Z",
  ...overrides,
});

const thread = {
  id: threadId,
  title: "Platform help",
  status: "active",
  messageCount: 2,
  lastMessageAt: "2026-07-27T00:00:00.000Z",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const withEnabledAssistant = async (work) => {
  const values = {
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "*",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  };
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const setup = (providerEvents, options = {}) => {
  const user = message({
    content: options.userContent || "Where are proposals?",
  });
  const pending = message({
    id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    ordinal: 2,
    role: "assistant",
    content: "",
    status: "pending",
    completedAt: null,
  });
  const updates = [];
  const assistantPlaceholders = [];
  let providerCalls = 0;
  let capturedPrompt = null;
  const repository = {
    async createThread() {
      throw new Error("not used");
    },
    async listThreads() {
      throw new Error("not used");
    },
    async archiveThread() {
      throw new Error("not used");
    },
    async appendUserMessage() {
      return { created: true, message: user };
    },
    async createAssistantMessage(input) {
      assistantPlaceholders.push(input);
      return {
        created: options.placeholderCreated ?? true,
        message: options.placeholder || pending,
      };
    },
    async getThread() {
      return { thread, messages: [user, pending] };
    },
    async updateAssistantMessage(input) {
      updates.push(input);
      return message({
        ...pending,
        content: input.content,
        status: input.status,
        providerResponseId: input.providerResponseId || null,
        model: input.model || null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        safeErrorCode: input.safeErrorCode || null,
        citations: input.citations || [],
        completedAt: ["complete", "failed", "aborted"].includes(input.status)
          ? "2026-07-27T00:00:01.000Z"
          : null,
      });
    },
  };
  const provider = {
    provider: "fake",
    model: "fake-model",
    async *stream(prompt) {
      providerCalls += 1;
      capturedPrompt = prompt;
      for (const event of providerEvents) yield event;
    },
  };
  const application = createPlatformAssistantStreamingApplication(repository, {
    knowledgeSource: {
      async retrieve() {
        return {
          status: { state: "available", policyVersion: null, resultCount: 0 },
          evidence: [],
        };
      },
    },
    responseProvider: provider,
    ...(options.proposalContextSource
      ? { proposalContextSource: options.proposalContextSource }
      : {}),
  });
  return {
    application,
    updates,
    assistantPlaceholders,
    providerCalls: () => providerCalls,
    capturedPrompt: () => capturedPrompt,
    pending,
    user,
  };
};

test("streaming application injects matched proposal evidence and promotes the intent", async () => {
  await withEnabledAssistant(async () => {
    const content =
      "The saved proposal is a Hybrid event for 1,500 attendees.";
    const setupResult = setup(
      [
        {
          type: "started",
          providerResponseId: "resp_proposal",
          model: "effective-model",
        },
        { type: "text_delta", delta: content },
        {
          type: "completed",
          providerResponseId: "resp_proposal",
          model: "effective-model",
          usage: { inputTokens: 30, outputTokens: 12 },
          output: {
            kind: "answer",
            content,
            citationIds: ["selected-proposal:overview"],
          },
        },
      ],
      {
        userContent:
          "Momentum 2027 Sales Kickoff ei proposal somporke bolo",
        proposalContextSource: {
          async resolve(input) {
            assert.equal(
              input.query,
              "Momentum 2027 Sales Kickoff ei proposal somporke bolo",
            );
            return {
              state: "matched",
              proposalName: "Momentum 2027 Sales Kickoff",
              evidence: [
                {
                  id: "selected-proposal:overview",
                  sourceType: "selected_proposal",
                  trust: "authorized_private_data",
                  title:
                    "Selected proposal: Momentum 2027 Sales Kickoff",
                  content:
                    '{"proposalName":"Momentum 2027 Sales Kickoff","event":{"eventFormat":"Hybrid","attendees":"1500"}}',
                  href: "/proposals",
                },
              ],
            };
          },
        },
      },
    );

    const output = await invoke(
      setupResult.application,
      new AbortController().signal,
      undefined,
      "Momentum 2027 Sales Kickoff ei proposal somporke bolo",
    );
    const prompt = setupResult.capturedPrompt();

    assert.equal(prompt.intent.intent, "proposal_specific_request");
    assert.equal(prompt.evidence[0].id, "selected-proposal:overview");
    assert.equal(output.result.assistantMessage.status, "complete");
    assert.equal(
      output.result.assistantMessage.citations[0].sourceId,
      "selected-proposal:overview",
    );
  });
});

test("streaming application bypasses the model for exact proposal counts", async () => {
  await withEnabledAssistant(async () => {
    const setupResult = setup(
      [
        {
          type: "failed",
          code: "ASSISTANT_PROVIDER_FAILED",
          retryable: true,
        },
      ],
      {
        userContent: "How many proposals have I created?",
        proposalContextSource: {
          async resolve(input) {
            assert.equal(input.query, "How many proposals have I created?");
            return {
              state: "portfolio_summary",
              evidence: [
                {
                  id: "proposal-portfolio:counts",
                  sourceType: "proposal_portfolio",
                  trust: "authorized_private_data",
                  title: "Your proposal counts",
                  content: JSON.stringify({
                    totalCreated: 83,
                    mainList: 68,
                    draft: 48,
                    live: 4,
                    expired: 16,
                    archived: 14,
                    savedCopies: 1,
                  }),
                  href: "/proposals",
                },
              ],
            };
          },
        },
      },
    );

    const output = await invoke(
      setupResult.application,
      new AbortController().signal,
      undefined,
      "How many proposals have I created?",
    );

    assert.equal(setupResult.providerCalls(), 0);
    assert.equal(output.result.assistantMessage.status, "complete");
    assert.equal(
      output.result.assistantMessage.model,
      "platform-assistant-deterministic-v1",
    );
    assert.match(
      output.result.assistantMessage.content,
      /\*\*83 proposals\*\*/,
    );
    assert.ok(
      output.result.assistantMessage.citations.some(
        (item) => item.sourceId === "proposal-portfolio:counts",
      ),
    );
    assert.ok(
      output.events.some(
        (event) =>
          event.type === "response.delta" &&
          event.delta.includes("83 proposals"),
      ),
    );
    assert.equal(
      output.events.at(-1).type,
      "response.completed",
    );
  });
});

const invoke = async (
  application,
  signal = new AbortController().signal,
  responseIdempotencyKey,
  content = "Where are proposals?",
) => {
  const events = [];
  const result = await application.streamGuidance(context, {
    threadId,
    body: { content },
    idempotencyKey: "stream-app-test",
    ...(responseIdempotencyKey ? { responseIdempotencyKey } : {}),
    signal,
    emit(event) {
      events.push(event);
    },
  });
  return { events, result };
};

test("streaming application persists only lifecycle boundaries and completes atomically", async () => {
  await withEnabledAssistant(async () => {
    const content = "Open [Proposals](/proposals).";
    const setupResult = setup([
      {
        type: "started",
        providerResponseId: "resp_1",
        model: "effective-model",
      },
      { type: "text_delta", delta: "Open [Proposals]" },
      { type: "text_delta", delta: "(/proposals)." },
      {
        type: "completed",
        providerResponseId: "resp_1",
        model: "effective-model",
        usage: { inputTokens: 20, outputTokens: 8 },
        output: {
          kind: "answer",
          content,
          citationIds: ["platform:navigation:proposals"],
        },
      },
    ]);
    const { events, result } = await invoke(setupResult.application);

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "message.accepted",
        "response.started",
        "response.delta",
        "response.delta",
        "response.completed",
      ],
    );
    assert.equal(
      events
        .filter((event) => event.type === "response.delta")
        .map((event) => event.delta)
        .join(""),
      content,
    );
    assert.equal(setupResult.updates.length, 2);
    assert.equal(setupResult.updates[0].status, "streaming");
    assert.equal(setupResult.updates[0].content, "");
    assert.equal(setupResult.updates[1].status, "complete");
    assert.equal(setupResult.updates[1].content, content);
    assert.equal(setupResult.updates[1].providerResponseId, "resp_1");
    assert.equal(setupResult.updates[1].inputTokens, 20);
    assert.equal(setupResult.updates[1].outputTokens, 8);
    assert.equal(
      setupResult.updates[1].citations[0].sourceId,
      "platform:navigation:proposals",
    );
    assert.equal(result.assistantMessage.status, "complete");
  });
});

test("greeting-only uncited answer completes as a safe clarification", async () => {
  await withEnabledAssistant(async () => {
    const content = "Hello! How can I help?";
    const setupResult = setup(
      [
        {
          type: "started",
          providerResponseId: "resp_greeting",
          model: "effective-model",
        },
        { type: "text_delta", delta: content },
        {
          type: "completed",
          providerResponseId: "resp_greeting",
          model: "effective-model",
          usage: { inputTokens: 8, outputTokens: 6 },
          output: {
            kind: "answer",
            content,
            citationIds: [],
          },
        },
      ],
      { userContent: "hello" },
    );
    const { events, result } = await invoke(
      setupResult.application,
      new AbortController().signal,
      undefined,
      "hello",
    );

    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(setupResult.updates.at(-1).status, "complete");
    assert.equal(setupResult.updates.at(-1).content, content);
    assert.deepEqual(setupResult.updates.at(-1).citations, []);
    assert.equal(result.assistantMessage.status, "complete");
  });
});

test("invalid provider output with no visible delta completes as grounded deterministic fallback", async () => {
  await withEnabledAssistant(async () => {
    const setupResult = setup([
      {
        type: "failed",
        providerResponseId: "resp_invalid",
        model: "effective-model",
        code: "ASSISTANT_RESPONSE_INVALID",
        message: "The provider returned invalid structured output.",
        retryable: true,
      },
    ]);
    const { events, result } = await invoke(setupResult.application);
    const terminal = setupResult.updates.at(-1);

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "message.accepted",
        "response.started",
        "response.delta",
        "response.completed",
      ],
    );
    assert.equal(setupResult.updates[0].status, "streaming");
    assert.equal(terminal.status, "complete");
    assert.match(terminal.content, /Open \[Proposals\]\(\/proposals\)/i);
    assert.ok(
      terminal.citations.some(
        (citation) => citation.sourceId === "platform:navigation:proposals",
      ),
    );
    assert.equal(terminal.safeErrorCode, undefined);
    assert.equal(result.assistantMessage.status, "complete");
  });
});

test("invalid structured output after visible deltas reconciles to grounded fallback without an unavailable state", async () => {
  await withEnabledAssistant(async () => {
    const setupResult = setup([
      {
        type: "started",
        providerResponseId: "resp_invalid_after_delta",
        model: "effective-model",
      },
      { type: "text_delta", delta: "Visible but invalid partial" },
      {
        type: "failed",
        providerResponseId: "resp_invalid_after_delta",
        model: "effective-model",
        code: "ASSISTANT_RESPONSE_INVALID",
        message: "The provider returned invalid structured output.",
        retryable: true,
      },
    ]);
    const { events, result } = await invoke(setupResult.application);
    const terminal = setupResult.updates.at(-1);

    assert.equal(events.at(-1).type, "response.completed");
    assert.ok(!events.some((event) => event.type === "response.failed"));
    assert.equal(terminal.status, "complete");
    assert.match(terminal.content, /Open \[Proposals\]\(\/proposals\)/i);
    assert.notEqual(terminal.content, "Visible but invalid partial");
    assert.equal(terminal.safeErrorCode, undefined);
    assert.equal(result.assistantMessage.status, "complete");
  });
});

test("a supplied response-attempt key is independent from the user-message key", async () => {
  await withEnabledAssistant(async () => {
    const setupResult = setup([]);
    await invoke(
      setupResult.application,
      new AbortController().signal,
      "assistant-response-attempt:retry-1",
    );
    assert.equal(
      setupResult.assistantPlaceholders[0].idempotencyKey,
      "assistant-response-attempt:retry-1",
    );
  });
});

test("partial provider failure preserves partial content and becomes interrupted", async () => {
  await withEnabledAssistant(async () => {
    const setupResult = setup([
      {
        type: "started",
        providerResponseId: "resp_partial",
        model: "effective-model",
      },
      { type: "text_delta", delta: "Partial answer" },
      {
        type: "failed",
        providerResponseId: "resp_partial",
        model: "effective-model",
        code: "ASSISTANT_PROVIDER_TEMPORARY",
        message: "Provider unavailable.",
        retryable: true,
      },
    ]);
    const { events, result } = await invoke(setupResult.application);
    const terminal = setupResult.updates.at(-1);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.content, "Partial answer");
    assert.equal(terminal.safeErrorCode, "ASSISTANT_STREAM_INTERRUPTED");
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).code, "ASSISTANT_STREAM_INTERRUPTED");
    assert.equal(events.at(-1).retryable, true);
    assert.equal(result.assistantMessage.content, "Partial answer");
  });
});

test("abort signal persists an aborted assistant message without invoking provider", async () => {
  await withEnabledAssistant(async () => {
    const setupResult = setup([]);
    const controller = new AbortController();
    controller.abort();
    const { events, result } = await invoke(
      setupResult.application,
      controller.signal,
    );
    assert.equal(setupResult.providerCalls(), 0);
    assert.equal(setupResult.updates.at(-1).status, "aborted");
    assert.equal(
      setupResult.updates.at(-1).safeErrorCode,
      "ASSISTANT_STREAM_ABORTED",
    );
    assert.equal(events.at(-1).code, "ASSISTANT_STREAM_ABORTED");
    assert.equal(events.at(-1).retryable, false);
    assert.equal(result.assistantMessage.status, "aborted");
  });
});

test("completed idempotent replay emits authoritative completion without provider regeneration", async () => {
  await withEnabledAssistant(async () => {
    const completed = message({
      id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
      ordinal: 2,
      role: "assistant",
      content: "Existing answer.",
      status: "complete",
      model: "existing-model",
    });
    const setupResult = setup([], {
      placeholderCreated: false,
      placeholder: completed,
    });
    const { events, result } = await invoke(setupResult.application);
    assert.equal(setupResult.providerCalls(), 0);
    assert.deepEqual(
      events.map((event) => event.type),
      ["message.accepted", "response.completed"],
    );
    assert.equal(result.assistantMessage.content, "Existing answer.");
  });
});

test("invalid completed output after deltas is persisted as interrupted", async () => {
  await withEnabledAssistant(async () => {
    const setupResult = setup([
      {
        type: "started",
        providerResponseId: "resp_invalid",
        model: "effective-model",
      },
      { type: "text_delta", delta: "Visible partial" },
      {
        type: "completed",
        providerResponseId: "resp_invalid",
        model: "effective-model",
        usage: { inputTokens: 20, outputTokens: 8 },
        output: {
          kind: "answer",
          content: "Different final",
          citationIds: ["platform:navigation:proposals"],
        },
      },
    ]);
    const { events } = await invoke(setupResult.application);
    assert.equal(setupResult.updates.at(-1).status, "failed");
    assert.equal(
      setupResult.updates.at(-1).safeErrorCode,
      "ASSISTANT_STREAM_INTERRUPTED",
    );
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).code, "ASSISTANT_STREAM_INTERRUPTED");
  });
});
