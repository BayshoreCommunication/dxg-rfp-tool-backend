const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseFilters,
  parseListRequest,
  quarterOf,
  RfpDashboardError,
  summarize,
} = require("../src/modules/rfpDashboard/domain");
const { createRfpDashboard } = require("../src/modules/rfpDashboard/application");

const invalid = (query) => assert.throws(() => parseFilters(query), (error) => error instanceof RfpDashboardError && error.code === "DASHBOARD_FILTER_INVALID");

test("filters parse, trim and drop empty values", () => {
  assert.deepEqual(parseFilters({}), { stages: [] });
  assert.deepEqual(
    parseFilters({
      stage: "sent, under_review,sent",
      owner: "64b000000000000000000001",
      team: "64b000000000000000000002",
      eventFrom: "2027-01-01",
      eventTo: "2027-03-31",
      venueCity: "  Chicago ",
      search: " Summit ",
    }),
    {
      stages: ["sent", "under_review"],
      ownerUserId: "64b000000000000000000001",
      teamId: "64b000000000000000000002",
      eventFrom: "2027-01-01",
      eventTo: "2027-03-31",
      venueCity: "Chicago",
      search: "Summit",
    },
  );
  assert.deepEqual(parseFilters({ stage: "", owner: "  " }), { stages: [] });
  // Repeated query keys arrive as arrays; the first wins.
  assert.deepEqual(parseFilters({ stage: ["draft", "sent"] }).stages, ["draft"]);
});

test("bad filters are refused rather than ignored", () => {
  invalid({ stage: "won" });
  invalid({ owner: "nobody" });
  invalid({ team: "{$ne:null}" });
  invalid({ eventFrom: "2027-02-30" });
  invalid({ eventTo: "03/31/2027" });
  invalid({ eventFrom: "2027-05-01", eventTo: "2027-04-01" });
  invalid({ venueCity: "x".repeat(121) });
});

test("list requests bound paging and sort", () => {
  const defaults = parseListRequest({});
  assert.deepEqual([defaults.page, defaults.limit, defaults.sortBy, defaults.sortOrder], [1, 25, "updatedAt", "desc"]);
  const capped = parseListRequest({ page: "0", limit: "5000", sortBy: "eventStartDate", sortOrder: "asc" });
  assert.deepEqual([capped.page, capped.limit, capped.sortBy, capped.sortOrder], [1, 100, "eventStartDate", "asc"]);
  assert.throws(() => parseListRequest({ sortBy: "password" }), RfpDashboardError);
});

test("the quarter follows the organization's time zone", () => {
  // 1 Apr 03:00 UTC is still 31 Mar in Chicago (Q1) but already Q2 in UTC.
  const instant = new Date("2027-04-01T03:00:00.000Z");
  const chicago = quarterOf(instant, "America/Chicago");
  assert.equal(chicago.label, "2027-Q1");
  assert.equal(chicago.start.toISOString(), "2027-01-01T06:00:00.000Z");
  // Q1 ends at local midnight on 1 Apr, after the March DST change (UTC-5).
  assert.equal(chicago.end.toISOString(), "2027-04-01T05:00:00.000Z");
  const utc = quarterOf(instant, null);
  assert.equal(utc.label, "2027-Q2");
  assert.equal(utc.start.toISOString(), "2027-04-01T00:00:00.000Z");
  assert.equal(utc.end.toISOString(), "2027-07-01T00:00:00.000Z");
  assert.equal(quarterOf(instant, "Not/AZone").timeZone, "UTC");
});

test("Q4 ends at the next year's start, east of UTC too", () => {
  const tokyo = quarterOf(new Date("2027-12-31T16:00:00.000Z"), "Asia/Tokyo");
  // That instant is already 1 Jan 2028 in Tokyo.
  assert.equal(tokyo.label, "2028-Q1");
  assert.equal(tokyo.start.toISOString(), "2027-12-31T15:00:00.000Z");
  const late = quarterOf(new Date("2027-11-15T00:00:00.000Z"), "Asia/Tokyo");
  assert.equal(late.label, "2027-Q4");
  assert.equal(late.end.toISOString(), "2027-12-31T15:00:00.000Z");
});

test("summarize defines the summary over a list", () => {
  const quarter = { start: new Date("2027-01-01T00:00:00Z"), end: new Date("2027-04-01T00:00:00Z") };
  const summary = summarize(
    [
      { stage: "draft", vendorsResponded: 0, awardedAt: null },
      { stage: "sent", vendorsResponded: 0, awardedAt: null },
      { stage: "receiving_responses", vendorsResponded: 3, awardedAt: null },
      { stage: "under_review", vendorsResponded: 2, awardedAt: null },
      { stage: "awarded", vendorsResponded: 4, awardedAt: "2027-02-10T00:00:00Z" },
      { stage: "awarded", vendorsResponded: 1, awardedAt: "2026-12-31T23:59:59Z" },
      // Archived keeps its old award time but no longer counts as awarded.
      { stage: "archived", vendorsResponded: 5, awardedAt: "2027-02-11T00:00:00Z" },
    ],
    quarter,
  );
  assert.deepEqual(summary, {
    total: 7,
    activeRfps: 3,
    responsesReceived: 15,
    awardedThisQuarter: 1,
    byStage: { draft: 1, sent: 1, receiving_responses: 1, under_review: 1, awarded: 2, archived: 1 },
  });
});

test("the application parses before reading and adds the organization's quarter", async () => {
  const calls = [];
  const dashboard = createRfpDashboard({
    repository: {
      list: async (actor, request) => { calls.push(["list", request]); return { items: [], total: 51 }; },
      summary: async (actor, filters, quarter) => { calls.push(["summary", filters, quarter.label]); return { total: 0 }; },
    },
    organizationTimeZone: async () => "America/Chicago",
    now: () => new Date("2027-04-01T03:00:00.000Z"),
  });
  const actor = { organizationId: "64b000000000000000000001", userId: "64b000000000000000000002" };
  const list = await dashboard.list(actor, { limit: "25", page: "3" });
  assert.deepEqual(list.pagination, { total: 51, page: 3, limit: 25, totalPages: 3 });
  const summary = await dashboard.summary(actor, { stage: "awarded" });
  assert.equal(summary.quarter.label, "2027-Q1");
  assert.deepEqual(calls[1], ["summary", { stages: ["awarded"] }, "2027-Q1"]);
  await assert.rejects(dashboard.summary(actor, { stage: "won" }), RfpDashboardError);
  assert.equal(calls.length, 2);
});
