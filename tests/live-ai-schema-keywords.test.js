const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// OpenAI strict structured output accepts only a subset of JSON Schema. A
// rejected keyword fails the whole request with a 400, and every live-AI call
// site catches provider errors and falls back — so an unsupported keyword does
// not surface as an error, it silently disables the feature. `uniqueItems` in
// the conversation reply schema disabled live chat replies entirely.
const UNSUPPORTED_KEYWORDS = [
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "not",
  "oneOf",
];

test("live AI structured-output schemas avoid keywords strict mode rejects", () => {
  const source = ["operations.ts", "extractionPipeline.ts"]
    .map((file) => fs.readFileSync(path.resolve(__dirname, "..", "src/modules/liveAi", file), "utf8"))
    .join("\n");
  // Only inspect the schema literals, which are the objects handed to the
  // provider as `schema:`; ordinary code may legitimately use these words.
  const schemaLiterals = [...source.matchAll(/const \w*[Ss]chema\s*=\s*(\{[\s\S]*?\});\n/g)].map((m) => m[1]);
  assert.ok(schemaLiterals.length > 0, "no schema literals found to check");

  for (const literal of schemaLiterals) {
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      assert.doesNotMatch(
        literal,
        new RegExp(`["']?\\b${keyword}\\b["']?\\s*:`),
        `structured-output schema uses "${keyword}", which strict mode rejects with a 400`,
      );
    }
  }
});
