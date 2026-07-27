const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { renderVendorAnalysisExport } = require("../src/modules/vendorAnalysis/exportDocument");
const { renderInvestmentExport } = require("../src/modules/investment/exportDocument");

const AT = new Date("2026-07-27T12:00:00.000Z");
const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("the vendor review carries the vendor's own words, not just the verdicts", () => {
  // The shortlisting decision is made in a meeting from a circulated document.
  // Retyping verdicts into a spreadsheet left the citations behind, and a
  // verdict of "partial" is not arguable without the sentence behind it.
  const html = renderVendorAnalysisExport({
    vendorName: "Bright AV",
    eventName: "Annual Summit",
    findings: [
      { ordinal: 1, kind: "compliance", requirementLabel: "Rigging required", requirementPath: "/content/venue/riggingRequired", verdict: "partial", message: "Rigging is mentioned but no rig plot is included.", needsHumanReview: true, citations: ["f1", "gone"] },
      { ordinal: 2, kind: "pricing_flag", requirementLabel: null, requirementPath: null, verdict: null, message: "Labor is quoted as a lump sum.", needsHumanReview: false, citations: [] },
      { ordinal: 3, kind: "vendor_question", requirementLabel: null, requirementPath: null, verdict: null, message: "Can you provide a rig plot?", needsHumanReview: false, citations: [] },
    ],
    evidence: [{ fragmentId: "f1", origin: "DXG/vendor-responses-private/x/rig-notes.pdf", excerpt: "House crew handles rigging." }],
    generatedAt: AT,
  });

  assert.match(html, /Vendor response review — Bright AV/);
  assert.match(html, /Rigging is mentioned but no rig plot is included\./);
  assert.match(html, /Partial \(review recommended\)/);
  assert.match(html, /<blockquote>House crew handles rigging\.<br><em>— rig-notes\.pdf<\/em><\/blockquote>/);
  // A citation with no persisted fragment is dropped: an empty blockquote reads
  // as "the vendor said nothing" rather than "not recorded".
  assert.equal(html.match(/<blockquote>/g).length, 1);
  assert.match(html, /Labor is quoted as a lump sum\./);
  assert.match(html, /Can you provide a rig plot\?/);
  assert.match(html, /not a scoring decision/);
});

test("an empty vendor analysis refuses to export rather than shipping a blank review", () => {
  assert.throws(
    () => renderVendorAnalysisExport({ findings: [], evidence: [], generatedAt: AT }),
    (error) => error.code === "NO_FINDINGS" && error.status === 409,
  );
});

test("the estimate ships with the reasons it is not a quote", () => {
  const html = renderInvestmentExport({
    eventName: "Annual Summit",
    currency: "usd",
    totalLowMinor: 8000000, totalMidMinor: 10000000, totalHighMinor: 12500000,
    lineItems: [{ category: "audio", label: "Line array", lowMinor: 500000, midMinor: 600000, highMinor: 700000, quantity: 2, unitLabel: "day", implied: false }],
    refusals: [{ category: "rigging", reason: "No approved rate for this market.", ask: "Ask the venue for rigging rates." }],
    ancillary: [{ factor: "Crew travel & per diem", status: "venue_dependent", note: "Depends on crew origin." }],
    assumptions: [{ key: "days", label: "Show days", note: "Two show days assumed from the schedule." }],
    scenarios: [{ key: "lean", label: "Lean", lowMinor: 6000000, midMinor: 7000000, highMinor: 8000000, basis: "Fewer cameras." }],
    confidence: "medium",
    generatedAt: AT,
  });

  assert.match(html, /Investment estimate — Annual Summit/);
  assert.match(html, /80,000 USD/);
  assert.match(html, /Line array/);
  // Dropping these is how an estimate gets read as a commitment.
  assert.match(html, /Not covered by this estimate/);
  assert.match(html, /No approved rate for this market\./);
  assert.match(html, /Crew travel &amp; per diem/);
  assert.match(html, /Two show days assumed from the schedule\./);
  assert.match(html, /not a quote and not an offer/);
});

test("the estimate export never renders the pricing workbook's shape", () => {
  // The per-line provenance is pricing-record ids, rule ids and driver weights:
  // that is the proprietary workbook, and this file leaves the building.
  const source = read("src/modules/investment/exportDocument.ts");
  for (const leak of ["pricingRecordIds", "ruleIds", "drivers", "templateKey", "componentKey", "appliedFactors"])
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(source.replace(/\/\*[\s\S]*?\*\//g, "")), `export must not render ${leak}`);

  // Passing a line item that still carries provenance must not surface it.
  const html = renderInvestmentExport({
    currency: "usd", totalLowMinor: 1, totalMidMinor: 1, totalHighMinor: 1,
    lineItems: [{ category: "audio", label: "Mixer", lowMinor: 1, midMinor: 1, highMinor: 1, quantity: 1, unitLabel: null, implied: false, provenance: { pricingRecordIds: ["rec-secret-1"], ruleIds: ["rule-secret"], drivers: { attendees: 3 } } }],
    refusals: [], ancillary: [], assumptions: [], scenarios: [], confidence: "low", generatedAt: AT,
  });
  assert.ok(!html.includes("rec-secret-1") && !html.includes("rule-secret"));
});

test("both exports escape everything they interpolate", () => {
  // Model output and vendor-supplied text in a file the planner forwards on:
  // an unescaped tag here is stored XSS in an attachment.
  const html = renderVendorAnalysisExport({
    vendorName: "<script>alert(1)</script>",
    findings: [{ ordinal: 1, kind: "compliance", requirementLabel: "<img src=x>", requirementPath: null, verdict: "missing", message: "<b>bold</b>", needsHumanReview: false, citations: ["f1"] }],
    evidence: [{ fragmentId: "f1", origin: "message", excerpt: "</blockquote><script>alert(2)</script>" }],
    generatedAt: AT,
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x>"));
  assert.ok(!html.includes("<b>bold</b>"));
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test("both export routes are gated, rate limited, and not shadowed", () => {
  const vendor = read("routes/vendorAnalysisRoute.ts");
  const exportAt = vendor.indexOf("analysis-export");
  const runAt = vendor.indexOf("analysis-runs/:runId");
  assert.ok(exportAt > 0 && exportAt < runAt, "'export' must not be read as a run id");
  assert.match(vendor.slice(exportAt, exportAt + 220), /authorizeAction\("vendor-response:read"\)[\s\S]*limit/);

  const investment = read("routes/investmentRoute.ts");
  assert.match(investment, /investment-guidance-reports\/export[\s\S]*authorizeAction\("proposal:read"\)[\s\S]*limit/);

  // Both are off unless the environment says otherwise, like every other AI
  // surface in this codebase.
  assert.match(read("src/modules/vendorAnalysis/exportDocument.ts"), /VENDOR_ANALYSIS_EXPORT_ENABLED === "true"/);
  assert.match(read("src/modules/investment/exportDocument.ts"), /INVESTMENT_EXPORT_ENABLED === "true"/);
});
