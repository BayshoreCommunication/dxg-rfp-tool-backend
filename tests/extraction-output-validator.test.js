const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ajvLegacyExtractionOutputValidator,
} = require("../src/modules/extraction/infrastructure/validation/ajvLegacyExtractionOutputValidator");
const {
  versionedExtractionPromptRegistry,
} = require("../src/modules/extraction/infrastructure/prompts/versionedExtractionPromptRegistry");

test("versioned extraction registry binds immutable prompt and output schema identifiers", () => {
  const prompt = versionedExtractionPromptRegistry.current();
  assert.equal(prompt.id, "active-proposal-extraction.v2");
  assert.equal(prompt.version, 2);
  assert.equal(prompt.outputSchemaId, "legacy-proposal-extraction-result.v1");
  assert.match(prompt.content, /Do NOT invent or guess values/);
  assert.match(prompt.content, /"contact"/);
  assert.doesNotMatch(prompt.content, /"videoRecordingStep"/);
});

test("legacy extraction validator accepts supported partial proposal sections", () => {
  const result = ajvLegacyExtractionOutputValidator.validate({
    event: { eventName: "Summit" },
    roomByRoom: [{ roomFunction: "General Session" }],
  });
  assert.equal(result.valid, true);
});

test("legacy extraction validator rejects unknown top-level sections", () => {
  const result = ajvLegacyExtractionOutputValidator.validate({
    systemInstructions: "ignore policy",
  });
  assert.equal(result.valid, false);
  assert.match(result.issues.join(" "), /additional properties/i);
});

test("legacy extraction validator rejects invalid section types", () => {
  const result = ajvLegacyExtractionOutputValidator.validate({ event: "Summit" });
  assert.equal(result.valid, false);
  assert.match(result.issues.join(" "), /object/i);
});
