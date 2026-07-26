const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { embedTexts, padToDimension } = require("../src/modules/knowledgeRetrieval/embeddingProvider");
const { parseRetrievalInput, KnowledgeRetrievalError } = require("../src/modules/knowledgeRetrieval/domain");

const root = path.join(__dirname, "..");

test("zero padding preserves vector prefix and reaches the target dimension", () => {
  const padded = padToDimension([0.5, 0.5], 6);
  assert.deepEqual(padded, [0.5, 0.5, 0, 0, 0, 0]);
});

test("mock embeddings are deterministic at the release dimension", async () => {
  const release = { provider: "mock", model: "deterministic-v1", dimension: 1536 };
  const [a, b] = await embedTexts(release, ["breakout room schedule", "breakout room schedule"]);
  assert.equal(a.length, 1536);
  assert.deepEqual(a, b);
});

test("openai embeddings fail closed without environment authorization", async () => {
  const saved = { a: process.env.AI_ENVIRONMENT, n: process.env.NODE_ENV };
  delete process.env.AI_ENVIRONMENT;
  process.env.NODE_ENV = "production";
  await assert.rejects(
    () => embedTexts({ provider: "openai", model: "text-embedding-3-small", dimension: 1536 }, ["x"]),
    (error) => error.code === "EMBEDDING_PROVIDER_DISABLED",
  );
  if (saved.a === undefined) delete process.env.AI_ENVIRONMENT; else process.env.AI_ENVIRONMENT = saved.a;
  if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
});

test("free-text retrieval queries are bounded and fixtures still work", () => {
  const open = parseRetrievalInput({ query: "  union labor   rules Chicago " });
  assert.equal(open.fixture, "free_text");
  assert.equal(open.query, "union labor rules Chicago");
  assert.throws(() => parseRetrievalInput({ query: "x" }), KnowledgeRetrievalError);
  assert.throws(() => parseRetrievalInput({ query: "x".repeat(301) }), KnowledgeRetrievalError);
  const fixture = parseRetrievalInput({ fixture: "no-match" });
  assert.equal(fixture.fixture, "no-match");
});

test("migration 019 relaxes registries, resizes vectors and adds guidance reports", () => {
  const up = fs.readFileSync(path.join(root, "migrations/postgres/019_real_embeddings_and_guidance.up.sql"), "utf8");
  for (const value of [
    "provider IN('mock','openai')",
    "dimension IN(16,1536)",
    "TYPE vector(1536)",
    "text-embedding-3-small",
    "'free_text'",
    "canonical_path~'^/content/' OR canonical_path~'^/knowledge/'",
    "rfpilot.guidance_reports",
    "FORCE ROW LEVEL SECURITY",
  ])
    assert.ok(up.includes(value), value);
});
