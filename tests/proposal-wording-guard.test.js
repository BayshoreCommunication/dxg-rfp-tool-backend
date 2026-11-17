require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AUDIT_CATALOG, AUDIT_CATEGORIES, AUDIT_CSV_HEADER, SUPPORT_ACTOR_LABEL, auditCsv } = require("../src/modules/auditLog/domain");
const { PlanFeatureLockedError, PlanLimitReachedError } = require("../src/modules/entitlements/domain/plans");
const { renderInvitationEmail } = require("../src/modules/invitations/infrastructure/invitationEmailTemplate");
const proposalFormUi = require("../contracts/proposal/v1/proposal-form-ui.v1.json");

// Wording rule (owner decision, changed 2026-11-12): the document a planner writes and sends to
// vendors is a "Proposal" in everything a person reads: audit log labels and its CSV export, the
// form contract's labels and helper texts, refusal and error messages, emails and notifications.
// The product name RFPilot stays. Identifiers, routes, API fields, enum values, audit action keys
// (`proposal.share_granted`), error codes (OWNER_HAS_RFPS), queue names and comments keep "rfp".
//
// The dashboard has the same guard for its own text (lib/wording.test.ts there).

// "RFP", "RFPs", "RFP's" as a word of its own: not RFPilot, not part of an identifier.
const RFP_NOUN = /(?<![A-Za-z0-9_])RFP(?:s|'s|’s)?(?![A-Za-z0-9_])/;

// Blanks out comments but keeps the line count, so a finding points at the right line.
// "//" counts as a comment only at the start of a line or after a space (not in "https://").
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");

const repoRoot = path.join(__dirname, "..");
// Everything that can put text in front of a person. `contracts/generated` holds types only and
// `scripts/` is run by operators, so neither is scanned.
const ROOTS = ["src", "controller", "routes", "middleware", "utils", "modal", "config", "contracts/proposal", "contracts/vendor-response"];

// Deliberate exceptions: [file, text on the line, why it stays]. A line is checked with these
// phrases removed, so a second "RFP" on the same line still fails.
const ALLOWED = [
  // ── AI layer: wording here steers a model or is retrieval text. Changing it needs its own
  //    evaluation run, so it is tracked in docs/PROJECT_STATE.md and not converted here.
  ["src/modules/extraction/infrastructure/prompts/legacyProposalExtractionPromptV1.ts", "You are a document parser for an AV production RFP tool.", "extraction prompt"],
  ["src/modules/extraction/infrastructure/prompts/legacyProposalExtractionPromptV1.ts", "key RFP process dates/milestones as free text", "extraction prompt"],
  ["src/modules/vendorIntelligence/openAiVendorFactMappingProvider.ts", "Map each supplied RFP requirement only to the supplied vendor evidence.", "model instruction"],
  ["src/modules/liveAi/operations.ts", "reviewing a vendor proposal against the RFP requirements supplied in the evidence", "model instruction"],
  ["src/modules/liveAi/operations.ts", "Assume the planner may be completely new to RFP software.", "model instruction"],
  ["src/modules/platformAssistant/platformKnowledge.ts", "or old RFP (PDF, DOCX, XLSX, CSV", "assistant knowledge text (retrieval)"],
  ["src/modules/platformAssistant/platformKnowledge.ts", "event profile, and RFP timeline.", "assistant knowledge text (retrieval)"],
  ["src/modules/platformAssistant/platformKnowledge.ts", "Review the generated RFP for gaps or blocking guidance", "assistant knowledge text (retrieval)"],
  ["src/modules/platformAssistant/platformKnowledge.ts", "save a draft or generate/update the RFP at the end.", "assistant knowledge text (retrieval)"],
  ["src/modules/platformAssistant/platformKnowledge.ts", "save a draft or explicitly generate/update the RFP.", "assistant knowledge text (retrieval)"],
  ["src/modules/platformAssistant/deterministicAssistantProvider.ts", "explicitly generate or update the RFP, then use its send action", "assistant answer, part of the evaluated answer set"],
  ["src/modules/platformAssistant/deterministicAssistantProvider.ts", "Review the generated RFP for gaps, then use its send action", "assistant answer, part of the evaluated answer set"],
  ["src/modules/platformAssistant/deterministicAssistantProvider.ts", "explicitly generate/update the RFP at the end.", "assistant answer, part of the evaluated answer set"],
  // Requirement titles are derived from field keys (rfpTimelineNotes), stored in Postgres
  // requirement sets and sent to models as requirement text.
  ["src/modules/requirementRegistry/generator.ts", 'rfp: "RFP"', "acronym table for derived requirement titles (AI input, stored)"],

  // ── Read by operators or by code only.
  ["src/modules/entitlements/domain/plans.ts", "PLAN_FREE_TRIAL_PROPOSAL_LIMIT must be a whole number of RFPs", "startup error for a bad environment value"],
  ["src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts", 'super("member owns RFPs")', "internal error, caught in the same file"],
  ["src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts", 'super("selected RFPs not owned")', "internal error, caught in the same file"],
  ["controller/proposalTemplatesController.ts", 'console.error("RFP template error:"', "server log line"],
  ["src/modules/proposals/composition.ts", '"DXG-RFP-Tool"', "storage folder name"],
];

const sourceFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|js|json|html)$/.test(entry.name) && !/\.d\.ts$|\.test\.(ts|js)$/.test(entry.name) ? [full] : [];
  });

const leftoversIn = (file, source) => {
  const allowed = ALLOWED.filter(([allowedFile]) => allowedFile === file).map(([, text]) => text);
  return withoutComments(source)
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => RFP_NOUN.test(allowed.reduce((rest, phrase) => rest.split(phrase).join(""), text)))
    .map(({ line, text }) => `${file}:${line} ${text.trim().slice(0, 160)}`);
};

// Every string a JSON document carries, with the path to it.
const stringsIn = (value, at = "") => {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringsIn(item, `${at}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => stringsIn(item, `${at}/${key}`));
  return [];
};

test('backend-written text says "proposal", not "RFP"', () => {
  const leftovers = ROOTS.flatMap((root) => sourceFiles(path.join(repoRoot, root))).flatMap((full) => {
    const file = path.relative(repoRoot, full).split(path.sep).join("/");
    return leftoversIn(file, fs.readFileSync(full, "utf8"));
  });
  assert.deepEqual(leftovers, []);
});

test("every documented wording exception is still in use", () => {
  const stale = ALLOWED.filter(([file, text]) => !fs.readFileSync(path.join(repoRoot, file), "utf8").includes(text));
  assert.deepEqual(stale, []);
  for (const [file, text, why] of ALLOWED) assert.ok(why && why.length > 5, `${file}: "${text}" needs a reason`);
});

test("the audit log's categories, action labels and CSV say proposal", () => {
  const labels = [
    ...AUDIT_CATEGORIES.map((category) => [`category ${category.key}`, category.label]),
    ...Object.entries(AUDIT_CATALOG).map(([action, entry]) => [`action ${action}`, entry.label]),
    ...AUDIT_CSV_HEADER.map((cell) => ["csv header", cell]),
    ["support actor", SUPPORT_ACTOR_LABEL],
  ];
  assert.deepEqual(labels.filter(([, label]) => RFP_NOUN.test(label)), []);
  // Keys are identifiers and stay; the labels a customer reads are worded for them.
  assert.equal(AUDIT_CATEGORIES.find((category) => category.key === "sharing").label, "Proposal sharing");
  assert.equal(AUDIT_CATALOG["proposal.share_granted"].label, "Proposal shared");
  assert.equal(AUDIT_CATALOG["proposal.share_revoked"].label, "Proposal share removed");
  assert.equal(AUDIT_CATALOG["proposal.owner.reassigned"].label, "Proposal owner reassigned");

  // The export carries those labels and the stored names (`proposal`, `proposalId`), never "rfp".
  const csv = auditCsv([{
    id: "e1", occurredAt: "2026-11-16T00:00:00.000Z", action: "proposal.share_granted", label: AUDIT_CATALOG["proposal.share_granted"].label,
    category: "sharing", decision: "created", reason: "shared", actor: { kind: "system", id: null, name: "System" },
    target: { type: "proposal", id: "f".repeat(24), name: null }, details: { proposalId: "f".repeat(24) },
  }]);
  assert.doesNotMatch(csv, /rfp/i);
  assert.match(csv, /"Proposal shared","Proposal sharing"/);
  assert.match(csv, /"proposal","f{24}"/);
  assert.match(csv, /"proposalId: f{24}"/);
});

test("customers do not see template actions in their audit log (decision 2026-11-16)", () => {
  assert.deepEqual(Object.keys(AUDIT_CATALOG).filter((action) => action.startsWith("proposal_template.")), []);
});

test("every label, helper text, example and option in the form contract says proposal", () => {
  const strings = stringsIn(proposalFormUi);
  assert.ok(strings.length > 100, "the contract's strings were read");
  assert.deepEqual(strings.filter(([, text]) => RFP_NOUN.test(text)).map(([at, text]) => `${at}: ${text}`), []);
  // The field key keeps its name; the label a planner reads matches the dashboard's own.
  assert.equal(proposalFormUi.fields["/content/event/rfpTimelineNotes"].label, "Proposal Timeline");
});

test("plan refusals and rendered emails say proposal", () => {
  const messages = [
    new PlanLimitReachedError("free_trial", 2, 2).message,
    new PlanLimitReachedError("free_trial", 1, 1).message,
    new PlanFeatureLockedError("free_trial", "proposalIntelligence").message,
    new PlanFeatureLockedError("free_trial", "vendorResponses").message,
  ];
  for (const role of ["organization_admin", "team_manager", "planner", "viewer"]) {
    for (const kind of ["invite", "resend", "reminder"]) {
      const email = renderInvitationEmail({
        kind, role, to: "pat@example.test", organizationName: "Contoso Live", inviterName: "Dana", teamName: "East",
        acceptUrl: "https://app.example.test/invite/abc", expiresAt: new Date("2026-12-01T00:00:00Z"),
      });
      messages.push(email.subject, email.html, email.text);
    }
  }
  assert.deepEqual(messages.filter((message) => RFP_NOUN.test(message)), []);
  assert.equal(messages[0], "Your plan includes 2 proposals and your organization has created 2. Contact us to upgrade.");
  assert.equal(messages[1], "Your plan includes 1 proposal and your organization has created 1. Contact us to upgrade.");
});

test("the guard tells the noun from the product name and from identifiers", () => {
  for (const text of ["New RFP", "your RFPs", "this RFP's owner", "RFP Timeline", '"RFP not found."']) assert.ok(RFP_NOUN.test(text), text);
  for (const text of ["RFPilot Support", "OWNER_HAS_RFPS INVALID_RFP_SELECTION rfpId RfpShare", "rfp.created"]) assert.equal(RFP_NOUN.test(text), false, text);
  assert.doesNotMatch(withoutComments('a // RFP\n"https://x" /* RFP\nRFP */ b'), RFP_NOUN);
  assert.deepEqual(leftoversIn("x.ts", 'const m = "This RFP has been sent";\n// an RFP\n'), ['x.ts:1 const m = "This RFP has been sent";']);
});
