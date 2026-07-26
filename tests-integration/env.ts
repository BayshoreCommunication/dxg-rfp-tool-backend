// Integration test environment. This module MUST be imported before any
// application module (config/*, src/modules/*, modal/*) so every lazy env read
// inside the app sees the isolated Docker services instead of anything from a
// developer shell. Nothing in tests-integration imports config/env, so the
// repository .env/.env.local files are never loaded into these processes.

if (process.env.INTEGRATION !== "1") {
  console.error(
    [
      "tests-integration/* only run against the dedicated Docker services (INTEGRATION=1 not set).",
      "Run the suite via:",
      "  npm run integration:up      # start postgres/redis/mongo (requires Docker)",
      "  npm run test:integration    # sets INTEGRATION=1 and runs this suite",
      "  npm run integration:down    # tear the stack down and delete its volumes",
    ].join("\n"),
  );
  process.exit(1);
}

export const TEST_POSTGRES_URL = "postgres://postgres:rfpilot_test@localhost:55432/rfpilot_test";
export const TEST_APP_ROLE_URL = "postgres://rfpilot_app:rfpilot_test@localhost:55432/rfpilot_test";
export const TEST_REDIS_URL = "redis://localhost:56379";
export const TEST_MONGODB_URL = "mongodb://localhost:57017/rfpilot_test";
export const TEST_MONGODB_DB_NAME = "rfpilot_test";

const overrides: Record<string, string> = {
  NODE_ENV: "test",
  AI_ENVIRONMENT: "test",

  POSTGRES_FOUNDATION_ENABLED: "true",
  POSTGRES_URL: TEST_POSTGRES_URL,
  POSTGRES_MIGRATION_URL: TEST_POSTGRES_URL,
  POSTGRES_SSL: "false",

  REDIS_URL: TEST_REDIS_URL,
  MONGODB_URL: TEST_MONGODB_URL,
  MONGODB_DB_NAME: TEST_MONGODB_DB_NAME,

  DURABLE_JOBS_ENABLED: "true",
  JOB_MAX_ATTEMPTS: "5",
  JOB_LEASE_SECONDS: "30",

  PROPOSAL_CONTEXT_ENABLED: "true",
  PROPOSAL_CONTEXT_PROVIDER: "mock",
  PROPOSAL_CONTEXT_MODEL: "deterministic-v1",
  PROPOSAL_CONTEXT_RETENTION_DAYS: "30",
  CANDIDATE_APPLICATION_ENABLED: "true",
  PROPOSAL_DRAFT_ENABLED: "true",
  PROPOSAL_DRAFT_PROVIDER: "mock",
  CONVERSATIONS_ENABLED: "true",
  AI_ASSISTANT_ENABLED: "true",
  AI_ASSISTANT_KILL_SWITCH: "false",
  PRICING_CORPUS_ENABLED: "true",

  // Never call live providers from this suite.
  LIVE_AI_PILOT_ENABLED: "false",
  LIVE_AI_KILL_SWITCH: "true",
};

for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
