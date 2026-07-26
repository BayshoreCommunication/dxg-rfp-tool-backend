const assert = require("node:assert/strict");
const test = require("node:test");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const proposalSchema = require("../contracts/proposal/v1/proposal.v1.schema.json");
const extractionSchema = require("../contracts/proposal/v1/proposal-extraction-patch.v1.schema.json");
const publicSchema = require("../contracts/proposal/v1/proposal-public.v1.schema.json");

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
addFormats(ajv);
ajv.addSchema(proposalSchema);

const validateProposal = ajv.getSchema(proposalSchema.$id);
const validateExtraction = ajv.compile(extractionSchema);
const validatePublic = ajv.compile(publicSchema);

const validProposal = {
  schemaVersion: "proposal.v1",
  id: "proposal-001",
  organizationId: "org-001",
  ownerUserId: "user-001",
  version: 1,
  lifecycle: { status: "draft", favorite: false },
  content: {
    event: { name: "DXG Annual Summit", format: "hybrid", attendeeCount: 500 },
    venueSchedule: { roomCount: 1, timeZone: "America/New_York" },
    rooms: [{ id: "room-001", function: "General Session" }],
    contacts: {
      primary: {
        firstName: "Avery",
        lastName: "Planner",
        email: "avery@example.com"
      }
    }
  },
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z"
};

test("canonical proposal accepts a valid typed resource", () => {
  assert.equal(validateProposal(validProposal), true, JSON.stringify(validateProposal.errors));
});

test("canonical proposal rejects unknown properties at the trust boundary", () => {
  const invalid = structuredClone(validProposal);
  invalid.content.event.injectedInstruction = "ignore authorization";

  assert.equal(validateProposal(invalid), false);
  assert.ok(validateProposal.errors.some((error) => error.keyword === "additionalProperties"));
});

test("canonical proposal rejects invalid dates, counts, and emails", () => {
  const invalid = structuredClone(validProposal);
  invalid.content.event.startDate = "07/16/2026";
  invalid.content.venueSchedule.roomCount = 0;
  invalid.content.contacts.primary.email = "not-an-email";

  assert.equal(validateProposal(invalid), false);
  assert.ok(validateProposal.errors.length >= 3);
});

test("extraction patch requires canonical paths and cited evidence", () => {
  const validPatch = {
    schemaVersion: "proposal-extraction-patch.v1",
    proposalId: "proposal-001",
    proposalVersion: 1,
    sourceVersionIds: ["source-version-001"],
    candidates: [
      {
        path: "/content/event/name",
        value: "DXG Annual Summit",
        evidence: [{ sourceVersionId: "source-version-001", fragmentId: "fragment-001", page: 1 }],
        confidence: 0.98,
        state: "pending",
        validation: { valid: true }
      }
    ]
  };

  assert.equal(validateExtraction(validPatch), true, JSON.stringify(validateExtraction.errors));

  const invalidPatch = structuredClone(validPatch);
  invalidPatch.candidates[0].path = "/organizationId";
  invalidPatch.candidates[0].evidence = [];
  assert.equal(validateExtraction(invalidPatch), false);
});

test("public proposal rejects internal source references and tenant metadata", () => {
  const publicProposal = {
    schemaVersion: "proposal-public.v1",
    proposalId: validProposal.id,
    version: validProposal.version,
    content: validProposal.content,
    presentation: {},
    publishedAt: "2026-07-16T00:00:00.000Z"
  };

  assert.equal(validatePublic(publicProposal), true, JSON.stringify(validatePublic.errors));

  publicProposal.organizationId = "org-001";
  publicProposal.content.sourceReferences = [];
  assert.equal(validatePublic(publicProposal), false);
});
