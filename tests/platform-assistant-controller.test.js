require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  createPlatformAssistantController,
} = require("../controller/platformAssistantController");
const {
  PlatformAssistantError,
} = require("../src/modules/platformAssistant/domain");

const root = path.resolve(__dirname, "..");
const threadId = "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f";

const assistantMessage = {
  id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
  threadId,
  ordinal: 2,
  role: "assistant",
  content: "Open Proposals.",
  status: "complete",
  providerResponseId: "resp_safe",
  model: "effective-model",
  inputTokens: 20,
  outputTokens: 6,
  safeErrorCode: null,
  citations: [],
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:01.000Z",
  completedAt: "2026-07-27T00:00:01.000Z",
};

const userMessage = {
  ...assistantMessage,
  id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e70",
  ordinal: 1,
  role: "user",
  content: "Where are proposals?",
  providerResponseId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
};

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map();
  writes = [];
  jsonBody = null;
  destroyed = false;
  writableEnded = false;
  headersSent = false;

  status(value) {
    this.statusCode = value;
    return this;
  }

  set(values) {
    for (const [key, value] of Object.entries(values)) {
      this.headers.set(key.toLowerCase(), String(value));
    }
    return this;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value));
    return this;
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  type(value) {
    this.setHeader("Content-Type", value);
    return this;
  }

  json(value) {
    this.headersSent = true;
    this.writableEnded = true;
    this.jsonBody = value;
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(value) {
    this.headersSent = true;
    this.writes.push(String(value));
    return true;
  }

  end() {
    this.writableEnded = true;
    return this;
  }
}

const request = (overrides = {}) => ({
  headers: {
    "content-type": "application/json",
    "idempotency-key": "controller-test-key",
    "x-correlation-id": "correlation-controller",
  },
  user: {
    userId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    organizationId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    roles: ["planner"],
  },
  params: { threadId },
  query: {},
  body: { content: "Where are proposals?" },
  correlationId: "correlation-controller",
  ...overrides,
});

const application = (overrides = {}) => ({
  async createThread() {
    return {
      created: true,
      thread: { id: threadId, title: "Platform help" },
    };
  },
  async listThreads() {
    return [{ id: threadId, title: "Platform help" }];
  },
  async getThread() {
    return {
      thread: { id: threadId, title: "Platform help" },
      messages: [],
    };
  },
  async archiveThread() {
    return { id: threadId, title: "Platform help", status: "archived" };
  },
  ...overrides,
});

const successfulStreamingApplication = {
  async streamGuidance(context, input) {
    await input.emit({
      type: "message.accepted",
      version: 1,
      userMessage,
      assistantMessageId: assistantMessage.id,
      correlationId: context.correlationId,
    });
    await input.emit({
      type: "response.started",
      version: 1,
      assistantMessageId: assistantMessage.id,
    });
    await input.emit({
      type: "response.delta",
      version: 1,
      assistantMessageId: assistantMessage.id,
      delta: "Open Proposals.",
    });
    await input.emit({
      type: "response.completed",
      version: 1,
      message: assistantMessage,
      correlationId: context.correlationId,
    });
  },
};

test("thread controllers expose typed JSON envelopes and idempotent status", async () => {
  let captured;
  const controller = createPlatformAssistantController({
    application: application({
      async createThread(context, body, key) {
        captured = { context, body, key };
        return {
          created: false,
          thread: { id: threadId, title: "Existing" },
        };
      },
    }),
    streamingApplication: successfulStreamingApplication,
    limiter: { async acquire() { return { async release() {} }; } },
  });
  const res = new MockResponse();
  await controller.createThread(
    request({ body: { title: "Existing" } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.data.created, false);
  assert.equal(captured.key, "controller-test-key");
  assert.equal(captured.context.actorUserMongoId, "bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual(captured.body, { title: "Existing" });
});

test("message controller emits only versioned product SSE with safe streaming headers", async () => {
  let released = 0;
  const controller = createPlatformAssistantController({
    application: application(),
    streamingApplication: successfulStreamingApplication,
    limiter: {
      async acquire() {
        return { async release() { released += 1; } };
      },
    },
    heartbeatMs: () => 60_000,
  });
  const res = new MockResponse();
  await controller.streamMessage(request(), res);
  const output = res.writes.join("");

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.getHeader("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(res.getHeader("cache-control"), "no-cache, no-transform");
  assert.equal(res.getHeader("x-accel-buffering"), "no");
  assert.match(output, /event: message\.accepted/);
  assert.match(output, /event: response\.started/);
  assert.match(output, /event: response\.delta/);
  assert.match(output, /event: response\.completed/);
  assert.doesNotMatch(
    output,
    /response\.output_text\.delta|response\.created|api[_-]?key/i,
  );
  assert.equal(released, 1);
  assert.equal(res.writableEnded, true);
});

test("message controller forwards a validated response-attempt idempotency key", async () => {
  let capturedResponseKey;
  const controller = createPlatformAssistantController({
    application: application(),
    streamingApplication: {
      async streamGuidance(context, input) {
        capturedResponseKey = input.responseIdempotencyKey;
        await input.emit({
          type: "message.accepted",
          version: 1,
          userMessage,
          assistantMessageId: assistantMessage.id,
          correlationId: context.correlationId,
        });
        await input.emit({
          type: "response.completed",
          version: 1,
          message: assistantMessage,
          correlationId: context.correlationId,
        });
      },
    },
    limiter: { async acquire() { return { async release() {} }; } },
  });
  const res = new MockResponse();
  await controller.streamMessage(
    request({
      headers: {
        "content-type": "application/json",
        "idempotency-key": "controller-test-key",
        "assistant-response-idempotency-key":
          "assistant-response-attempt:controller-test",
      },
    }),
    res,
  );
  assert.equal(
    capturedResponseKey,
    "assistant-response-attempt:controller-test",
  );
});

test("heartbeat comments keep a quiet accepted stream alive", async () => {
  const controller = createPlatformAssistantController({
    application: application(),
    streamingApplication: {
      async streamGuidance(context, input) {
        await input.emit({
          type: "message.accepted",
          version: 1,
          userMessage,
          assistantMessageId: assistantMessage.id,
          correlationId: context.correlationId,
        });
        await new Promise((resolve) => setTimeout(resolve, 18));
        await input.emit({
          type: "response.completed",
          version: 1,
          message: assistantMessage,
          correlationId: context.correlationId,
        });
      },
    },
    limiter: { async acquire() { return { async release() {} }; } },
    heartbeatMs: () => 5,
  });
  const res = new MockResponse();
  await controller.streamMessage(request(), res);
  assert.match(res.writes.join(""), /: ping\n\n/);
});

test("rate-limit failure remains problem JSON and includes Retry-After", async () => {
  let providerCalled = false;
  const controller = createPlatformAssistantController({
    application: application(),
    streamingApplication: {
      async streamGuidance() {
        providerCalled = true;
      },
    },
    limiter: {
      async acquire() {
        throw new PlatformAssistantError(
          "ASSISTANT_RATE_LIMITED",
          "Too many assistant requests. Please try again later.",
          429,
          true,
          37,
        );
      },
    },
  });
  const res = new MockResponse();
  await controller.streamMessage(request(), res);
  assert.equal(providerCalled, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.getHeader("retry-after"), "37");
  assert.equal(res.getHeader("content-type"), "application/problem+json");
  assert.equal(res.jsonBody.code, "ASSISTANT_RATE_LIMITED");
  assert.equal(res.jsonBody.retryAfterSeconds, 37);
  assert.equal(res.writes.length, 0);
});

test("invalid message is rejected before rate counting or SSE headers", async () => {
  let counted = false;
  const controller = createPlatformAssistantController({
    application: application(),
    streamingApplication: successfulStreamingApplication,
    limiter: {
      async acquire() {
        counted = true;
        return { async release() {} };
      },
    },
  });
  const res = new MockResponse();
  await controller.streamMessage(request({ body: { content: " " } }), res);
  assert.equal(counted, false);
  assert.equal(res.statusCode, 422);
  assert.equal(res.jsonBody.code, "INVALID_ASSISTANT_MESSAGE");
  assert.equal(res.writes.length, 0);
});

test("client disconnect aborts provider work and always releases its lease", async () => {
  let observedAbort = false;
  let released = 0;
  const res = new MockResponse();
  const controller = createPlatformAssistantController({
    application: application(),
    streamingApplication: {
      async streamGuidance(context, input) {
        await input.emit({
          type: "message.accepted",
          version: 1,
          userMessage,
          assistantMessageId: assistantMessage.id,
          correlationId: context.correlationId,
        });
        res.destroyed = true;
        res.emit("close");
        observedAbort = input.signal.aborted;
      },
    },
    limiter: {
      async acquire() {
        return { async release() { released += 1; } };
      },
    },
  });
  await controller.streamMessage(request(), res);
  assert.equal(observedAbort, true);
  assert.equal(released, 1);
});

test("route and server wire authentication, assistant permission, and API mount", () => {
  const route = fs.readFileSync(
    path.join(root, "routes/platformAssistantRoute.ts"),
    "utf8",
  );
  const server = fs.readFileSync(path.join(root, "server.ts"), "utf8");
  for (const pathFragment of [
    '"/assistant/threads"',
    '"/assistant/threads/:threadId"',
    '"/assistant/threads/:threadId/messages"',
  ])
    assert.ok(route.includes(pathFragment), pathFragment);
  assert.ok(route.includes("authenticate"));
  assert.ok(route.includes('authorizeAction("assistant:use")'));
  assert.ok(
    route.indexOf("authenticate") < route.indexOf('authorizeAction("assistant:use")'),
  );
  assert.ok(server.includes('app.use("/api/v1", platformAssistantRoutes)'));
});
