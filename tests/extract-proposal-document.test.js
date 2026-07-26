const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createExtractProposalDocument,
} = require("../src/modules/extraction/application/extractProposalDocument");

test("empty PDF returns the compatibility-specific extraction message", async () => {
  let modelCalls = 0;
  const extract = createExtractProposalDocument({
    textExtractor: { extract: async () => "   " },
    model: {
      extract: async () => {
        modelCalls += 1;
        return {};
      },
    },
    prompts: { current: () => ({
      id: "legacy-proposal-extraction.v1", version: 1, content: "versioned prompt",
      outputSchemaId: "legacy-proposal-extraction-result.v1",
    }) },
    outputValidator: { validate: (data) => ({ valid: true, data }) },
  });

  const result = await extract({
    buffer: Buffer.from("pdf"),
    mimetype: "application/pdf",
  });

  assert.deepEqual(result, {
    kind: "empty_document",
    message:
      "PDF appears to have no extractable text. Try a text-based PDF or DOCX.",
  });
  assert.equal(modelCalls, 0);
});

test("document extraction trims and bounds text before model invocation", async () => {
  let modelInput;
  const extract = createExtractProposalDocument({
    textExtractor: { extract: async () => `  ${"x".repeat(50_000)}  ` },
    model: {
      extract: async (input) => {
        modelInput = input;
        return { event: { eventName: "DXG Summit" } };
      },
    },
    prompts: { current: () => ({
      id: "legacy-proposal-extraction.v1", version: 1, content: "versioned prompt",
      outputSchemaId: "legacy-proposal-extraction-result.v1",
    }) },
    outputValidator: { validate: (data) => ({ valid: true, data }) },
  });

  const result = await extract({
    buffer: Buffer.from("source"),
    mimetype: "text/plain",
  });

  assert.equal(modelInput.prompt, "versioned prompt");
  assert.equal(modelInput.promptVersion, "legacy-proposal-extraction.v1");
  assert.equal(modelInput.documentText.length, 40_000);
  assert.equal(result.kind, "extracted");
  assert.equal(result.data.event.eventName, "DXG Summit");
});

test("parser and model remain replaceable application ports", async () => {
  const calls = [];
  const extract = createExtractProposalDocument({
    textExtractor: {
      extract: async (input) => {
        calls.push({ stage: "parse", mimetype: input.mimetype });
        return "Event: Annual Meeting";
      },
    },
    model: {
      extract: async (input) => {
        calls.push({ stage: "model", text: input.documentText });
        return { event: { eventName: "Annual Meeting" } };
      },
    },
    prompts: { current: () => ({
      id: "legacy-proposal-extraction.v1", version: 1, content: "versioned prompt",
      outputSchemaId: "legacy-proposal-extraction-result.v1",
    }) },
    outputValidator: { validate: (data) => ({ valid: true, data }) },
  });

  await extract({
    buffer: Buffer.from("bytes"),
    mimetype: "text/csv",
  });

  assert.deepEqual(calls, [
    { stage: "parse", mimetype: "text/csv" },
    { stage: "model", text: "Event: Annual Meeting" },
  ]);
});

test("invalid model output is rejected with prompt and schema evidence", async () => {
  const extract = createExtractProposalDocument({
    textExtractor: { extract: async () => "Event: Summit" },
    model: { extract: async () => ({ unsupportedTopLevel: true }) },
    prompts: { current: () => ({
      id: "legacy-proposal-extraction.v1", version: 1, content: "versioned prompt",
      outputSchemaId: "legacy-proposal-extraction-result.v1",
    }) },
    outputValidator: {
      validate: () => ({ valid: false, issues: ["/ must NOT have additional properties"] }),
    },
  });

  assert.deepEqual(await extract({
    buffer: Buffer.from("source"),
    mimetype: "text/plain",
  }), {
    kind: "invalid_output",
    promptVersion: "legacy-proposal-extraction.v1",
    schemaId: "legacy-proposal-extraction-result.v1",
    issues: ["/ must NOT have additional properties"],
  });
});
