require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProposalTemplates } = require("../src/modules/proposalTemplates/application/manageProposalTemplates");
const { ProposalTemplateError } = require("../src/modules/proposalTemplates/domain");
const { MAX_TEMPLATE_CONTENT_BYTES, isExcludedTemplateKey, templateContentOf } = require("../src/modules/proposals/domain/templateSnapshot");
const { hasOrganizationAction } = require("../src/modules/identity/domain/authorizationPolicy");
const { createCreateProposalFromTemplate } = require("../src/modules/proposals/application/authorOwnedProposal");
const { PlanLimitReachedError } = require("../src/modules/entitlements/domain/plans");

// ORG-604: RFP templates. Role policy, the personal/organization boundary, what a snapshot
// keeps, the state changes and their audit events, and the RFP a template creates.

const ORG = "a".repeat(24);
const OTHER_ORG = "9".repeat(24);
const USERS = { owner: "1".repeat(24), organization_admin: "2".repeat(24), team_manager: "3".repeat(24), planner: "4".repeat(24), dxg_producer: "5".repeat(24), viewer: "6".repeat(24), knowledge_editor: "7".repeat(24), knowledge_approver: "8".repeat(24) };
const actor = (role, overrides = {}) => ({ organizationId: ORG, userId: USERS[role], roles: [role], correlationId: "c1", ...overrides });
const MANAGERS = ["owner", "organization_admin"];
const USERS_ONLY = ["team_manager", "planner", "dxg_producer"];
const NO_ACCESS = ["viewer", "knowledge_editor", "knowledge_approver"];
const PROPOSAL_ID = "d".repeat(24);
const HIDDEN_PROPOSAL_ID = "e".repeat(24);

const RFP = {
  _id: PROPOSAL_ID,
  organizationId: ORG,
  userId: USERS.planner,
  teamId: "f".repeat(24),
  status: "submitted",
  isDraft: false,
  isActive: true,
  isFavorite: true,
  viewsCount: 41,
  candidateApplicationIds: ["cand-1"],
  lifecycle: { stage: "vendors_invited", vendorsInvited: 3, vendorsResponded: 2, awardedByUserId: USERS.owner },
  proposalSettings: { vendorResponseFormat: "structured", linkPrefix: "acme" },
  event: {
    eventName: "Annual Sales Kickoff",
    editionYear: "2026",
    startDate: "2026-03-02",
    endDate: "2026-03-04",
    attendees: "800",
    eventFormat: "Hybrid",
    eventObjectives: "Launch the new line",
    statementOfWork: "Full production",
    rfpTimeline: "Responses due 1 Feb",
  },
  venueSchedule: { venueName: "Grand Hall", timeZone: "America/Chicago", loadInDate: "2026-03-01", loadInTime: "08:00", showStartDate: "2026-03-02", strikeTime: "22:00" },
  roomByRoom: [
    { roomFunction: "General session", scheduleDate: "2026-03-02", loadInDateTime: "2026-03-01T08:00", wirelessMicsQty: "6", functions: [{ name: "Keynote", showStartDateTime: "2026-03-02T09:00" }] },
  ],
  production: { unionLabor: "Yes", showCrewNeeded: ["A1", "V1"] },
  hybridVirtual: { livestream: "YES" },
  contentCreative: { brandGuideUrl: "https://brand.example", brandGuideFiles: ["s3://secret/brand.pdf"] },
  videoRecordingStep: { retired: true },
  venue: { riggingRequired: "YES", inHouseAvRequired: "YES", inHouseAvCompanyName: "House AV", venueAvContactName: "Sam Venue", venueAvContactEmail: "sam@venue.example", venueAvContactPhone: "555 0100", venueDocs: ["s3://secret/venue.pdf"] },
  uploads: { supportDocuments: ["s3://secret/doc.pdf"], coVendors: { photographer: { companyName: "Snap Co", contactEmail: "snap@vendor.example" } }, ndaRequired: "YES" },
  budget: { estimatedAvBudget: "$100k-$250k", evaluationMatrix: { price: 40, experience: 60 }, proposalSubmissionDueDate: "2026-02-01", decisionDate: "2026-02-15", vendorPresentationOpportunity: "YES" },
  contact: { contactFirstName: "Pat", contactLastName: "Planner", contactEmail: "pat@customer.example", contactPhone: "555 0199" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

// In-memory repository with the same contract as the Mongo one, including the visibility filter.
const fakeTemplates = () => {
  const rows = [];
  let next = 1;
  const view = ({ organizationId: _o, ...template }) => structuredClone(template);
  const own = (organizationId, templateId) => rows.find((t) => t.id === templateId && t.organizationId === organizationId);
  const visible = (viewer, t) =>
    t.scope === "personal" ? t.ownerUserId === viewer.userId : viewer.managesOrganizationTemplates || (t.publishedAt !== null && !t.archived);
  return {
    rows,
    async list(organizationId, viewer, query) {
      const needle = query.search.toLowerCase();
      const matches = rows
        .filter((t) => t.organizationId === organizationId && visible(viewer, t))
        .filter((t) => query.scope === "all" || t.scope === query.scope)
        .filter((t) => query.status === "all" || t.archived === (query.status === "archived"))
        .filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle))
        .sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
      const items = matches.slice(query.offset, query.offset + query.limit).map((t) => {
        const { content, ...rest } = view(t);
        return { ...rest, eventName: content.event?.eventName ?? "" };
      });
      return { items, total: matches.length };
    },
    async findById(organizationId, templateId) { const t = own(organizationId, templateId); return t ? view(t) : null; },
    async create(input) {
      const template = { id: String(next++).padStart(24, "0"), ...structuredClone(input), archived: false, archivedAt: null, createdAt: new Date(), updatedAt: new Date() };
      rows.push(template);
      return view(template);
    },
    async rename({ organizationId, templateId, changes }) {
      const t = own(organizationId, templateId);
      if (!t || t.archived) return null;
      Object.assign(t, changes);
      return view(t);
    },
    async publish({ organizationId, templateId, publishedBy, at }) {
      const t = own(organizationId, templateId);
      if (!t || t.archived) return null;
      if (!((t.scope === "personal" && t.ownerUserId === publishedBy) || (t.scope === "organization" && t.publishedAt === null))) return null;
      Object.assign(t, { scope: "organization", publishedAt: at, publishedBy });
      return view(t);
    },
    async unpublish({ organizationId, templateId }) {
      const t = own(organizationId, templateId);
      if (!t || t.scope !== "organization" || t.publishedAt === null) return null;
      Object.assign(t, { publishedAt: null, publishedBy: null });
      return view(t);
    },
    async setArchived({ organizationId, templateId, archived, at }) {
      const t = own(organizationId, templateId);
      if (!t || t.archived === archived) return null;
      Object.assign(t, archived ? { archived: true, archivedAt: at, publishedAt: null, publishedBy: null } : { archived: false, archivedAt: null });
      return view(t);
    },
  };
};

class FakeAccessDenied extends Error {}

const setup = () => {
  const templates = fakeTemplates();
  const audit = [];
  const created = [];
  const sourceReads = [];
  const service = createProposalTemplates({
    templates,
    source: {
      async findViewable(input) {
        sourceReads.push(input);
        if (input.proposalId === HIDDEN_PROPOSAL_ID) throw new FakeAccessDenied("in the organization, not visible");
        return input.proposalId === PROPOSAL_ID ? structuredClone(RFP) : null;
      },
    },
    proposals: { async createFromTemplate(input) { created.push(input); return { _id: "new-rfp", userId: input.ownerUserId }; } },
    audit: { append: async (event) => { audit.push(event); } },
    isValidId: (value) => /^[0-9a-f]{24}$/i.test(value),
    now: () => new Date("2026-11-10T12:00:00Z"),
  });
  return { templates, audit, created, sourceReads, service };
};

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProposalTemplateError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });

const save = (service, role, overrides = {}) => service.saveFromProposal(actor(role), { proposalId: PROPOSAL_ID, title: `${role} template`, ...overrides });

// ── Role policy ──────────────────────────────────────────────────────────────────────────────

test("the role policy: Owner and Admin manage organization templates; RFP creators use templates; Viewers get nothing", () => {
  for (const role of MANAGERS) {
    assert.equal(hasOrganizationAction([role], "template:use"), true, role);
    assert.equal(hasOrganizationAction([role], "template:publish"), true, role);
  }
  for (const role of USERS_ONLY) {
    assert.equal(hasOrganizationAction([role], "template:use"), true, role);
    assert.equal(hasOrganizationAction([role], "template:publish"), false, role);
  }
  for (const role of NO_ACCESS) {
    assert.equal(hasOrganizationAction([role], "template:use"), false, role);
    assert.equal(hasOrganizationAction([role], "template:publish"), false, role);
  }
});

test("the template routes carry the policy: publish and unpublish need template:publish, the rest template:use", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/proposalTemplatesRoute.ts"), "utf8");
  const lines = route.split("\n").filter((line) => line.startsWith("router."));
  assert.equal(lines.length, 9);
  for (const line of lines) {
    assert.match(line, /\/(publish|unpublish)"/.test(line) ? /\.\.\.manage,/ : /\.\.\.use,/, line);
  }
  assert.match(route, /"\/proposal-templates\/:templateId\/proposals", \.\.\.use, authorizeAction\("proposal:write"\), controller\.createProposal/);
  assert.match(route, /const use = \[authenticate, authorizeAction\("template:use"\)\];/);
  assert.match(route, /const manage = \[authenticate, authorizeAction\("template:publish"\)\];/);
  assert.doesNotMatch(route, /requirePublicGrant|optionalAuth/);
});

test("Viewers and knowledge roles can't list, open, save, change or use a template", async () => {
  const { service, created, templates } = setup();
  const published = await save(service, "owner", { scope: "organization" });
  for (const role of NO_ACCESS) {
    await rejects(service.list(actor(role)), "TEMPLATE_USE_DENIED", 403);
    await rejects(service.get(actor(role), published.id), "TEMPLATE_USE_DENIED", 403);
    await rejects(save(service, role), "TEMPLATE_USE_DENIED", 403);
    await rejects(service.update(actor(role), published.id, { title: "Nope" }), "TEMPLATE_USE_DENIED", 403);
    await rejects(service.publish(actor(role), published.id), "TEMPLATE_USE_DENIED", 403);
    await rejects(service.unpublish(actor(role), published.id), "TEMPLATE_USE_DENIED", 403);
    await rejects(service.archive(actor(role), published.id), "TEMPLATE_USE_DENIED", 403);
    await rejects(service.restore(actor(role), published.id), "TEMPLATE_USE_DENIED", 403);
    await rejects(service.createProposal(actor(role), published.id), "TEMPLATE_USE_DENIED", 403);
  }
  assert.equal(created.length, 0);
  assert.equal(templates.rows.length, 1);
});

test("Team Managers, Planners and producers keep personal templates and use published ones, but can't manage organization templates", async () => {
  for (const role of USERS_ONLY) {
    const { service, created } = setup();
    const published = await save(service, "owner", { scope: "organization" });
    const personal = await save(service, role);
    assert.deepEqual([personal.scope, personal.published, personal.ownedByMe, personal.usable], ["personal", false, true, true], role);

    assert.deepEqual((await service.list(actor(role))).items.map((t) => t.title).sort(), ["owner template", `${role} template`].sort());
    assert.equal((await service.get(actor(role), published.id)).title, "owner template");
    await service.createProposal(actor(role), published.id);
    await service.createProposal(actor(role), personal.id);
    assert.deepEqual(created.map((c) => c.ownerUserId), [USERS[role], USERS[role]]);

    await rejects(save(service, role, { scope: "organization" }), "TEMPLATE_PUBLISH_DENIED", 403);
    await rejects(service.publish(actor(role), personal.id), "TEMPLATE_PUBLISH_DENIED", 403);
    await rejects(service.publish(actor(role), published.id), "TEMPLATE_PUBLISH_DENIED", 403);
    await rejects(service.unpublish(actor(role), published.id), "TEMPLATE_PUBLISH_DENIED", 403);
    await rejects(service.archive(actor(role), published.id), "TEMPLATE_PUBLISH_DENIED", 403);
    await rejects(service.update(actor(role), published.id, { title: "Taken over" }), "TEMPLATE_PUBLISH_DENIED", 403);
    assert.equal((await service.get(actor("owner"), published.id)).title, "owner template");

    // Their own personal template is theirs to rename, archive and restore.
    assert.equal((await service.update(actor(role), personal.id, { title: "Renamed", description: "Mine" })).title, "Renamed");
    assert.equal((await service.archive(actor(role), personal.id)).archived, true);
    await rejects(service.createProposal(actor(role), personal.id), "TEMPLATE_ARCHIVED", 409);
    assert.equal((await service.restore(actor(role), personal.id)).archived, false);
  }
});

test("Owners and Admins publish, unpublish, archive and restore organization templates, each other's included", async () => {
  for (const [role, other] of [["owner", "organization_admin"], ["organization_admin", "owner"]]) {
    const { service, audit } = setup();
    const personal = await save(service, role);
    const published = await service.publish(actor(role), personal.id);
    assert.deepEqual([published.scope, published.published, published.publishedBy, published.usable], ["organization", true, USERS[role], true]);
    assert.deepEqual(published.publishedAt, new Date("2026-11-10T12:00:00Z"));
    // Idempotent: publishing again changes and records nothing.
    assert.equal((await service.publish(actor(other), personal.id)).publishedBy, USERS[role]);

    const unpublished = await service.unpublish(actor(other), personal.id);
    assert.deepEqual([unpublished.scope, unpublished.published, unpublished.publishedBy, unpublished.usable], ["organization", false, null, false]);
    await rejects(service.createProposal(actor(other), personal.id), "TEMPLATE_NOT_PUBLISHED", 409);
    assert.equal((await service.unpublish(actor(role), personal.id)).published, false);

    assert.equal((await service.publish(actor(other), personal.id)).publishedBy, USERS[other]);
    const archived = await service.archive(actor(role), personal.id);
    // Archiving unpublishes, so a restore never silently puts it back in the picker.
    assert.deepEqual([archived.archived, archived.published, archived.usable], [true, false, false]);
    await rejects(service.publish(actor(role), personal.id), "TEMPLATE_ARCHIVED", 409);
    await rejects(service.update(actor(role), personal.id, { title: "Nope" }), "TEMPLATE_ARCHIVED", 409);
    await rejects(service.createProposal(actor(role), personal.id), "TEMPLATE_ARCHIVED", 409);
    assert.equal((await service.archive(actor(other), personal.id)).archived, true);
    const restored = await service.restore(actor(other), personal.id);
    assert.deepEqual([restored.archived, restored.published], [false, false]);

    assert.deepEqual(audit.map((e) => [e.action, e.actorUserId, e.decision]), [
      ["proposal_template.created", USERS[role], "created"],
      ["proposal_template.published", USERS[role], "allowed"],
      ["proposal_template.unpublished", USERS[other], "revoked"],
      ["proposal_template.published", USERS[other], "allowed"],
      ["proposal_template.archived", USERS[role], "revoked"],
      ["proposal_template.restored", USERS[other], "allowed"],
    ]);
    for (const event of audit) {
      assert.deepEqual([event.organizationId, event.targetType, event.targetId, event.correlationId], [ORG, "proposal_template", personal.id, "c1"]);
    }
    assert.equal(audit[1].metadata.previousScope, "personal");
    assert.equal(audit[4].metadata.wasPublished, true);
  }
});

test("saving straight to the organization publishes at once and records both events", async () => {
  const { service, audit } = setup();
  const template = await save(service, "organization_admin", { scope: "organization", description: "  Our standard  ", presentationLayout: "template-two" });
  assert.deepEqual(
    [template.scope, template.published, template.publishedBy, template.description, template.presentationLayout, template.eventName],
    ["organization", true, USERS.organization_admin, "Our standard", "template-two", "Annual Sales Kickoff"],
  );
  assert.deepEqual(audit.map((e) => e.action), ["proposal_template.created", "proposal_template.published"]);
  assert.equal(audit[0].metadata.sourceProposalId, PROPOSAL_ID);
});

// ── Personal templates ───────────────────────────────────────────────────────────────────────

test("a personal template is visible to its owner only, whatever the other member's role", async () => {
  const { service, created } = setup();
  const mine = await save(service, "planner");
  for (const role of [...MANAGERS, "team_manager", "dxg_producer"]) {
    assert.deepEqual((await service.list(actor(role), { scope: "all", status: "all" })).items, [], role);
    await rejects(service.get(actor(role), mine.id), "TEMPLATE_ACCESS_DENIED", 403);
    await rejects(service.update(actor(role), mine.id, { title: "Seen" }), "TEMPLATE_ACCESS_DENIED", 403);
    await rejects(service.archive(actor(role), mine.id), "TEMPLATE_ACCESS_DENIED", 403);
    await rejects(service.restore(actor(role), mine.id), "TEMPLATE_ACCESS_DENIED", 403);
    await rejects(service.createProposal(actor(role), mine.id), "TEMPLATE_ACCESS_DENIED", 403);
    if (MANAGERS.includes(role)) {
      await rejects(service.publish(actor(role), mine.id), "TEMPLATE_ACCESS_DENIED", 403);
      await rejects(service.unpublish(actor(role), mine.id), "TEMPLATE_ACCESS_DENIED", 403);
    }
  }
  // Another planner with the same role is refused too.
  await rejects(service.get(actor("planner", { userId: "c".repeat(24) }), mine.id), "TEMPLATE_ACCESS_DENIED", 403);
  assert.equal(created.length, 0);
  assert.equal((await service.get(actor("planner"), mine.id)).scope, "personal");
});

test("unpublished and archived organization templates are seen by Owners and Admins only", async () => {
  const { service } = setup();
  const draft = await save(service, "owner", { scope: "organization", title: "Draft standard" });
  await service.unpublish(actor("owner"), draft.id);
  const retired = await save(service, "owner", { scope: "organization", title: "Retired standard" });
  await service.archive(actor("owner"), retired.id);
  const live = await save(service, "owner", { scope: "organization", title: "Live standard" });

  for (const role of USERS_ONLY) {
    assert.deepEqual((await service.list(actor(role), { status: "all" })).items.map((t) => t.title), ["Live standard"], role);
    for (const hidden of [draft.id, retired.id]) {
      await rejects(service.get(actor(role), hidden), "TEMPLATE_ACCESS_DENIED", 403);
      await rejects(service.createProposal(actor(role), hidden), "TEMPLATE_ACCESS_DENIED", 403);
    }
  }
  assert.deepEqual((await service.list(actor("organization_admin"), { status: "all" })).items.map((t) => [t.title, t.published, t.archived]), [
    ["Draft standard", false, false], ["Live standard", true, false], ["Retired standard", false, true],
  ]);
  assert.deepEqual((await service.list(actor("organization_admin"))).items.map((t) => t.title), ["Draft standard", "Live standard"]);
  assert.equal(live.usable, true);
});

// ── Tenant boundary ──────────────────────────────────────────────────────────────────────────

test("another organization's template is not found, whatever the role or the operation", async () => {
  const { service, created, audit } = setup();
  const template = await save(service, "owner", { scope: "organization" });
  const before = audit.length;
  for (const role of [...MANAGERS, ...USERS_ONLY]) {
    const foreign = actor(role, { organizationId: OTHER_ORG });
    assert.deepEqual(await service.list(foreign, { status: "all" }), { items: [], total: 0, limit: 50, offset: 0 });
    await rejects(service.get(foreign, template.id), "TEMPLATE_NOT_FOUND", 404);
    await rejects(service.update(foreign, template.id, { title: "Taken over" }), "TEMPLATE_NOT_FOUND", 404);
    await rejects(service.archive(foreign, template.id), "TEMPLATE_NOT_FOUND", 404);
    await rejects(service.restore(foreign, template.id), "TEMPLATE_NOT_FOUND", 404);
    await rejects(service.createProposal(foreign, template.id), "TEMPLATE_NOT_FOUND", 404);
    if (MANAGERS.includes(role)) {
      await rejects(service.publish(foreign, template.id), "TEMPLATE_NOT_FOUND", 404);
      await rejects(service.unpublish(foreign, template.id), "TEMPLATE_NOT_FOUND", 404);
    }
  }
  await rejects(service.get(actor("owner"), "not-an-id"), "TEMPLATE_NOT_FOUND", 404);
  await rejects(service.get(actor("owner"), "0".repeat(24)), "TEMPLATE_NOT_FOUND", 404);
  assert.equal(created.length, 0);
  assert.equal(audit.length, before);
  assert.equal((await service.get(actor("owner"), template.id)).title, "owner template");
});

test("a template is saved in the actor's organization and owned by the actor; the body can't name either", async () => {
  const { service, templates, sourceReads } = setup();
  const template = await service.saveFromProposal(actor("planner"), {
    proposalId: PROPOSAL_ID, title: "Forged", organizationId: OTHER_ORG, ownerUserId: USERS.owner, publishedBy: USERS.owner, publishedAt: "2020-01-01", archived: true,
    content: { event: { eventName: "Injected" }, contact: { contactEmail: "x@y.example" } },
  });
  const row = templates.rows[0];
  assert.deepEqual([row.organizationId, row.ownerUserId, row.scope, row.publishedBy, row.publishedAt, row.archived], [ORG, USERS.planner, "personal", null, null, false]);
  assert.equal(template.content.event.eventName, "Annual Sales Kickoff");
  // The RFP is read as the acting member, so the RFP access policy decides what can be saved.
  assert.deepEqual(sourceReads, [{ proposalId: PROPOSAL_ID, userId: USERS.planner }]);
});

test("an RFP the member can't see can't be saved as a template", async () => {
  const { service, templates } = setup();
  // Missing, or in another organization: indistinguishable.
  await rejects(save(service, "planner", { proposalId: "b".repeat(24) }), "TEMPLATE_SOURCE_NOT_FOUND", 404);
  await rejects(save(service, "planner", { proposalId: "nope" }), "INVALID_TEMPLATE_SOURCE", 400);
  await rejects(save(service, "planner", { proposalId: undefined }), "INVALID_TEMPLATE_SOURCE", 400);
  // In the organization but out of the member's reach: the access policy's own error passes through.
  await assert.rejects(save(service, "planner", { proposalId: HIDDEN_PROPOSAL_ID }), FakeAccessDenied);
  assert.equal(templates.rows.length, 0);
});

// ── Snapshot ─────────────────────────────────────────────────────────────────────────────────

test("a snapshot keeps content sections and drops vendors, responses, dates, files, contacts and system fields", () => {
  const content = templateContentOf(RFP);
  assert.deepEqual(Object.keys(content).sort(), ["budget", "contentCreative", "event", "hybridVirtual", "production", "roomByRoom", "venue", "venueSchedule"]);
  assert.deepEqual(content.event, { eventName: "Annual Sales Kickoff", attendees: "800", eventFormat: "Hybrid", eventObjectives: "Launch the new line", statementOfWork: "Full production" });
  assert.deepEqual(content.venueSchedule, { venueName: "Grand Hall", timeZone: "America/Chicago" });
  assert.deepEqual(content.roomByRoom, [{ roomFunction: "General session", wirelessMicsQty: "6", functions: [{ name: "Keynote" }] }]);
  assert.deepEqual(content.venue, { riggingRequired: "YES", inHouseAvRequired: "YES" });
  assert.deepEqual(content.contentCreative, { brandGuideUrl: "https://brand.example" });
  assert.deepEqual(content.budget, { estimatedAvBudget: "$100k-$250k", evaluationMatrix: { price: 40, experience: 60 }, vendorPresentationOpportunity: "YES" });
  const text = JSON.stringify(content);
  assert.doesNotMatch(text, /2026-0|08:00|22:00|Responses due|s3:\/\/|vendor\.example|venue\.example|customer\.example|Snap Co|House AV|Sam Venue|555 01|cand-1|vendors_invited|vendorResponseFormat|retired/);
  for (const dropped of ["contact", "uploads", "lifecycle", "proposalSettings", "status", "userId", "teamId", "organizationId", "_id", "candidateApplicationIds", "videoRecordingStep", "viewsCount", "isFavorite", "createdAt"]) {
    assert.equal(dropped in content, false, dropped);
  }
  // The source is not modified.
  assert.equal(RFP.event.startDate, "2026-03-02");
});

test("the snapshot rules: date, time, contact, file and co-vendor keys are excluded at any depth", () => {
  for (const key of ["startDate", "endDate", "scheduleDate", "loadInDateTime", "showEndDateTime", "dateOfEvent", "decisionDate", "vendorSelectionDate", "strikeTime", "loadInTime", "editionYear", "rfpTimeline", "venueAvContactEmail", "contactPhone", "contactName", "brandGuideFiles", "avQuoteFile", "venueDocs", "supportDocuments", "coVendors", "coVendor", "inHouseAvCompanyName", "$where", "a.b"]) {
    assert.equal(isExcludedTemplateKey(key), true, key);
  }
  for (const key of ["inHouseAvRequired", "eventName", "timeZone", "roomFunction", "unionLabor", "candidates", "updates", "turnaround", "brandGuideUrl", "estimatedAvBudget", "vendorPresentationOpportunity"]) {
    assert.equal(isExcludedTemplateKey(key), false, key);
  }
  const nested = templateContentOf({ event: { eventName: "E", a: { b: [{ c: { startDate: "2026-01-01", keep: 1, when: new Date(), id: new (class ObjectId {})(), run: () => 1, n: Number.NaN } }] } }, budget: null, venue: "text", extra: { x: 1 } });
  assert.deepEqual(nested, { event: { eventName: "E", a: { b: [{ c: { keep: 1 } }] } }, venue: "text" });
  assert.deepEqual(templateContentOf(null), {});
  assert.deepEqual(templateContentOf([1, 2]), {});
});

test("a saved template stores only the snapshot, and an oversized RFP is refused", async () => {
  const { service, templates } = setup();
  const template = await save(service, "planner");
  assert.deepEqual(template.content, templateContentOf(RFP));
  assert.deepEqual(templates.rows[0].content, templateContentOf(RFP));

  const big = createProposalTemplates({
    templates,
    source: { findViewable: async () => ({ event: { eventName: "Big", eventObjectives: "x".repeat(MAX_TEMPLATE_CONTENT_BYTES) } }) },
    proposals: { createFromTemplate: async () => ({}) },
    audit: { append: async () => {} },
    isValidId: () => true,
  });
  await rejects(big.saveFromProposal(actor("planner"), { proposalId: PROPOSAL_ID, title: "Big" }), "TEMPLATE_TOO_LARGE", 413);
  assert.equal(templates.rows.length, 1);
});

// ── Validation ───────────────────────────────────────────────────────────────────────────────

test("title, description, scope, layout and list parameters are validated", async () => {
  const { service } = setup();
  await rejects(save(service, "planner", { title: "   " }), "INVALID_TEMPLATE_TITLE", 400);
  await rejects(save(service, "planner", { title: "x".repeat(121) }), "INVALID_TEMPLATE_TITLE", 400);
  await rejects(save(service, "planner", { title: 7 }), "INVALID_TEMPLATE_TITLE", 400);
  await rejects(save(service, "planner", { description: "x".repeat(501) }), "INVALID_TEMPLATE_DESCRIPTION", 400);
  await rejects(save(service, "planner", { description: 7 }), "INVALID_TEMPLATE_DESCRIPTION", 400);
  await rejects(save(service, "planner", { scope: "everyone" }), "INVALID_TEMPLATE_SCOPE", 400);
  await rejects(save(service, "planner", { scope: ["organization"] }), "INVALID_TEMPLATE_SCOPE", 400);
  await rejects(save(service, "planner", { presentationLayout: "template-three" }), "INVALID_TEMPLATE_LAYOUT", 400);
  await rejects(service.list(actor("planner"), { scope: "team" }), "INVALID_TEMPLATE_SCOPE", 400);
  await rejects(service.list(actor("planner"), { status: ["active", "all"] }), "INVALID_TEMPLATE_STATUS", 400);

  const template = await save(service, "planner", { title: "  Gala   standard ", presentationLayout: "" });
  assert.deepEqual([template.title, template.presentationLayout, template.description], ["Gala standard", null, ""]);
  await rejects(service.update(actor("planner"), template.id, { title: "" }), "INVALID_TEMPLATE_TITLE", 400);
  await rejects(service.createProposal(actor("planner"), template.id, { eventName: 5 }), "INVALID_TEMPLATE_EVENT_NAME", 400);
  await rejects(service.createProposal(actor("planner"), template.id, { eventName: "x".repeat(201) }), "INVALID_TEMPLATE_EVENT_NAME", 400);
  const page = await service.list(actor("planner"), { limit: "500", offset: "abc", search: "GALA" });
  assert.deepEqual([page.total, page.limit, page.offset], [1, 200, 0]);
});

test("an update that changes nothing writes and records nothing", async () => {
  const { service, audit } = setup();
  const template = await save(service, "planner", { title: "Same" });
  const before = audit.length;
  assert.equal((await service.update(actor("planner"), template.id, { title: " Same ", description: "" })).title, "Same");
  assert.equal(audit.length, before);
  await service.update(actor("planner"), template.id, { title: "Different" });
  assert.deepEqual([audit.at(-1).action, audit.at(-1).metadata.changed, audit.at(-1).metadata.previousTitle], ["proposal_template.updated", ["title"], "Same"]);
});

// ── Creating an RFP from a template ──────────────────────────────────────────────────────────

test("starting an RFP hands the proposals module the scrubbed snapshot, the layout and the creator only", async () => {
  const { service, created, templates } = setup();
  const template = await save(service, "owner", { scope: "organization", presentationLayout: "template-one" });
  // A row written before a rule existed (or tampered with) is scrubbed again on use.
  templates.rows[0].content.event.startDate = "2026-09-09";
  templates.rows[0].content.contact = { contactEmail: "old@customer.example" };
  templates.rows[0].content.uploads = { coVendors: { photographer: { companyName: "Snap Co" } } };

  const result = await service.createProposal(actor("planner"), template.id, { eventName: "  Spring   Gala ", userId: USERS.owner, teamId: "x", organizationId: OTHER_ORG, status: "submitted" });
  // The layout comes back beside the RFP: the RFP record has no field for it.
  assert.deepEqual(result, { proposal: { _id: "new-rfp", userId: USERS.planner }, presentationLayout: "template-one" });
  assert.deepEqual(created, [{
    ownerUserId: USERS.planner,
    content: templateContentOf(RFP),
    overrides: { eventName: "Spring Gala" },
    fallbackEventName: "owner template",
  }]);
  await service.createProposal(actor("planner"), template.id);
  assert.deepEqual(created[1].overrides, {});
});

const authorSetup = (overrides = {}) => {
  const inserted = [];
  const lifecycle = [];
  const synchronized = [];
  const create = createCreateProposalFromTemplate({
    proposals: {
      async createOwned(input) {
        if (overrides.createOwned) return overrides.createOwned(input);
        inserted.push(input);
        return { _id: "rfp-1", ...input.proposal, userId: input.ownerUserId };
      },
    },
    settings: { findByUserId: async () => null },
    references: { synchronize: async (input) => { synchronized.push(input); } },
    teams: { defaultTeamFor: async (userId) => overrides.teamFor?.(userId) ?? null, isAssignable: async () => false },
    lifecycle: { recordChange: async (input) => { lifecycle.push(input); } },
  });
  return { create, inserted, lifecycle, synchronized };
};

test("an RFP created from a template is owned by its creator, lands on their team, and is a fresh draft", async () => {
  const teamAsked = [];
  const { create, inserted, lifecycle, synchronized } = authorSetup({ teamFor: (userId) => { teamAsked.push(userId); return "team-of-creator"; } });
  const content = {
    ...templateContentOf(RFP),
    // None of these can come out of a snapshot; they are refused here as well.
    userId: USERS.owner, teamId: "someone-elses-team", organizationId: OTHER_ORG, _id: "x", lifecycle: { stage: "awarded" },
    proposalSetting: {}, videoRecordingStep: { retired: true }, createdAt: "2020-01-01",
  };
  await create({ ownerUserId: USERS.planner, content, overrides: {}, fallbackEventName: "Fallback" });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].ownerUserId, USERS.planner);
  const proposal = inserted[0].proposal;
  assert.deepEqual(teamAsked, [USERS.planner]);
  assert.equal(proposal.teamId, "team-of-creator");
  assert.deepEqual(
    [proposal.status, proposal.isDraft, proposal.isCopy, proposal.isArchived, proposal.isFavorite, proposal.isAccepted, proposal.viewsCount],
    ["unsubmitted", true, false, false, false, false, 0],
  );
  for (const refused of ["userId", "organizationId", "_id", "lifecycle", "proposalSetting", "videoRecordingStep", "createdAt"]) assert.equal(refused in proposal, false, refused);
  assert.equal(proposal.event.eventName, "Annual Sales Kickoff");
  assert.deepEqual(proposal.roomByRoom, templateContentOf(RFP).roomByRoom);
  assert.deepEqual(lifecycle, [{ proposalId: "rfp-1", actorUserId: USERS.planner, reason: "created" }]);
  assert.equal(synchronized.length, 1);
});

test("the event name comes from the override, then the template, then the template's title", async () => {
  const { create, inserted } = authorSetup();
  const base = { ownerUserId: USERS.planner, fallbackEventName: "Template title" };
  await create({ ...base, content: { event: { eventName: "From template", attendees: "5" } }, overrides: { eventName: "Override" } });
  await create({ ...base, content: { event: { eventName: "From template" } }, overrides: {} });
  await create({ ...base, content: { event: { eventName: "  " } }, overrides: {} });
  await create({ ...base, content: {}, overrides: {} });
  assert.deepEqual(inserted.map((i) => i.proposal.event.eventName), ["Override", "From template", "Template title", "Template title"]);
  assert.equal(inserted[0].proposal.event.attendees, "5");
  assert.equal(inserted[0].proposal.teamId, null);
  assert.equal("templateId" in inserted[0].proposal, false);
});

test("a plan refusal from the create path reaches the caller and records nothing", async () => {
  const { create, lifecycle, synchronized } = authorSetup({ createOwned: async () => { throw new PlanLimitReachedError("free_trial", 2, 2); } });
  await assert.rejects(
    create({ ownerUserId: USERS.planner, content: { event: { eventName: "E" } }, overrides: {}, fallbackEventName: "T" }),
    (error) => error instanceof PlanLimitReachedError && error.code === "PLAN_LIMIT_REACHED",
  );
  assert.deepEqual([lifecycle.length, synchronized.length], [0, 0]);

  // Through the template service the same error passes straight to the controller.
  const { templates } = setup();
  const service = createProposalTemplates({
    templates,
    source: { findViewable: async () => structuredClone(RFP) },
    proposals: { createFromTemplate: async () => { throw new PlanLimitReachedError("free_trial", 2, 2); } },
    audit: { append: async () => {} },
    isValidId: (value) => /^[0-9a-f]{24}$/i.test(value),
  });
  const template = await service.saveFromProposal(actor("planner"), { proposalId: PROPOSAL_ID, title: "T" });
  await assert.rejects(service.createProposal(actor("planner"), template.id), PlanLimitReachedError);
});

test("template copy says RFP, never proposal", () => {
  const files = ["src/modules/proposalTemplates/application/manageProposalTemplates.ts", "controller/proposalTemplatesController.ts"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const messages = [...source.matchAll(/"([A-Z][^"\n]*[.!?]|Validation failed)"/g)].map((match) => match[1]);
    assert.ok(messages.length > 0, file);
    for (const message of messages) assert.doesNotMatch(message, /proposal/i, `${file}: ${message}`);
  }
});

test("a change that loses a race answers with the stored state and records nothing", async () => {
  const { service, templates, audit } = setup();
  const template = await save(service, "owner", { scope: "organization" });
  await service.unpublish(actor("owner"), template.id);
  const before = audit.length;
  const real = { publish: templates.publish, unpublish: templates.unpublish, setArchived: templates.setArchived, rename: templates.rename };
  // Each write applies the other request's change first, then reports that it matched nothing.
  templates.publish = async (input) => { await real.publish(input); return null; };
  assert.equal((await service.publish(actor("organization_admin"), template.id)).published, true);
  templates.unpublish = async (input) => { await real.unpublish(input); return null; };
  assert.equal((await service.unpublish(actor("organization_admin"), template.id)).published, false);
  templates.rename = async (input) => { await real.setArchived({ ...input, archived: true, at: new Date() }); return null; };
  await rejects(service.update(actor("organization_admin"), template.id, { title: "Late" }), "TEMPLATE_ARCHIVED", 409);
  await real.setArchived({ organizationId: ORG, templateId: template.id, archived: false, at: new Date() });
  templates.publish = async (input) => { await real.setArchived({ ...input, archived: true, at: new Date() }); return null; };
  await rejects(service.publish(actor("organization_admin"), template.id), "TEMPLATE_ARCHIVED", 409);
  templates.setArchived = async (input) => { await real.setArchived(input); return null; };
  assert.equal((await service.restore(actor("organization_admin"), template.id)).archived, false);
  assert.equal((await service.archive(actor("organization_admin"), template.id)).archived, true);
  assert.equal(audit.length, before);
});

test("the source RFP refusal on a template route is worded for RFPs", () => {
  const controller = fs.readFileSync(path.join(__dirname, "../controller/proposalTemplatesController.ts"), "utf8");
  assert.match(controller, /isProposalAccessDenied\(error\)/);
  assert.match(controller, /message: "You don't have access to this RFP\."/);
  assert.doesNotMatch(controller, /respondIfProposalAccessDenied/);
});
