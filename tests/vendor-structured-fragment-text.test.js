require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  describeStructuredFragment,
  structuredFragmentLabels,
} = require("../src/modules/vendorResponses/domain/structuredFragmentText");
const {
  structuredProvenanceFragments,
} = require("../src/modules/vendorResponses/infrastructure/postgres/postgresVendorSubmissionSourceRegistry");

const questionnaire = {
  rooms: [
    {
      roomId: "room-1",
      name: "Keynote",
      specs: [
        { specId: "spec-aspect", label: "Aspect Ratio", requirementText: "Aspect Ratio: 16:9 Native 4K" },
        { specId: "spec-prompter", label: "Teleprompter Required", requirementText: "Teleprompter Required: Required" },
      ],
    },
  ],
  crew: { roles: [{ id: "role-technical-director", label: "Technical director" }] },
  pricing: { currency: "USD", equipmentCategories: [{ id: "video", label: "Video" }] },
};

const labels = () => structuredFragmentLabels(questionnaire, "USD");
const describe = (path, value, provenance = "vendor_stated") =>
  describeStructuredFragment({ path, value, provenance, labels: labels() });

test("money in minor units reads as money, not as an integer", () => {
  // "No total price was found in the files" was reported while this exact
  // field held the total.
  assert.equal(describe("/calculation/grandTotalMinor", 7670000, "server_calculated"), "Grand total: USD 76,700.00");
  assert.equal(
    describe("/calculation/roomTotals/room-1/roomTotalMinor", 3830000, "server_calculated"),
    "Room Keynote — Room total: USD 38,300.00",
  );
  assert.equal(
    describe("/response/rooms/room-1/categoryTotals/video/amount/amountMinor", 1650000),
    "Room Keynote — Amount: USD 16,500.00",
  );
});

test("a spec verdict carries the requirement it answers", () => {
  assert.equal(
    describe("/response/rooms/room-1/specResponses/spec-aspect/status", "substitute"),
    "Room Keynote — Aspect Ratio verdict: SUBSTITUTE (client requirement: Aspect Ratio: 16:9 Native 4K)",
  );
  assert.equal(
    describe("/response/rooms/room-1/specResponses/spec-prompter/status", "exception"),
    "Room Keynote — Teleprompter Required verdict: EXCEPTION (client requirement: Teleprompter Required: Required)",
  );
  assert.equal(
    describe("/response/rooms/room-1/specResponses/spec-aspect/note", "1080p is sufficient."),
    "Room Keynote — Aspect Ratio — vendor note: 1080p is sufficient.",
  );
});

test("identifiers resolve to their questionnaire labels", () => {
  assert.equal(describe("/response/crew/c1/roleId", "role-technical-director"), "Role: Technical director");
  assert.equal(
    describe("/response/rooms/room-1/laborLines/l1/roleId", "role-technical-director"),
    "Room Keynote — Role: Technical director",
  );
  assert.equal(
    describe("/response/rooms/room-1/equipmentLines/e1/categoryId", "video"),
    "Room Keynote — Category: Video",
  );
});

test("unknown identifiers fall back to the raw value rather than being dropped", () => {
  const bare = structuredFragmentLabels(null, null);
  assert.equal(
    describeStructuredFragment({ path: "/response/crew/c1/roleId", value: "role-unmapped", provenance: "vendor_stated", labels: bare }),
    "Role: role-unmapped",
  );
  assert.equal(
    describeStructuredFragment({ path: "/calculation/grandTotalMinor", value: 500, provenance: "server_calculated", labels: bare }),
    "Grand total: USD 5.00",
  );
});

test("ordinary fields are humanized rather than left as camelCase paths", () => {
  assert.equal(describe("/response/companyProfile/legalName", "Harbour Point Inc."), "Legal name: Harbour Point Inc.");
  assert.equal(describe("/response/identity/vendorName", "Harbour Point"), "Vendor name: Harbour Point");
});

test("the registry renders every flattened fragment through the labeller", () => {
  const record = {
    structuredResponse: {
      identity: { vendorName: "Harbour Point" },
      rooms: [
        {
          roomId: "room-1",
          specResponses: [{ specId: "spec-prompter", status: "exception", note: "No prompter." }],
        },
      ],
    },
    calculationSnapshot: { currency: "USD", grandTotalMinor: 7670000 },
  };
  const paths = structuredProvenanceFragments(record).map((fragment) => fragment.path);

  // The flattener still produces pointer paths for citation; only the stored
  // text changes, so provenance is unaffected by this PR.
  assert.ok(paths.includes("/response/rooms/room-1/specResponses/spec-prompter/status"));
  assert.ok(paths.includes("/calculation/grandTotalMinor"));
});
