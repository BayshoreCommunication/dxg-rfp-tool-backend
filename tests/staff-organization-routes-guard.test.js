require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* Owner decision 2026-11-24 (docs/DECISIONS.md): RFPilot staff VIEW a customer organization's
   members and teams and can block and reactivate the whole organization. Staff do not change
   members or teams. So under /api/v1/admin/organizations/:organizationId the only routes that are
   not a GET are POST /block and POST /reactivate.

   This guard finds the routes itself: it reads which routers server.ts mounts, loads each REAL
   route file and walks the router Express built. Adding a staff write route, in any route file,
   under any mount, fails it. It cannot pass with nothing found: the number of routers it loaded
   and the exact list of routes it found are asserted. */

const repoRoot = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Every `app.use("<mount>", <routerName>)` of server.ts, with the route file the name was imported from.
const mountedRouters = () => {
  const server = read("server.ts");
  const imports = new Map([...server.matchAll(/^import\s+(\w+)\s+from\s+"\.\/(routes\/\w+)";$/gm)].map((match) => [match[1], `${match[2]}.ts`]));
  const mounts = [...server.matchAll(/^\s*app\.use\(\s*"([^"]+)"\s*,\s*(\w+)\s*\);/gm)].map((match) => ({ mount: match[1], name: match[2], file: imports.get(match[2]) }));
  return { imports, mounts };
};

// Every route of a router, with the methods Express will answer. A nested router is refused: none
// exists today, and one would hide its routes from this walk.
const routesOf = (router, file) => router.stack.flatMap((layer) => {
  if (layer.route) return [{ path: layer.route.path, methods: Object.keys(layer.route.methods).map((method) => method.toUpperCase()).sort() }];
  assert.equal(typeof layer.handle === "function" && Array.isArray(layer.handle.stack), false, `${file}: a nested router; teach this guard to walk it`);
  return [];
});

// A path about one organization on the staff side, whatever the parameter is called.
const STAFF_ORGANIZATION = /\/admin\/organizations\/:[A-Za-z]+(\/|$)/;

const found = () => {
  const { imports, mounts } = mountedRouters();
  const all = [];
  let loaded = 0;
  for (const { mount, name, file } of mounts) {
    assert.ok(file, `server.ts mounts ${name} at ${mount}, which is not imported from ./routes/`);
    const router = require(path.join(repoRoot, file)).default;
    assert.equal(typeof router, "function", file);
    assert.ok(Array.isArray(router.stack), file);
    loaded += 1;
    for (const route of routesOf(router, file)) {
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const routePath of paths) {
        assert.equal(typeof routePath, "string", `${file}: a route path that is not text (${String(routePath)}); teach this guard to read it`);
        for (const method of route.methods) all.push({ method, path: `${mount}${routePath}`.replace(/\/+/g, "/"), file });
      }
    }
  }
  return { imports, mounts, loaded, all };
};

const EXPECTED = [
  "GET /api/v1/admin/organizations/:organizationId                                         routes/adminOrganizationPlansRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/members                                 routes/adminOrganizationContentRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/members/:userId                         routes/adminOrganizationMembersRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/proposals                               routes/adminOrganizationContentRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/proposals/:proposalId                   routes/adminOrganizationContentRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/proposals/:proposalId/vendor-responses  routes/adminOrganizationContentRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/teams                                   routes/adminOrganizationContentRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/teams/:teamId                           routes/adminOrganizationTeamsRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/templates                               routes/adminOrganizationContentRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/templates/:templateId                   routes/adminOrganizationContentRoute.ts",
  "GET /api/v1/admin/organizations/:organizationId/vendors                                 routes/adminOrganizationContentRoute.ts",
  "POST /api/v1/admin/organizations/:organizationId/block                                  routes/adminOrganizationBlockRoute.ts",
  "POST /api/v1/admin/organizations/:organizationId/reactivate                             routes/adminOrganizationBlockRoute.ts",
].map((line) => line.replace(/\s{2,}/, " "));

// The twelve routes the owner removed on 2026-11-24.
const REMOVED = [
  "PATCH /api/v1/admin/organizations/:organizationId/members/:userId/role",
  "POST /api/v1/admin/organizations/:organizationId/members/:userId/deactivate",
  "POST /api/v1/admin/organizations/:organizationId/members/:userId/reactivate",
  "POST /api/v1/admin/organizations/:organizationId/members/:userId/reassign-rfps",
  "POST /api/v1/admin/organizations/:organizationId/ownership/transfer",
  "PUT /api/v1/admin/organizations/:organizationId/members/:userId/teams",
  "POST /api/v1/admin/organizations/:organizationId/teams",
  "PATCH /api/v1/admin/organizations/:organizationId/teams/:teamId",
  "POST /api/v1/admin/organizations/:organizationId/teams/:teamId/archive",
  "POST /api/v1/admin/organizations/:organizationId/teams/:teamId/members",
  "PATCH /api/v1/admin/organizations/:organizationId/teams/:teamId/members/:userId",
  "DELETE /api/v1/admin/organizations/:organizationId/teams/:teamId/members/:userId",
];

test("under /admin/organizations/:organizationId the only routes that are not a GET are POST /block and POST /reactivate", () => {
  const { imports, mounts, loaded, all } = found();
  // The walk saw the application: every router server.ts imports is mounted, loaded and walked.
  assert.ok(mounts.length >= 50, `only ${mounts.length} routers found in server.ts: the guard no longer reads it`);
  assert.equal(loaded, mounts.length);
  assert.deepEqual([...imports.values()].filter((file) => !mounts.some((mount) => mount.file === file)), [], "a route file imported by server.ts and not mounted where this guard can see it");
  assert.ok(all.length >= 300, `only ${all.length} routes found: the guard no longer walks the routers`);
  // server.ts mounts nothing this guard cannot read: every `app.use("/…", x)` names a router.
  const pathMounts = [...codeOf(read("server.ts")).matchAll(/app\.use\(\s*"(\/[^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(pathMounts.filter((mount) => !mounts.some((entry) => entry.mount === mount)), ["/uploads"], "a path mount that is not a router from ./routes/");

  const staff = all.filter((route) => STAFF_ORGANIZATION.test(route.path));
  const listed = staff.map((route) => `${route.method} ${route.path} ${route.file}`).sort();
  assert.equal(staff.length, 13, `expected the 13 staff organization routes, found ${staff.length}:\n${listed.join("\n")}`);
  assert.deepEqual(listed, [...EXPECTED].sort());
  // The rule itself, stated on what was found and not on the list above.
  const writes = staff.filter((route) => route.method !== "GET").map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(writes, [
    "POST /api/v1/admin/organizations/:organizationId/block",
    "POST /api/v1/admin/organizations/:organizationId/reactivate",
  ]);
  assert.equal(staff.filter((route) => route.method === "GET").length, 11);
  // None of the removed routes is registered, under any mount.
  const everything = new Set(all.map((route) => `${route.method} ${route.path}`));
  assert.equal(REMOVED.length, 12);
  for (const removed of REMOVED) assert.equal(everything.has(removed), false, removed);
  for (const route of all) {
    assert.doesNotMatch(route.path, /\/admin\/.*\/(reassign-rfps|ownership\/transfer)$/, `${route.method} ${route.path}`);
    if (/\/admin\/organizations\//.test(route.path) && route.method !== "GET") assert.match(route.path, /^\/api\/v1\/admin\/organizations\/:organizationId\/(block|reactivate)$/, `${route.method} ${route.path} (${route.file})`);
  }
  // No route answers every method (`router.all`) on a staff organization path.
  for (const route of staff) assert.equal(route.method === "_ALL", false, route.path);
});

test("the guard itself: it reads a write route when there is one, in any file and under any mount", () => {
  const express = require("express");
  const router = express.Router();
  router.get("/admin/organizations/:organizationId/teams/:teamId", () => {});
  router.patch("/admin/organizations/:organizationId/members/:userId/role", () => {});
  router.all("/admin/organizations/:id/anything", () => {});
  const routes = routesOf(router, "a test router");
  assert.deepEqual(routes.map((route) => [route.methods, route.path]), [
    [["GET"], "/admin/organizations/:organizationId/teams/:teamId"],
    [["PATCH"], "/admin/organizations/:organizationId/members/:userId/role"],
    [["_ALL"], "/admin/organizations/:id/anything"],
  ]);
  assert.equal(routes.every((route) => STAFF_ORGANIZATION.test(`/api/admin${route.path}`)), true);
  assert.equal(STAFF_ORGANIZATION.test("/api/v1/admin/organization-plans/:organizationId"), false, "the plan routes are not under /admin/organizations");
  const nested = express.Router();
  nested.use(router);
  assert.throws(() => routesOf(nested, "nested"), /a nested router/);
});

test("the staff write code is gone, not only unrouted: no staff actor, no staff session hook, no staff-side change event, and the staff services only read", () => {
  const walk = (dir) => fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "generated" ? [] : walk(file);
    return /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [file] : [];
  });
  const files = ["server.ts", ...["src", "controller", "routes", "middleware", "utils", "modal", "scripts", "config"].flatMap((dir) => (fs.existsSync(path.join(repoRoot, dir)) ? walk(dir) : []))];
  assert.ok(files.length >= 400, `only ${files.length} source files found`);
  // The capabilities the staff writes were built on. Each let code act in a customer organization
  // without being a member of it; none may come back unnoticed.
  const GONE = /\b(STAFF_MANAGER|isStaffManager|StaffManager|staffTeamActor|isStaffTeamActor|StaffTeamActor|staffMembershipSessions|mongoStaffMemberTeams|StaffMemberTeamsStore|MemberChangeAudit|TeamChangeAudit|appendAudit|revertAudit|bumpVersionInTransaction)\b/;
  // The historical action names are named in the catalog (staffAccess/domain.ts) and nowhere else.
  const HISTORICAL_KEYS = /\bSTAFF_(MEMBER|TEAM)_AUDIT\.(?!read\b)\w+/;
  const HISTORICAL_NAMES = /platform\.organization_(member|team)\.(?!read\b|sessions_revoked\b)[a-z_]+/;
  const CATALOG = "src/modules/staffAccess/domain.ts";
  const problems = [];
  for (const file of files) {
    const code = codeOf(read(file));
    if (GONE.test(code)) problems.push(`${file}: ${code.match(GONE)[0]}`);
    if (HISTORICAL_KEYS.test(code)) problems.push(`${file}: ${code.match(HISTORICAL_KEYS)[0]}`);
    if (file !== CATALOG && HISTORICAL_NAMES.test(code)) problems.push(`${file}: ${code.match(HISTORICAL_NAMES)[0]}`);
  }
  assert.deepEqual(problems, []);
  // The catalog still names every historical action, so the staff audit trail's old rows keep a name.
  const { STAFF_MEMBER_AUDIT, STAFF_TEAM_AUDIT } = require("../src/modules/staffAccess/domain");
  assert.deepEqual(Object.values(STAFF_MEMBER_AUDIT), [
    "platform.organization_member.read", "platform.organization_member.role_changed", "platform.organization_member.deactivated",
    "platform.organization_member.reactivated", "platform.organization_member.proposals_reassigned", "platform.organization_member.ownership_transferred",
  ]);
  assert.deepEqual(Object.values(STAFF_TEAM_AUDIT), [
    "platform.organization_team.read", "platform.organization_team.created", "platform.organization_team.renamed", "platform.organization_team.archived",
    "platform.organization_team.member_added", "platform.organization_team.member_removed", "platform.organization_team.manager_changed", "platform.organization_member.teams_changed",
  ]);
  // The staff module writes to a customer organization in one file only: the block store.
  const WRITE = /\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|replaceOne|findOneAndReplace|bulkWrite|save)\(/;
  const staffFiles = files.filter((file) => file.startsWith("src/modules/staffAccess/"));
  assert.ok(staffFiles.length >= 9, `only ${staffFiles.length} staff module files found`);
  assert.deepEqual(staffFiles.filter((file) => WRITE.test(codeOf(read(file)))), ["src/modules/staffAccess/infrastructure/mongoOrganizationBlockStore.ts"]);
  // ... and reaches the customer's member and team modules from nowhere.
  for (const file of [...staffFiles, "controller/adminOrganizationMembersController.ts", "controller/adminOrganizationTeamsController.ts", "routes/adminOrganizationMembersRoute.ts", "routes/adminOrganizationTeamsRoute.ts"]) {
    assert.doesNotMatch(codeOf(read(file)), /modules\/organizationMembers\/|modules\/teams\/|organizationMembersController|teamsController|auth\/composition/, file);
  }
  // The services behind the two remaining member and team routes have one method each: the read.
  const { staffMemberManagement, staffTeamManagement, staffOrganizationBlock } = require("../src/modules/staffAccess/composition");
  assert.deepEqual([Object.keys(staffMemberManagement), Object.keys(staffTeamManagement)], [["member"], ["team"]]);
  assert.deepEqual(Object.keys(staffOrganizationBlock).sort(), ["block", "reactivate"]);
  const { adminOrganizationMembersController } = require("../controller/adminOrganizationMembersController");
  const { adminOrganizationTeamsController } = require("../controller/adminOrganizationTeamsController");
  assert.deepEqual([Object.keys(adminOrganizationMembersController), Object.keys(adminOrganizationTeamsController)], [["member"], ["team"]]);
});
