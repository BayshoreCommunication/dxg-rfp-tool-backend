require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPlatformAssistantApplication } = require("../src/modules/platformAssistant/application");

const root = path.resolve(__dirname, "..");

const withEnabledAssistant = async (work, overrides = {}) => {
  const keys = [
    "NODE_ENV",
    "AI_ENVIRONMENT",
    "AI_ASSISTANT_ENABLED",
    "AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS",
    "AI_ASSISTANT_KILL_SWITCH",
    "LIVE_AI_KILL_SWITCH",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "*",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
    ...overrides,
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

test("migration creates tenant-isolated assistant storage and widens the attempt ledger", () => {
  const up = fs.readFileSync(
    path.join(root, "migrations/postgres/026_platform_assistant.up.sql"),
    "utf8",
  );
  const down = fs.readFileSync(
    path.join(root, "migrations/postgres/026_platform_assistant.down.sql"),
    "utf8",
  );
  for (const required of [
    "rfpilot.assistant_threads",
    "rfpilot.assistant_messages",
    "FORCE ROW LEVEL SECURITY",
    "tenant_assistant_threads",
    "tenant_assistant_messages",
    "assistant_threads_owner_idempotency_idx",
    "assistant_messages_idempotency_idx",
    "FOREIGN KEY (organization_id, thread_id)",
    "jsonb_typeof(citations) = 'array'",
    "'platform_assistant'",
  ]) {
    assert.ok(up.includes(required), required);
  }
  assert.ok(down.includes("DROP TABLE IF EXISTS rfpilot.assistant_messages"));
  assert.ok(down.includes("DROP TABLE IF EXISTS rfpilot.assistant_threads"));
});

test("application rejects an organization outside the production cohort before persistence", async () => {
  let repositoryCalled = false;
  const application = createPlatformAssistantApplication({
    async createThread() {
      repositoryCalled = true;
      throw new Error("must not be called");
    },
    async listThreads() {
      repositoryCalled = true;
      return [];
    },
    async getThread() {
      repositoryCalled = true;
      throw new Error("must not be called");
    },
    async archiveThread() {
      repositoryCalled = true;
      throw new Error("must not be called");
    },
    async appendUserMessage() {
      repositoryCalled = true;
      throw new Error("must not be called");
    },
  });

  await withEnabledAssistant(async () => {
    assert.throws(
      () =>
        application.listThreads({
          organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
          actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
          correlationId: "correlation",
        }),
      (error) =>
        error.code === "AI_ASSISTANT_ORGANIZATION_NOT_ENABLED" &&
        error.status === 403,
    );
  }, {
    AI_ENVIRONMENT: "production",
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "cccccccccccccccccccccccc",
  });

  assert.equal(repositoryCalled, false);
});

test("application boundary validates values before invoking the repository", async () => {
  const calls = [];
  const repository = {
    createThread: async (input) => {
      calls.push(["createThread", input]);
      return { created: true, thread: { id: "thread" } };
    },
    listThreads: async (input) => {
      calls.push(["listThreads", input]);
      return [];
    },
    getThread: async (input) => {
      calls.push(["getThread", input]);
      return { thread: { id: input.threadId }, messages: [] };
    },
    archiveThread: async (input) => {
      calls.push(["archiveThread", input]);
      return { id: input.threadId };
    },
    appendUserMessage: async (input) => {
      calls.push(["appendUserMessage", input]);
      return { created: true, message: { id: "message" } };
    },
  };
  const application = createPlatformAssistantApplication(repository);
  const context = {
    organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    correlationId: "correlation",
  };
  const threadId = "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f";

  await withEnabledAssistant(async () => {
    await application.createThread(context, { title: "  Platform   help " }, " create-1 ");
    await application.appendUserMessage(context, {
      threadId,
      body: { content: "  Explain proposals  " },
      idempotencyKey: " message-1 ",
    });
  });

  assert.equal(calls[0][0], "createThread");
  assert.equal(calls[0][1].title, "Platform help");
  assert.equal(calls[0][1].idempotencyKey, "create-1");
  assert.equal(calls[1][0], "appendUserMessage");
  assert.equal(calls[1][1].threadId, threadId);
  assert.equal(calls[1][1].content, "Explain proposals");
  assert.equal(calls[1][1].idempotencyKey, "message-1");
});

test("provider kill switch allows history reads but rejects message submission", async () => {
  let listed = false;
  let appended = false;
  const application = createPlatformAssistantApplication({
    createThread: async () => {
      throw new Error("not used");
    },
    listThreads: async () => {
      listed = true;
      return [];
    },
    getThread: async () => {
      throw new Error("not used");
    },
    archiveThread: async () => {
      throw new Error("not used");
    },
    appendUserMessage: async () => {
      appended = true;
      throw new Error("must not be called");
    },
  });

  await withEnabledAssistant(async () => {
    process.env.AI_ASSISTANT_KILL_SWITCH = "true";
    await application.listThreads({
      organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      correlationId: "correlation",
    });
    assert.throws(
      () => application.appendUserMessage(
        {
          organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
          actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
          correlationId: "correlation",
        },
        {
          threadId: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f",
          body: { content: "Should be rejected" },
          idempotencyKey: "message-killed",
        },
      ),
      (error) => error.code === "AI_ASSISTANT_KILLED",
    );
  });

  assert.equal(listed, true);
  assert.equal(appended, false);
});

test("repository source combines tenant setup with explicit owner predicates and audits", () => {
  const source = fs.readFileSync(
    path.join(root, "src/modules/platformAssistant/postgresAssistantRepository.ts"),
    "utf8",
  );
  for (const required of [
    "set_config('app.organization_id'",
    "owner_external_user_id=$1",
    "owner_external_user_id=$2",
    "assistant.thread.create",
    "assistant.thread.archive",
    "assistant.message.create",
    "ASSISTANT_IDEMPOTENCY_CONFLICT",
    "ON CONFLICT (",
  ]) {
    assert.ok(source.includes(required), required);
  }
});
