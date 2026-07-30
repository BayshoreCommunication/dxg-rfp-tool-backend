const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  renderProposalExport,
  proposalExportEnabled,
} = require("../src/modules/proposalDraft/exportDocument");
const { DRAFT_SECTION_KEYS, ProposalDraftError } = require("../src/modules/proposalDraft/domain");

const AT = new Date("2026-07-26T12:00:00.000Z");
const section = (key, decision, text = "Body text for the section.") => ({
  key,
  heading: key.replace(/_/g, " "),
  decision,
  paragraphs: [{ text }],
});
const render = (sections, extra = {}) =>
  renderProposalExport({ eventName: "Northstar Summit", sections, generatedAt: AT, ...extra });

test("export is deny-by-default", () => {
  const saved = process.env.PROPOSAL_EXPORT_ENABLED;
  try {
    delete process.env.PROPOSAL_EXPORT_ENABLED;
    assert.equal(proposalExportEnabled(), false);
    for (const value of ["1", "yes", "TRUE", ""]) {
      process.env.PROPOSAL_EXPORT_ENABLED = value;
      assert.equal(proposalExportEnabled(), false, value);
    }
    process.env.PROPOSAL_EXPORT_ENABLED = "true";
    assert.equal(proposalExportEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.PROPOSAL_EXPORT_ENABLED;
    else process.env.PROPOSAL_EXPORT_ENABLED = saved;
  }
});

test("only sections a human accepted reach the document", () => {
  const html = render([
    section("event_overview", "accepted", "Accepted overview."),
    section("production_scope", "rejected", "Rejected scope."),
    section("venue_schedule", null, "Undecided schedule."),
  ]);
  assert.match(html, /Accepted overview\./);
  // Silence must mean "not approved": this file leaves the building.
  assert.doesNotMatch(html, /Rejected scope\./);
  assert.doesNotMatch(html, /Undecided schedule\./, "undecided is excluded, not included by default");
  assert.match(html, /1 reviewed section</, "the count reflects what was included");
});

test("exporting with nothing accepted is refused rather than producing an empty RFP", () => {
  assert.throws(
    () => render([section("event_overview", null), section("venue_schedule", "rejected")]),
    (error) => error instanceof ProposalDraftError && error.code === "NO_ACCEPTED_SECTIONS" && error.status === 409,
  );
});

test("sections are ordered by the canonical section order, not by acceptance order", () => {
  const html = render([
    section("vendor_terms", "accepted", "Terms body."),
    section("event_overview", "accepted", "Overview body."),
    section("venue_schedule", "accepted", "Schedule body."),
  ]);
  const order = ["Overview body.", "Schedule body.", "Terms body."].map((t) => html.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "document follows DRAFT_SECTION_KEYS order");
  assert.ok(DRAFT_SECTION_KEYS.indexOf("event_overview") < DRAFT_SECTION_KEYS.indexOf("vendor_terms"));
});

test("model output is escaped, so generated prose cannot inject markup", () => {
  // This file is downloaded and forwarded to vendors. Unescaped model output
  // would be stored XSS in an artifact that leaves the organisation.
  const html = render(
    [section("event_overview", "accepted", '</p><script>alert("xss")</script><p>')],
    { eventName: '<img src=x onerror="alert(1)">' },
  );
  // The test is that no TAG forms. "onerror=" surviving as literal text inside
  // an escaped string is harmless — it is the angle brackets that matter.
  assert.doesNotMatch(html, /<script/, "no script tag survives");
  assert.doesNotMatch(html, /<img/, "no img tag survives from the title");
  assert.match(html, /&lt;script&gt;/, "the payload is rendered as visible text");
  assert.match(html, /&lt;img src=x/, "the title is escaped too");
  assert.match(html, /&quot;alert\(1\)&quot;/, "quotes are escaped so no attribute can be opened");
  // The paragraph the payload tried to close is still balanced. Counts opening
  // tags as /<p[ >]/ because the document also emits <p class="meta"> etc.
  assert.equal((html.match(/<p[ >]/g) || []).length, (html.match(/<\/p>/g) || []).length);
});

test("outstanding gaps are carried into the document rather than hidden", () => {
  const html = render([section("event_overview", "accepted")], {
    gaps: [{ code: "MISSING_ROOM_COUNT" }],
  });
  assert.match(html, /Outstanding information/);
  assert.match(html, /room count/, "gap codes are humanised");
  // No gaps means no empty section.
  assert.doesNotMatch(render([section("event_overview", "accepted")]), /Outstanding information/);
});

test("the document discloses that it is AI-assisted and human-reviewed", () => {
  const html = render([section("event_overview", "accepted")]);
  assert.match(html, /AI assistance/);
  assert.match(html, /reviewed by a person/);
  assert.match(html, /^<!doctype html>/, "a standalone file, not a fragment");
});

test("export is a read: the route requires proposal:read and never mutates", () => {
  const root = path.join(__dirname, "..");
  const route = fs.readFileSync(path.join(root, "routes/proposalDraftRoute.ts"), "utf8");
  assert.match(route, /draft-export/);
  const line = route.slice(route.indexOf("draft-export"));
  assert.match(line.slice(0, 200), /authorizeAction\("proposal:read"\)/, "read authorization");
  const controller = fs.readFileSync(path.join(root, "controller/proposalDraftController.ts"), "utf8");
  const handler = controller.slice(controller.indexOf("export const exportProposalDraft"));
  const body = handler.slice(0, handler.indexOf("export const decideDraftSection"));
  for (const mutation of ["findOneAndUpdate", "updateOne", "INSERT", "UPDATE "]) {
    assert.ok(!body.includes(mutation), `export must not ${mutation}`);
  }
});
