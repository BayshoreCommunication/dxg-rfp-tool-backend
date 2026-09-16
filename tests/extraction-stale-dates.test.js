const test = require("node:test");
const assert = require("node:assert/strict");
require("ts-node/register");
const {
  isStaleCandidateDate,
  normalizeAndDeduplicateExtractionCandidates,
} = require("../src/modules/liveAi/extractionPipeline");

const NOW = new Date("2026-09-16T12:00:00Z");
const iso = (offsetDays) =>
  new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);

test("a date that has already passed is not a usable answer", () => {
  // The regression: the example brief's "Proposal due August 7" and event
  // dates were written straight through, so a planner saw an RFP soliciting
  // bids against a deadline five weeks gone — a value the composer's own
  // isBeforeLocalToday guard refuses when typed by hand.
  assert.equal(isStaleCandidateDate(iso(-40), NOW), true, "last month is stale");
  assert.equal(isStaleCandidateDate(iso(-2), NOW), true, "two days ago is stale");
  assert.equal(isStaleCandidateDate(iso(30), NOW), false, "next month is fine");
  assert.equal(isStaleCandidateDate(iso(0), NOW), false, "today is fine");
});

test("timezone slack keeps the server from rejecting the planner's today", () => {
  // The server compares in UTC while the planner reads dates locally, so
  // "yesterday" in UTC is still today as far west as UTC-11. One day of slack
  // costs nothing and avoids rejecting a date the planner considers valid.
  assert.equal(isStaleCandidateDate(iso(-1), NOW), false, "yesterday UTC is still someone's today");
});

test("a malformed date is left to the normalizer, not judged as stale", () => {
  for (const value of ["", "not-a-date", "2026-13-45", "07/08/2026"])
    assert.equal(isStaleCandidateDate(value, NOW), false, value);
});

test("stale dates become questions while good candidates survive", () => {
  const evidence = [{ id: "ev1", sourceKey: "s1", text: "Proposal due August 7" }];
  const candidates = [
    { path: "/content/event/startDate", value: iso(-2), confidence: 0.9, citations: ["ev1"] },
    { path: "/content/budget/proposalSubmissionDueDate", value: iso(-40), confidence: 0.9, citations: ["ev1"] },
    { path: "/content/event/endDate", value: iso(45), confidence: 0.9, citations: ["ev1"] },
  ];
  const result = normalizeAndDeduplicateExtractionCandidates(candidates, evidence);

  const keptPaths = result.candidates.map((c) => c.path);
  assert.deepEqual(keptPaths, ["/content/event/endDate"], "only the future date is applied");

  const stale = result.issues.filter((i) => i.code === "CANDIDATE_DATE_IN_PAST");
  assert.equal(stale.length, 2, "each stale field is asked about separately");
  assert.deepEqual(
    stale.map((i) => i.paths[0]).sort(),
    ["/content/budget/proposalSubmissionDueDate", "/content/event/startDate"],
  );
  for (const issue of stale)
    assert.equal(issue.severity, "question", "the planner is asked, not blocked");
});
