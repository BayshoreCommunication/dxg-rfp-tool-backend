require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createOrganizationVendorList } = require("../src/modules/organizationVendors/application/manageOrganizationVendors");
const { OrganizationVendorError } = require("../src/modules/organizationVendors/domain");
const { hasOrganizationAction } = require("../src/modules/identity/domain/authorizationPolicy");

const ORG = "a".repeat(24);
const OTHER_ORG = "9".repeat(24);
const actor = (role, organizationId = ORG) => ({ organizationId, userId: "b".repeat(24), roles: [role], correlationId: "c1" });
const EDITORS = ["owner", "organization_admin", "team_manager"];
const READ_ONLY = ["planner", "dxg_producer"];
const NO_ACCESS = ["viewer", "knowledge_editor", "knowledge_approver"];

// In-memory repository with the same contract as the Mongo one: organization-scoped lookups,
// case-insensitive active-company uniqueness, search over company and category.
const fakeVendors = () => {
  const rows = [];
  let next = 1;
  const view = ({ organizationId: _o, ...vendor }) => ({ ...vendor, contacts: vendor.contacts.map((c) => ({ ...c })) });
  const taken = (organizationId, company, exceptId) =>
    rows.some((v) => v.organizationId === organizationId && !v.archived && v.id !== exceptId && v.company.toLowerCase() === company.toLowerCase());
  const own = (organizationId, vendorId) => rows.find((v) => v.id === vendorId && v.organizationId === organizationId);
  return {
    rows,
    async list(organizationId, query) {
      const needle = query.search.toLowerCase();
      const matches = rows
        .filter((v) => v.organizationId === organizationId)
        .filter((v) => query.status === "all" || v.archived === (query.status === "archived"))
        .filter((v) => !query.category || v.category.toLowerCase() === query.category.toLowerCase())
        .filter((v) => !needle || v.company.toLowerCase().includes(needle) || v.category.toLowerCase().includes(needle))
        .sort((a, b) => a.company.localeCompare(b.company, "en", { sensitivity: "base" }));
      return { items: matches.slice(query.offset, query.offset + query.limit).map(view), total: matches.length };
    },
    async categories(organizationId) {
      return [...new Set(rows.filter((v) => v.organizationId === organizationId && !v.archived && v.category).map((v) => v.category))].sort();
    },
    async findById(organizationId, vendorId) { const v = own(organizationId, vendorId); return v ? view(v) : null; },
    async create({ organizationId, company, category, contacts, addedBy }) {
      if (taken(organizationId, company)) return "duplicate";
      const vendor = { id: String(next++).padStart(24, "0"), organizationId, company, category, contacts, addedBy, archived: false, archivedAt: null, createdAt: new Date(), updatedAt: new Date() };
      rows.push(vendor);
      return view(vendor);
    },
    async update({ organizationId, vendorId, changes }) {
      const v = own(organizationId, vendorId);
      if (!v || v.archived) return null;
      if (changes.company && taken(organizationId, changes.company, vendorId)) return "duplicate";
      Object.assign(v, changes, { updatedAt: new Date() });
      return view(v);
    },
    async setArchived({ organizationId, vendorId, archived, at }) {
      const v = own(organizationId, vendorId);
      if (!v || v.archived === archived) return null;
      if (!archived && taken(organizationId, v.company, vendorId)) return "duplicate";
      Object.assign(v, { archived, archivedAt: archived ? at : null });
      return view(v);
    },
  };
};

const setup = () => {
  const vendors = fakeVendors();
  const audit = [];
  const service = createOrganizationVendorList({
    vendors,
    audit: { append: async (event) => { audit.push(event); } },
    isValidId: (value) => /^[0-9a-f]{24}$/i.test(value),
    now: () => new Date("2026-11-10T06:00:00Z"),
  });
  return { vendors, audit, service };
};

const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof OrganizationVendorError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });

const ACME = { company: "Acme Audio", category: "Audio", contacts: [{ name: "Dana Reyes", email: "Dana@Acme.example" }] };

test("the role policy: Owner, Admin and Team Manager edit; RFP creators read; Viewers get nothing", () => {
  for (const role of EDITORS) {
    assert.equal(hasOrganizationAction([role], "vendor-list:read"), true, role);
    assert.equal(hasOrganizationAction([role], "vendor-list:write"), true, role);
  }
  for (const role of READ_ONLY) {
    assert.equal(hasOrganizationAction([role], "vendor-list:read"), true, role);
    assert.equal(hasOrganizationAction([role], "vendor-list:write"), false, role);
  }
  for (const role of NO_ACCESS) {
    assert.equal(hasOrganizationAction([role], "vendor-list:read"), false, role);
    assert.equal(hasOrganizationAction([role], "vendor-list:write"), false, role);
  }
});

test("each editing role can add, edit, archive and restore a vendor", async () => {
  for (const role of EDITORS) {
    const { service } = setup();
    const created = await service.create(actor(role), ACME);
    assert.deepEqual(created.contacts, [{ name: "Dana Reyes", email: "dana@acme.example" }], role);
    assert.equal(created.addedBy, "b".repeat(24));
    assert.equal((await service.update(actor(role), created.id, { category: "Audio and video" })).category, "Audio and video");
    assert.equal((await service.archive(actor(role), created.id)).archived, true);
    assert.equal((await service.restore(actor(role), created.id)).archived, false);
  }
});

test("read-only roles can list, search and open vendors but every change is refused", async () => {
  const { service } = setup();
  const created = await service.create(actor("owner"), ACME);
  for (const role of READ_ONLY) {
    assert.equal((await service.list(actor(role))).total, 1, role);
    assert.equal((await service.get(actor(role), created.id)).company, "Acme Audio");
    assert.deepEqual(await service.categories(actor(role)), ["Audio"]);
    await rejects(service.create(actor(role), { company: "Nope" }), "VENDOR_LIST_EDIT_DENIED", 403);
    await rejects(service.update(actor(role), created.id, { company: "Nope" }), "VENDOR_LIST_EDIT_DENIED", 403);
    await rejects(service.archive(actor(role), created.id), "VENDOR_LIST_EDIT_DENIED", 403);
    await rejects(service.restore(actor(role), created.id), "VENDOR_LIST_EDIT_DENIED", 403);
  }
});

test("Viewers and knowledge roles can neither read nor change the list", async () => {
  const { service } = setup();
  const created = await service.create(actor("owner"), ACME);
  for (const role of NO_ACCESS) {
    await rejects(service.list(actor(role)), "VENDOR_LIST_ACCESS_DENIED", 403);
    await rejects(service.categories(actor(role)), "VENDOR_LIST_ACCESS_DENIED", 403);
    await rejects(service.get(actor(role), created.id), "VENDOR_LIST_ACCESS_DENIED", 403);
    await rejects(service.create(actor(role), ACME), "VENDOR_LIST_EDIT_DENIED", 403);
    await rejects(service.archive(actor(role), created.id), "VENDOR_LIST_EDIT_DENIED", 403);
  }
});

test("another organization's vendor is not found, whatever the role or the operation", async () => {
  const { service, vendors } = setup();
  const created = await service.create(actor("owner"), ACME);
  const foreigner = actor("owner", OTHER_ORG);
  await rejects(service.get(foreigner, created.id), "VENDOR_NOT_FOUND", 404);
  await rejects(service.update(foreigner, created.id, { company: "Taken over" }), "VENDOR_NOT_FOUND", 404);
  await rejects(service.archive(foreigner, created.id), "VENDOR_NOT_FOUND", 404);
  await rejects(service.restore(foreigner, created.id), "VENDOR_NOT_FOUND", 404);
  assert.equal((await service.list(foreigner)).total, 0);
  assert.deepEqual(await service.categories(foreigner), []);
  assert.equal(vendors.rows[0].company, "Acme Audio");
  assert.equal(vendors.rows[0].archived, false);
  // The same company name is free in the other organization.
  assert.equal((await service.create(foreigner, ACME)).company, "Acme Audio");
  await rejects(service.get(actor("owner"), "not-an-id"), "VENDOR_NOT_FOUND", 404);
});

test("search matches company or category, the category filter is exact, and archived vendors leave the default list", async () => {
  const { service } = setup();
  const owner = actor("owner");
  await service.create(owner, ACME);
  await service.create(owner, { company: "Bright Lights", category: "Lighting" });
  const stage = await service.create(owner, { company: "Stagecraft", category: "Audio" });
  await service.create(owner, { company: "No Category Co" });
  const companies = async (query) => (await service.list(actor("planner"), query)).items.map((v) => v.company);

  assert.deepEqual(await companies({}), ["Acme Audio", "Bright Lights", "No Category Co", "Stagecraft"]);
  assert.deepEqual(await companies({ search: "LIGHT" }), ["Bright Lights"]);
  assert.deepEqual(await companies({ search: "audio" }), ["Acme Audio", "Stagecraft"]);
  assert.deepEqual(await companies({ category: "audio" }), ["Acme Audio", "Stagecraft"]);
  assert.deepEqual(await companies({ category: "aud" }), []);
  assert.deepEqual(await companies({ search: "stage", category: "Audio" }), ["Stagecraft"]);

  await service.archive(owner, stage.id);
  assert.deepEqual(await companies({ category: "Audio" }), ["Acme Audio"]);
  assert.deepEqual(await companies({ status: "archived" }), ["Stagecraft"]);
  assert.equal((await service.list(owner, { status: "all" })).total, 4);
  assert.deepEqual(await service.categories(owner), ["Audio", "Lighting"]);

  const page = await service.list(owner, { limit: "2", offset: "1" });
  assert.deepEqual([page.items.map((v) => v.company), page.total, page.limit, page.offset], [["Bright Lights", "No Category Co"], 3, 2, 1]);
  assert.equal((await service.list(owner, { limit: "100000" })).limit, 200);
  assert.equal((await service.list(owner, { limit: "abc", offset: "-4" })).limit, 50);
  await rejects(service.list(owner, { status: "deleted" }), "INVALID_VENDOR_STATUS", 400);
  await rejects(service.list(owner, { status: ["archived", "all"] }), "INVALID_VENDOR_STATUS", 400);
});

test("input is validated: company, category and contacts", async () => {
  const { service } = setup();
  const owner = actor("owner");
  await rejects(service.create(owner, {}), "INVALID_VENDOR_COMPANY", 400);
  await rejects(service.create(owner, { company: "   " }), "INVALID_VENDOR_COMPANY", 400);
  await rejects(service.create(owner, { company: "x".repeat(201) }), "INVALID_VENDOR_COMPANY", 400);
  await rejects(service.create(owner, { company: "Ok", category: "x".repeat(81) }), "INVALID_VENDOR_CATEGORY", 400);
  await rejects(service.create(owner, { company: "Ok", category: 7 }), "INVALID_VENDOR_CATEGORY", 400);
  await rejects(service.create(owner, { company: "Ok", contacts: "dana@acme.example" }), "INVALID_VENDOR_CONTACTS", 400);
  await rejects(service.create(owner, { company: "Ok", contacts: null }), "INVALID_VENDOR_CONTACTS", 400);
  await rejects(service.create(owner, { company: "Ok", contacts: [{ name: "No email" }] }), "INVALID_VENDOR_CONTACT_EMAIL", 400);
  await rejects(service.create(owner, { company: "Ok", contacts: [{ email: "not-an-email" }] }), "INVALID_VENDOR_CONTACT_EMAIL", 400);
  await rejects(service.create(owner, { company: "Ok", contacts: [{ name: "x".repeat(121), email: "a@b.example" }] }), "INVALID_VENDOR_CONTACTS", 400);
  await rejects(service.create(owner, { company: "Ok", contacts: [{ email: "a@b.example" }, { email: "A@B.example" }] }), "DUPLICATE_VENDOR_CONTACT_EMAIL", 400);
  await rejects(service.create(owner, { company: "Ok", contacts: Array.from({ length: 51 }, (_, i) => ({ email: `p${i}@b.example` })) }), "INVALID_VENDOR_CONTACTS", 400);

  const created = await service.create(owner, { company: "  Acme   Audio ", category: " Audio ", contacts: [{ email: " Solo@Acme.example " }] });
  assert.deepEqual([created.company, created.category, created.contacts], ["Acme Audio", "Audio", [{ name: "", email: "solo@acme.example" }]]);
});

test("active company names are unique per organization, ignoring case; an archived name can be reused", async () => {
  const { service } = setup();
  const owner = actor("owner");
  const first = await service.create(owner, ACME);
  await rejects(service.create(owner, { company: "ACME AUDIO" }), "VENDOR_COMPANY_TAKEN", 409);
  const other = await service.create(owner, { company: "Other" });
  await rejects(service.update(owner, other.id, { company: "acme audio" }), "VENDOR_COMPANY_TAKEN", 409);

  await service.archive(owner, first.id);
  await rejects(service.update(owner, first.id, { category: "Video" }), "VENDOR_ARCHIVED", 409);
  await service.create(owner, { company: "Acme Audio" });
  await rejects(service.restore(owner, first.id), "VENDOR_COMPANY_TAKEN", 409);
});

test("an edit or archive that loses a race with an archive answers with the stored state", async () => {
  const { service, vendors } = setup();
  const owner = actor("owner");
  const created = await service.create(owner, ACME);
  // The vendor is archived between the service's read and its write.
  const findById = vendors.findById.bind(vendors);
  let raced = false;
  vendors.findById = async (organizationId, vendorId) => {
    const found = await findById(organizationId, vendorId);
    if (!raced) { raced = true; await vendors.setArchived({ organizationId, vendorId, archived: true, at: new Date() }); }
    return found;
  };
  await rejects(service.update(owner, created.id, { category: "Video" }), "VENDOR_ARCHIVED", 409);
  assert.equal(vendors.rows[0].category, "Audio");
  raced = false;
  await service.restore(owner, created.id);
  raced = false;
  assert.equal((await service.archive(owner, created.id)).archived, true);
});

test("every edit is audited once, with no contact details in the trail", async () => {
  const { service, audit } = setup();
  const owner = actor("team_manager");
  const created = await service.create(owner, ACME);
  await service.update(owner, created.id, { company: "Acme AV", contacts: [{ name: "Dana Reyes", email: "dana@acme.example" }, { name: "Lee", email: "lee@acme.example" }] });
  await service.update(owner, created.id, { company: "Acme AV", category: "Audio" }); // nothing changed
  await service.archive(owner, created.id);
  await service.archive(owner, created.id); // already archived
  await service.restore(owner, created.id);
  await service.restore(owner, created.id); // already active

  assert.deepEqual(audit.map((e) => [e.action, e.decision]), [
    ["organization_vendor.created", "created"],
    ["organization_vendor.updated", "allowed"],
    ["organization_vendor.archived", "revoked"],
    ["organization_vendor.restored", "allowed"],
  ]);
  for (const event of audit) {
    assert.deepEqual([event.organizationId, event.actorUserId, event.targetType, event.targetId, event.correlationId], [ORG, owner.userId, "organization_vendor", created.id, "c1"]);
    assert.doesNotMatch(JSON.stringify(event.metadata), /acme\.example|Dana|Lee/);
  }
  assert.deepEqual(audit[1].metadata, { changed: ["company", "contacts"], company: "Acme AV", previousCompany: "Acme Audio", contactCount: 2, previousContactCount: 1 });
});

// "Vendors never see it through the submission link": the list has one HTTP surface, every
// route on it requires a signed-in member, and no vendor-portal or public-grant code reads the model.
test("the vendor list is reachable only through member-authenticated routes", () => {
  const root = path.join(__dirname, "..");
  const routeSource = fs.readFileSync(path.join(root, "routes/organizationVendorsRoute.ts"), "utf8");
  const routes = routeSource.split("\n").filter((line) => /^router\.(get|post|patch|put|delete)\(/.test(line));
  assert.equal(routes.length, 7);
  for (const line of routes) assert.match(line, /\.\.\.(read|write),/, line);
  assert.match(routeSource, /const read = \[authenticate, authorizeAction\("vendor-list:read"\)\];/);
  assert.match(routeSource, /const write = \[authenticate, authorizeAction\("vendor-list:write"\)\];/);
  assert.doesNotMatch(routeSource, /requirePublicGrant|optionalAuth/);

  const allowed = new Set([
    "modal/organizationVendorModel.ts",
    "src/modules/organizationVendors/infrastructure/mongoOrganizationVendorRepository.ts",
    "scripts/purgeTestAccounts.ts",
  ]);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return /\.ts$/.test(entry.name) ? [full] : [];
  });
  const users = ["src", "controller", "routes", "middleware", "utils", "modal", "scripts", "config"]
    .flatMap((dir) => (fs.existsSync(path.join(root, dir)) ? walk(path.join(root, dir)) : []))
    .concat(path.join(root, "server.ts"))
    .filter((file) => /organizationVendorModel|organizationvendors/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(users.filter((file) => !allowed.has(file)), []);

  const repositoryUsers = walk(path.join(root, "src")).concat(walk(path.join(root, "controller")), walk(path.join(root, "routes")), walk(path.join(root, "middleware")))
    .filter((file) => /modules\/organizationVendors|organizationVendorsController|mongoOrganizationVendorRepository/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file))
    .filter((file) => !file.startsWith("src/modules/organizationVendors/"));
  assert.deepEqual(repositoryUsers.sort(), ["controller/organizationVendorsController.ts", "routes/organizationVendorsRoute.ts"]);
});
