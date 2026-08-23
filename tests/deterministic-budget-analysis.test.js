const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  BUDGET_CALCULATION_VERSION,
  buildBudgetAnalysis,
} = require("../src/modules/investment/budgetAnalysis");
const { computeInvestmentGuidance } = require("../src/modules/investment/domain");

const line = (overrides = {}) => ({
  category: "audio",
  label: "General session - Audio",
  currency: "USD",
  lowMinor: 10_000,
  midMinor: 12_000,
  highMinor: 15_000,
  templateKey: "GENERAL_SESSION",
  componentKey: "gs_audio",
  kind: "equipment",
  quantity: 1,
  unitLabel: "per event",
  implied: false,
  appliedFactors: [],
  provenance: {
    pricingRecordIds: ["price-1"],
    ruleIds: [],
    drivers: { event: 1 },
  },
  ...overrides,
});

const buildInput = (overrides = {}) => ({
  proposal: {
    budget: { amountMinor: 20_000, currency: "USD" },
    venueSchedule: {
      loadInDate: "2026-10-01",
      rehearsalDate: "2026-10-01",
      strikeDate: "2026-10-02",
    },
    roomByRoom: [
      {
        _id: "main",
        roomFunction: "General Session",
        roomSetup: "Theater",
        estimatedAttendeesInRoom: "500",
        showStartDateTime: "2026-10-01T09:00:00.000Z",
        showEndDateTime: "2026-10-01T10:00:00.000Z",
      },
    ],
  },
  currency: "USD",
  totalLowMinor: 10_000,
  totalMidMinor: 12_000,
  totalHighMinor: 15_000,
  lineItems: [line()],
  refusals: [],
  ancillary: [],
  assumptions: [],
  recommendations: [],
  pricingRecords: [
    {
      id: "price-1",
      revision: 2,
      category: "audio",
      itemLabel: "Audio",
      unit: "per_event",
      amountLowMinor: 10_000,
      amountMidMinor: 12_000,
      amountHighMinor: 15_000,
      currency: "USD",
      market: null,
      dayType: "any",
      laborRole: null,
    },
  ],
  rules: [],
  regionalFactors: [],
  modifiers: [],
  confidenceRules: [],
  ...overrides,
});

test("budget analysis records immutable calculation, pricing, and rule versions", () => {
  const input = buildInput();
  const first = buildBudgetAnalysis(input);
  const replay = buildBudgetAnalysis(input);
  const revised = buildBudgetAnalysis({
    ...input,
    pricingRecords: input.pricingRecords.map((record) => ({
      ...record,
      revision: 3,
    })),
  });
  assert.equal(first.calculationVersion, BUDGET_CALCULATION_VERSION);
  assert.equal(first.pricingReleaseVersion, replay.pricingReleaseVersion);
  assert.equal(first.ruleReleaseVersion, replay.ruleReleaseVersion);
  assert.notEqual(first.pricingReleaseVersion, revised.pricingReleaseVersion);
  assert.match(first.pricingReleaseVersion, /^approved-pricing\.v1:/);
  assert.match(first.ruleReleaseVersion, /^approved-rules\.v1:/);
});

test("an incomplete estimate never fabricates a complete total", () => {
  const result = buildBudgetAnalysis(
    buildInput({
      refusals: [
        {
          category: "lighting",
          reason: "No approved lighting rate.",
          ask: "Request a vendor quote.",
        },
      ],
      ancillary: [
        {
          factor: "Insurance",
          status: "no_data",
          note: "Confirm coverage.",
        },
      ],
    }),
  );
  assert.equal(result.status, "incomplete");
  assert.equal(result.completeTotal, null);
  assert.ok(result.missing.some((item) => item.key === "lighting"));
  assert.ok(result.missing.some((item) => item.key === "Insurance"));
  assert.deepEqual(result.calculatedTotal, {
    currency: "USD",
    lowMinor: 10_000,
    midMinor: 12_000,
    highMinor: 15_000,
  });
});

test("budget ceiling warnings include only deterministic impact", () => {
  const result = buildBudgetAnalysis(
    buildInput({
      proposal: {
        ...buildInput().proposal,
        budget: { amountMinor: 9_000, currency: "USD" },
      },
    }),
  );
  const warning = result.warnings.find(
    (item) => item.code === "ESTIMATE_EXCEEDS_BUDGET_CEILING",
  );
  assert.ok(warning);
  assert.deepEqual(warning.estimatedImpact, {
    currency: "USD",
    lowMinor: 1_000,
    midMinor: 3_000,
    highMinor: 6_000,
  });
});

test("currency mismatch refuses a numerical budget comparison", () => {
  const result = buildBudgetAnalysis(
    buildInput({
      proposal: {
        ...buildInput().proposal,
        budget: { amountMinor: 9_000, currency: "EUR" },
      },
    }),
  );
  const warning = result.warnings.find(
    (item) => item.code === "BUDGET_CURRENCY_MISMATCH",
  );
  assert.ok(warning);
  assert.equal(warning.estimatedImpact, null);
  assert.ok(
    !result.warnings.some(
      (item) => item.code === "ESTIMATE_EXCEEDS_BUDGET_CEILING",
    ),
  );
});

test("category, labor, equipment, room, and shared breakdowns preserve totals", () => {
  const lines = [
    line(),
    line({
      category: "labor",
      label: "General session - A1",
      componentKey: "gs_a1",
      kind: "labor",
      lowMinor: 3_000,
      midMinor: 4_000,
      highMinor: 5_000,
    }),
    line({
      category: "video",
      label: "Recording",
      templateKey: "RECORDING",
      componentKey: "camera",
      lowMinor: 6_000,
      midMinor: 7_000,
      highMinor: 8_000,
    }),
  ];
  const result = buildBudgetAnalysis(
    buildInput({
      totalLowMinor: 19_000,
      totalMidMinor: 23_000,
      totalHighMinor: 28_000,
      lineItems: lines,
    }),
  );
  assert.equal(result.categoryBreakdown.length, 3);
  assert.equal(result.equipmentSubtotal.midMinor, 19_000);
  assert.equal(result.laborSubtotal.midMinor, 4_000);
  assert.equal(result.roomBreakdown[0].amount.midMinor, 16_000);
  assert.equal(result.sharedServicesSubtotal.midMinor, 7_000);
});

test("equipment without labor and missing work windows stay visible", () => {
  const result = buildBudgetAnalysis(
    buildInput({
      proposal: {
        roomByRoom: [
          {
            roomFunction: "General Session",
            showStartDateTime: "2026-10-01T09:00:00.000Z",
            showEndDateTime: "2026-10-01T10:00:00.000Z",
          },
        ],
      },
    }),
  );
  const codes = result.warnings.map((warning) => warning.code);
  for (const code of [
    "EQUIPMENT_WITHOUT_LABOR",
    "SETUP_LABOR_WINDOW_MISSING",
    "REHEARSAL_LABOR_WINDOW_MISSING",
    "STRIKE_LABOR_WINDOW_MISSING",
  ])
    assert.ok(codes.includes(code), code);
});

test("schedule-backed possible savings never invent a dollar impact", () => {
  const camera = { cameras: "YES", camerasQty: "2" };
  const result = buildBudgetAnalysis(
    buildInput({
      proposal: {
        ...buildInput().proposal,
        roomByRoom: [
          {
            _id: "morning",
            roomFunction: "General Session",
            roomSetup: "Theater",
            estimatedAttendeesInRoom: "500",
            showStartDateTime: "2026-10-01T09:00:00.000Z",
            showEndDateTime: "2026-10-01T10:00:00.000Z",
            cameras: camera,
          },
          {
            _id: "afternoon",
            roomFunction: "Breakout",
            roomSetup: "Classroom",
            estimatedAttendeesInRoom: "100",
            showStartDateTime: "2026-10-01T12:00:00.000Z",
            showEndDateTime: "2026-10-01T13:00:00.000Z",
            cameras: camera,
          },
        ],
      },
    }),
  );
  assert.equal(result.possibleSavings.length, 1);
  assert.equal(result.possibleSavings[0].estimatedImpact, null);
  assert.match(result.possibleSavings[0].reason, /may allow reuse/);
});

test("the existing engine uses integer minor-unit arithmetic", () => {
  const source = fs.readFileSync(
    path.join(
      path.resolve(__dirname, ".."),
      "src/modules/investment/domain.ts",
    ),
    "utf8",
  );
  assert.ok(source.includes("BigInt(baseMinor)"));
  assert.ok(source.includes("BigInt(FACTOR_SCALE)"));
  const result = computeInvestmentGuidance(
    {
      event: {
        eventName: "Summit",
        startDate: "2026-10-01",
        endDate: "2026-10-01",
      },
      roomByRoom: [{ roomFunction: "General Session" }],
    },
    buildInput().pricingRecords,
    [],
  );
  assert.ok(
    result.lineItems.every(
      (item) =>
        Number.isSafeInteger(item.lowMinor) &&
        Number.isSafeInteger(item.midMinor) &&
        Number.isSafeInteger(item.highMinor),
    ),
  );
});

test("budget analysis persistence has version columns and a JSON object", () => {
  const root = path.resolve(__dirname, "..");
  const migration = fs.readFileSync(
    path.join(
      root,
      "migrations/postgres/037_deterministic_budget_analysis.up.sql",
    ),
    "utf8",
  );
  const repository = fs.readFileSync(
    path.join(
      root,
      "src/modules/investment/postgresInvestmentRepository.ts",
    ),
    "utf8",
  );
  for (const column of [
    "calculation_version",
    "pricing_release_version",
    "rule_release_version",
    "budget_analysis",
  ])
    assert.ok(migration.includes(column), column);
  assert.ok(repository.includes("JSON.stringify(result.budgetAnalysis)"));
  assert.ok(repository.includes("dxg-av-pricing-engine.v4"));
});
