require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AssistantJsonContentExtractor,
  OpenAiAssistantProvider,
  assistantSafetyIdentifier,
} = require("../src/modules/platformAssistant/openAiAssistantProvider");

const context = {
  organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  correlationId: "correlation-provider-test",
};

const prompt = {
  schemaVersion: "platform-assistant-prompt.v2",
  platformKnowledgeVersion: "rfpilot-platform-map.v3",
  userMessage: "Where are proposals?",
  history: [],
  evidence: [
    {
      id: "platform:navigation:proposals",
      sourceType: "platform_fact",
      trust: "trusted_platform_fact",
      title: "Proposals",
      content: "The Proposals page is available at /proposals.",
      href: "/proposals",
    },
  ],
  instructions: [
    "Answer from supplied evidence.",
    "Return the required structured output.",
  ],
};

const withProviderEnvironment = async (work, overrides = {}) => {
  const values = {
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "*",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
    LIVE_AI_PILOT_ENABLED: "true",
    LIVE_AI_PROVIDER: "openai",
    LIVE_AI_MODEL: "approved-model",
    OPENAI_API_KEY: "test-key-not-a-secret",
    AI_SAFETY_IDENTIFIER_SECRET: "s".repeat(48),
    AI_ASSISTANT_PROVIDER_MAX_ATTEMPTS: "2",
    AI_ASSISTANT_STREAM_TIMEOUT_MS: "5000",
    ...overrides,
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

const outputJson = JSON.stringify({
  kind: "answer",
  citationIds: ["platform:navigation:proposals"],
  content: "Open Proposals.\nReady 😀",
});

const completedEvents = () => [
  {
    type: "response.created",
    response: { id: "resp_123", model: "effective-model" },
  },
  ...[
    outputJson.slice(0, 19),
    outputJson.slice(19, 39),
    outputJson.slice(39, 58),
    outputJson.slice(58),
  ].map((delta) => ({ type: "response.output_text.delta", delta })),
  {
    type: "response.completed",
    response: {
      id: "resp_123",
      model: "effective-model",
      output_text: outputJson,
      usage: { input_tokens: 42, output_tokens: 18 },
    },
  },
];

async function* iterable(events) {
  for (const event of events) yield event;
}

const collect = async (provider, signal = new AbortController().signal) => {
  const events = [];
  for await (const event of provider.stream(prompt, {
    context,
    assistantMessageId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    signal,
  }))
    events.push(event);
  return events;
};

test("content extractor handles split escapes and surrogate pairs without exposing JSON framing", () => {
  const extractor = new AssistantJsonContentExtractor();
  const chunks = [
    '{"kind":"answer","con',
    'tent":"Line\\',
    'nSmile \\uD83',
    'D\\uDE00","citationIds":[]}',
  ];
  assert.equal(
    chunks.map((chunk) => extractor.feed(chunk)).join(""),
    "Line\nSmile 😀",
  );
  extractor.finish();
});

test("OpenAI stream is private, ledgered before invocation, and translated to product-neutral events", async () => {
  await withProviderEnvironment(async () => {
    const order = [];
    let request;
    let requestOptions;
    const completions = [];
    const ledger = {
      async begin() {
        order.push("ledger.begin");
        return {
          id: "attempt-1",
          fingerprint: "fingerprint-1",
          attemptNumber: 1,
          context: {
            runType: "platform_assistant",
            runId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
            organizationId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e72",
          },
        };
      },
      async complete(_attempt, outcome) {
        completions.push(outcome);
      },
    };
    const provider = new OpenAiAssistantProvider({
      ledger,
      async streamFactory(input) {
        order.push("provider.call");
        request = input.request;
        requestOptions = input;
        return iterable(completedEvents());
      },
    });
    const events = await collect(provider);

    assert.deepEqual(order, ["ledger.begin", "provider.call"]);
    assert.equal(request.model, "approved-model");
    assert.equal(request.stream, true);
    assert.equal(request.store, false);
    assert.equal(request.reasoning.effort, "none");
    assert.equal(request.text.verbosity, "low");
    assert.equal(request.text.format.type, "json_schema");
    assert.equal(request.text.format.strict, true);
    assert.equal(requestOptions.idempotencyKey, "fingerprint-1");
    assert.notEqual(request.safety_identifier, context.actorUserMongoId);
    assert.notEqual(request.safety_identifier, context.organizationMongoId);
    assert.equal(request.safety_identifier.length, 43);
    assert.doesNotMatch(JSON.stringify(request), /test-key-not-a-secret/);

    assert.equal(events.filter((event) => event.type === "started").length, 1);
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
      "Open Proposals.\nReady 😀",
    );
    const completed = events.at(-1);
    assert.equal(completed.type, "completed");
    assert.equal(completed.providerResponseId, "resp_123");
    assert.equal(completed.model, "effective-model");
    assert.deepEqual(completed.usage, { inputTokens: 42, outputTokens: 18 });
    assert.deepEqual(completed.output, JSON.parse(outputJson));
    assert.equal(completions.length, 1);
    assert.equal(completions[0].state, "succeeded");
    assert.equal(completions[0].providerRequestId, "resp_123");
  });
});

test("temporary provider failure retries only before a text delta", async () => {
  await withProviderEnvironment(async () => {
    let calls = 0;
    const outcomes = [];
    const sleeps = [];
    const provider = new OpenAiAssistantProvider({
      ledger: {
        async begin() {
          const attemptNumber = outcomes.length + 1;
          return {
            id: `attempt-${attemptNumber}`,
            fingerprint: `fingerprint-${attemptNumber}`,
            attemptNumber,
            context: {
              runType: "platform_assistant",
              runId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
              organizationId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e72",
            },
          };
        },
        async complete(_attempt, outcome) {
          outcomes.push(outcome);
        },
      },
      async streamFactory() {
        calls += 1;
        if (calls === 1) {
          const error = new Error("private upstream detail");
          error.status = 503;
          throw error;
        }
        return iterable(completedEvents());
      },
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
      },
      random: () => 0,
    });
    const events = await collect(provider);

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [250]);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.state, outcome.errorCode || null]),
      [
        ["failed", "ASSISTANT_PROVIDER_TEMPORARY"],
        ["succeeded", null],
      ],
    );
    assert.equal(events.filter((event) => event.type === "started").length, 1);
    assert.equal(events.at(-1).type, "completed");
  });
});

test("invalid citation metadata retries before any product text is emitted", async () => {
  await withProviderEnvironment(async () => {
    let calls = 0;
    const outcomes = [];
    const invalid = JSON.stringify({
      kind: "answer",
      citationIds: [],
      content: "Unsupported event-planning advice.",
    });
    const provider = new OpenAiAssistantProvider({
      ledger: {
        async begin() {
          const attemptNumber = outcomes.length + 1;
          return {
            id: `attempt-${attemptNumber}`,
            fingerprint: `fingerprint-${attemptNumber}`,
            attemptNumber,
            context: {
              runType: "platform_assistant",
              runId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
              organizationId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e72",
            },
          };
        },
        async complete(_attempt, outcome) {
          outcomes.push(outcome);
        },
      },
      async streamFactory() {
        calls += 1;
        if (calls === 1) {
          return iterable([
            {
              type: "response.created",
              response: { id: "resp_invalid", model: "effective-model" },
            },
            { type: "response.output_text.delta", delta: invalid },
            {
              type: "response.completed",
              response: {
                id: "resp_invalid",
                model: "effective-model",
                output_text: invalid,
              },
            },
          ]);
        }
        return iterable(completedEvents());
      },
      async sleep() {},
      random: () => 0,
    });
    const events = await collect(provider);

    assert.equal(calls, 2);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.state, outcome.errorCode || null]),
      [
        ["failed", "ASSISTANT_RESPONSE_INVALID"],
        ["succeeded", null],
      ],
    );
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
      "Open Proposals.\nReady 😀",
    );
    assert.equal(events.at(-1).type, "completed");
  });
});

test("whitespace-only content retries without exposing a partial response", async () => {
  await withProviderEnvironment(async () => {
    let calls = 0;
    const outcomes = [];
    const whitespace = JSON.stringify({
      kind: "abstention",
      citationIds: [],
      content: " ",
    });
    const provider = new OpenAiAssistantProvider({
      ledger: {
        async begin() {
          const attemptNumber = outcomes.length + 1;
          return {
            id: `attempt-${attemptNumber}`,
            fingerprint: `fingerprint-${attemptNumber}`,
            attemptNumber,
            context: {
              runType: "platform_assistant",
              runId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
              organizationId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e72",
            },
          };
        },
        async complete(_attempt, outcome) {
          outcomes.push(outcome);
        },
      },
      async streamFactory() {
        calls += 1;
        if (calls === 1) {
          return iterable([
            {
              type: "response.created",
              response: { id: "resp_whitespace", model: "effective-model" },
            },
            { type: "response.output_text.delta", delta: whitespace },
            {
              type: "response.completed",
              response: {
                id: "resp_whitespace",
                model: "effective-model",
                output_text: whitespace,
              },
            },
          ]);
        }
        return iterable(completedEvents());
      },
      async sleep() {},
      random: () => 0,
    });
    const events = await collect(provider);

    assert.equal(calls, 2);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.state, outcome.errorCode || null]),
      [
        ["failed", "ASSISTANT_RESPONSE_INVALID"],
        ["succeeded", null],
      ],
    );
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
      "Open Proposals.\nReady 😀",
    );
    assert.equal(events.at(-1).type, "completed");
  });
});

test("failure after a text delta is interrupted and never retried", async () => {
  await withProviderEnvironment(async () => {
    let calls = 0;
    let sleeps = 0;
    const outcomes = [];
    const provider = new OpenAiAssistantProvider({
      ledger: {
        async begin() {
          return {
            id: "attempt-1",
            fingerprint: "fingerprint-1",
            attemptNumber: 1,
            context: {
              runType: "platform_assistant",
              runId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
              organizationId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e72",
            },
          };
        },
        async complete(_attempt, outcome) {
          outcomes.push(outcome);
        },
      },
      async streamFactory() {
        calls += 1;
        return iterable([
          {
            type: "response.created",
            response: { id: "resp_partial", model: "effective-model" },
          },
          {
            type: "response.output_text.delta",
            delta:
              '{"kind":"answer","citationIds":["platform:navigation:proposals"],"content":"Partial text',
          },
          {
            type: "error",
            code: "server_error",
            message: "private provider error",
          },
        ]);
      },
      async sleep() {
        sleeps += 1;
      },
    });
    const events = await collect(provider);

    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
      "Partial text",
    );
    assert.deepEqual(events.at(-1), {
      type: "failed",
      providerResponseId: "resp_partial",
      model: "effective-model",
      code: "ASSISTANT_STREAM_INTERRUPTED",
      message: "The assistant response was interrupted.",
      retryable: true,
    });
    assert.equal(outcomes[0].errorCode, "ASSISTANT_STREAM_INTERRUPTED");
  });
});

test("final validation failure after a text delta remains identifiable for grounded application fallback", async () => {
  await withProviderEnvironment(async () => {
    const outcomes = [];
    const invalid = JSON.stringify({
      kind: "answer",
      citationIds: ["platform:navigation:proposals"],
      content: "Open [outside](https://example.com).",
    });
    const provider = new OpenAiAssistantProvider({
      ledger: {
        async begin() {
          return {
            id: "attempt-invalid-final",
            fingerprint: "fingerprint-invalid-final",
            attemptNumber: 1,
            context: {
              runType: "platform_assistant",
              runId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
              organizationId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e72",
            },
          };
        },
        async complete(_attempt, outcome) {
          outcomes.push(outcome);
        },
      },
      async streamFactory() {
        return iterable([
          {
            type: "response.created",
            response: { id: "resp_invalid_final", model: "effective-model" },
          },
          { type: "response.output_text.delta", delta: invalid },
          {
            type: "response.completed",
            response: {
              id: "resp_invalid_final",
              model: "effective-model",
              output_text: invalid,
            },
          },
        ]);
      },
    });
    const events = await collect(provider);

    assert.equal(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
      "Open [outside](https://example.com).",
    );
    assert.equal(events.at(-1).type, "failed");
    assert.equal(events.at(-1).code, "ASSISTANT_RESPONSE_INVALID");
    assert.equal(outcomes[0].errorCode, "ASSISTANT_RESPONSE_INVALID");
  });
});

test("an already-aborted request never opens a ledger attempt or provider stream", async () => {
  await withProviderEnvironment(async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const provider = new OpenAiAssistantProvider({
      ledger: {
        async begin() {
          calls += 1;
          throw new Error("must not run");
        },
        async complete() {},
      },
      async streamFactory() {
        calls += 1;
        return iterable([]);
      },
    });
    const events = await collect(provider, controller.signal);
    assert.equal(calls, 0);
    assert.equal(events.at(-1).code, "ASSISTANT_STREAM_ABORTED");
    assert.equal(events.at(-1).aborted, true);
  });
});

test("safety identifiers are stable, scoped, and reveal no source identifier", () => {
  const secret = "x".repeat(48);
  const first = assistantSafetyIdentifier(context, secret);
  assert.equal(first, assistantSafetyIdentifier(context, secret));
  assert.notEqual(
    first,
    assistantSafetyIdentifier(
      { ...context, actorUserMongoId: "cccccccccccccccccccccccc" },
      secret,
    ),
  );
  assert.doesNotMatch(first, /a{8}|b{8}/);
});
