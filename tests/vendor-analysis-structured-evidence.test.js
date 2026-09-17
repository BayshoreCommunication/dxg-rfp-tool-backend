require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildStructuredVendorEvidence,
} = require("../src/modules/vendorAnalysis/structuredEvidence");

const questionnaire = () => ({
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
  pricing: { equipmentCategories: [{ id: "video", label: "Video" }] },
});

const response = () => ({
  identity: { vendorName: "Harbour Point", submittedBy: "Sam" },
  companyProfile: { legalName: "Harbour Point Inc.", headquarters: "Milwaukee, WI", yearsInBusiness: 8, clientMix: [] },
  platformIntegrationPlan: "RTMP push per room.",
  rooms: [
    {
      roomId: "room-1",
      specResponses: [
        { specId: "spec-aspect", status: "substitute", note: "1080p rather than native 4K." },
        { specId: "spec-prompter", status: "exception", note: "No teleprompter within budget." },
      ],
      equipmentLines: [{ equipmentLineId: "e1", categoryId: "video", description: "HD switcher", quantity: 2 }],
      categoryTotals: [{ categoryId: "video", amount: { amountMinor: 1650000, currency: "USD" } }],
      laborLines: [{ laborLineId: "l1", roleId: "role-technical-director", days: 2, regularHours: 10, overtimeHours: 0, travel: true, notes: "Show calling" }],
      laborSubtotal: { amountMinor: 780000, currency: "USD" },
      hybrid: { feedHandoff: "3G-SDI at FOH", redundancy: "Dual encoders", virtualAudienceExperience: "Switched program feed" },
    },
  ],
  crew: [{ crewMemberId: "c1", name: "Alex", roleId: "role-technical-director", bio: "14 years." }],
  references: [
    { referenceId: "r1", clientName: "Cedar Trust", eventName: "Awards Night", attendance: 400, startDate: "2025-11-08", endDate: "2025-11-08", comparable: true, servicesProvided: "Speech audio", visuals: [] },
  ],
  pricing: { travelSubtotal: { amountMinor: 0, currency: "USD" }, fees: [], discount: { amountMinor: 0, currency: "USD" }, assumptionsExclusions: ["Excludes a teleprompter."] },
  alternates: [],
  valueAdds: "",
});

const calculation = () => ({
  currency: "USD",
  grandTotalMinor: 7670000,
  equipmentSubtotalMinor: 5620000,
  laborSubtotalMinor: 1420000,
  travelSubtotalMinor: 260000,
  feeSubtotalMinor: 190000,
  taxSubtotalMinor: 180000,
  discountMinor: 0,
  roomTotals: [{ roomId: "room-1", equipmentSubtotalMinor: 3050000, laborSubtotalMinor: 780000, roomTotalMinor: 3830000 }],
});

const textFor = (fragments, origin) => fragments.find((f) => f.origin === origin)?.text ?? "";

test("pricing is rendered from the frozen calculation, not from uploaded files", () => {
  const fragments = buildStructuredVendorEvidence({
    response: response(),
    questionnaire: questionnaire(),
    calculation: calculation(),
  });
  const pricing = textFor(fragments, "structured:pricing");

  // The commercial criterion scored every vendor zero because no total price
  // was ever found; the total has to be legible as text to be citable.
  assert.match(pricing, /Grand total: USD 76,700\.00/);
  assert.match(pricing, /Equipment subtotal: USD 56,200\.00/);
  assert.match(pricing, /Travel subtotal: USD 2,600\.00/);
  assert.match(pricing, /Room Keynote total: USD 38,300\.00/);
  assert.match(pricing, /Excludes a teleprompter\./);
});

test("spec verdicts carry the client requirement and the vendor's own note", () => {
  const fragments = buildStructuredVendorEvidence({
    response: response(),
    questionnaire: questionnaire(),
    calculation: calculation(),
  });
  const specs = textFor(fragments, "structured:room:room-1:specs");

  assert.match(specs, /Aspect Ratio: SUBSTITUTE/);
  assert.match(specs, /Client requirement: Aspect Ratio: 16:9 Native 4K/);
  assert.match(specs, /1080p rather than native 4K\./);
  // An exception on a mandatory requirement must not vanish silently.
  assert.match(specs, /Teleprompter Required: EXCEPTION/);
  assert.match(specs, /No teleprompter within budget\./);
});

test("crew, references and rooms are readable with questionnaire labels applied", () => {
  const fragments = buildStructuredVendorEvidence({
    response: response(),
    questionnaire: questionnaire(),
    calculation: calculation(),
  });

  assert.match(textFor(fragments, "structured:crew"), /Alex — Technical director/);
  assert.match(textFor(fragments, "structured:references"), /Cedar Trust — Awards Night/);
  assert.match(textFor(fragments, "structured:references"), /Dates: 2025-11-08 to 2025-11-08/);
  assert.match(textFor(fragments, "structured:room:room-1:equipment"), /Video x2: HD switcher/);
  assert.match(textFor(fragments, "structured:room:room-1:labor"), /Technical director: 2 day\(s\).*requires travel/);
  assert.match(textFor(fragments, "structured:room:room-1:hybrid"), /Dual encoders/);
});

test("a legacy response with no structured body yields no structured evidence", () => {
  assert.deepEqual(buildStructuredVendorEvidence({ response: null }), []);
});

test("empty sections are omitted rather than cited as blank headings", () => {
  const bare = { ...response(), crew: [], references: [], alternates: [], valueAdds: "" };
  const origins = buildStructuredVendorEvidence({
    response: bare,
    questionnaire: questionnaire(),
    calculation: calculation(),
  }).map((fragment) => fragment.origin);

  assert.equal(origins.includes("structured:crew"), false);
  assert.equal(origins.includes("structured:references"), false);
  assert.equal(origins.includes("structured:value-adds"), false);
  assert.equal(origins.includes("structured:pricing"), true);
});

test("a missing calculation still renders the vendor's stated assumptions", () => {
  const fragments = buildStructuredVendorEvidence({
    response: response(),
    questionnaire: questionnaire(),
    calculation: null,
  });
  const pricing = textFor(fragments, "structured:pricing");
  assert.doesNotMatch(pricing, /Grand total/);
  assert.match(pricing, /Excludes a teleprompter\./);
});
