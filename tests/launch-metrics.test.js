const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LaunchMetricsError,
  inviteAcceptance,
  isUnderActiveGrant,
  launchMetricsReport,
  median,
  organizationsWithTwoOrMore,
  parseWindowDays,
  supportAccessUnderGrant,
  timeToFirstRfpOpened,
} = require("../src/modules/launchMetrics/domain");
const { createRecordFirstRfpOpened } = require("../src/modules/launchMetrics/firstRfpOpened");
const { createLaunchMetricsController } = require("../controller/launchMetricsController");

// ORG-505: the PRD launch metrics. Definitions are tested here on plain dates; the real queries
// and the HTTP boundary are in tests-integration/launch-metrics.test.ts.

const NOW = new Date("2026-11-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days, plusMs = 0) => new Date(NOW.getTime() - days * DAY + plusMs);

test("invite acceptance counts invitations at least 7 days old that were accepted within 7 days", () => {
  const result = inviteAcceptance([
    { createdAt: ago(20), acceptedAt: ago(19) },                 // within 7 days
    { createdAt: ago(20), acceptedAt: ago(13) },                 // exactly 7 days: counts
    { createdAt: ago(20), acceptedAt: ago(13, 1000) },           // a second late
    { createdAt: ago(10), acceptedAt: null },                    // never accepted (pending, expired or revoked)
    { createdAt: ago(3), acceptedAt: ago(2) },                   // too recent to judge
    { createdAt: ago(1), acceptedAt: null },                     // too recent to judge
  ], NOW);
  assert.deepEqual(result, { sent: 6, atLeast7DaysOld: 4, acceptedWithin7Days: 2, acceptedLater: 1, rate: 0.5, target: 0.6 });
});

test("invite acceptance has no rate until an invitation is 7 days old", () => {
  assert.equal(inviteAcceptance([{ createdAt: ago(2), acceptedAt: ago(1) }], NOW).rate, null);
  assert.equal(inviteAcceptance([], NOW).rate, null);
});

test("time to first RFP opened is the median from acceptance, leaving out members who have not opened one", () => {
  const accepted = ago(5);
  const after = (seconds) => new Date(accepted.getTime() + seconds * 1000);
  const result = timeToFirstRfpOpened([
    { acceptedAt: accepted, firstRfpOpenedAt: after(60) },
    { acceptedAt: accepted, firstRfpOpenedAt: after(300) },
    { acceptedAt: accepted, firstRfpOpenedAt: after(4000) },
    { acceptedAt: accepted, firstRfpOpenedAt: null },
    // Rejoined: the first open belongs to an earlier membership.
    { acceptedAt: accepted, firstRfpOpenedAt: after(-86_400) },
  ]);
  assert.deepEqual(result, {
    accepted: 5, opened: 3, notYetOpened: 1, excludedOpenedBeforeAccepting: 1, excludedAcceptedBeforeTracking: 0,
    medianSeconds: 300, openedWithin5Minutes: 2, targetMedianSeconds: 300,
  });
  assert.equal(timeToFirstRfpOpened([]).medianSeconds, null);
});

test("members who accepted before opens were tracked are left out of the timing", () => {
  const trackingSince = ago(10);
  const result = timeToFirstRfpOpened([
    // Accepted 20 days ago, first recorded open 9 days ago: they may have opened RFPs unrecorded before that.
    { acceptedAt: ago(20), firstRfpOpenedAt: ago(9) },
    { acceptedAt: ago(20), firstRfpOpenedAt: null },
    { acceptedAt: ago(5), firstRfpOpenedAt: ago(5, 30_000) },
    { acceptedAt: ago(4), firstRfpOpenedAt: null },
  ], trackingSince);
  assert.deepEqual(result, {
    accepted: 4, opened: 1, notYetOpened: 1, excludedOpenedBeforeAccepting: 0, excludedAcceptedBeforeTracking: 2,
    medianSeconds: 30, openedWithin5Minutes: 1, targetMedianSeconds: 300,
  });
});

test("median handles even and odd counts", () => {
  assert.equal(median([]), null);
  assert.equal(median([9]), 9);
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([40, 10, 20, 30]), 25);
});

test("organizations with 2+ active users is a share of organizations that have any active member", () => {
  assert.deepEqual(organizationsWithTwoOrMore([1, 1, 2, 5, 0]), { organizations: 4, withTwoOrMoreActiveUsers: 2, rate: 0.5, target: 0.25 });
  assert.equal(organizationsWithTwoOrMore([]).rate, null);
});

test("a support read counts as under a grant only if its grant was active at that moment", () => {
  const at = ago(2);
  const grant = { createdAt: ago(3), expiresAt: ago(1), revokedAt: null };
  assert.equal(isUnderActiveGrant({ at, grant }), true);
  assert.equal(isUnderActiveGrant({ at, grant: null }), false);                                     // no grant, unknown grant, or another organization's
  assert.equal(isUnderActiveGrant({ at, grant: { ...grant, createdAt: ago(1.5) } }), false);        // issued afterwards
  assert.equal(isUnderActiveGrant({ at, grant: { ...grant, expiresAt: ago(2.5) } }), false);        // already expired
  assert.equal(isUnderActiveGrant({ at, grant: { ...grant, revokedAt: ago(2.5) } }), false);        // already revoked
  assert.equal(isUnderActiveGrant({ at, grant: { ...grant, revokedAt: ago(1.5) } }), true);         // revoked later
  const reads = [{ at, grant }, { at, grant }, { at, grant: null }, { at, grant: { ...grant, revokedAt: ago(2.5) } }];
  assert.deepEqual(supportAccessUnderGrant(reads, 7), { reads: 4, underActiveGrant: 2, withoutActiveGrant: 2, refusedWithoutGrant: 7, rate: 0.5, target: 1 });
  assert.equal(supportAccessUnderGrant([], 3).rate, null);
});

test("the window is 30 days by default and refuses anything but 1 to 365 whole days", () => {
  assert.equal(parseWindowDays(undefined), 30);
  assert.equal(parseWindowDays(""), 30);
  assert.equal(parseWindowDays("90"), 90);
  assert.equal(parseWindowDays("365"), 365);
  for (const bad of ["0", "366", "-1", "1.5", "abc", "1e2", ["7", "8"], { $gt: 1 }]) {
    assert.throws(() => parseWindowDays(bad), (error) => error instanceof LaunchMetricsError && error.code === "INVALID_WINDOW" && error.status === 400);
  }
});

const fakeSource = (calls = []) => ({
  invitations: async (since, until) => { calls.push(["invitations", since, until]); return [{ createdAt: ago(20), acceptedAt: ago(19) }]; },
  acceptances: async (since, until) => { calls.push(["acceptances", since, until]); return [{ acceptedAt: ago(19), firstRfpOpenedAt: ago(19, 120_000) }]; },
  activeMemberCounts: async () => [1, 3],
  supportReads: async (since, until) => { calls.push(["supportReads", since, until]); return [{ at: ago(2), grant: { createdAt: ago(3), expiresAt: ago(1), revokedAt: null } }]; },
  supportRefusals: async () => 4,
  orphanedRfps: async () => ({ total: 2, organizations: 1 }),
  firstOpenTrackingSince: async () => ago(25),
});

test("the report carries the five metrics for the asked window, as numbers only", async () => {
  const calls = [];
  const report = await launchMetricsReport(fakeSource(calls), { days: 30, now: NOW });
  assert.deepEqual(report, {
    generatedAt: NOW.toISOString(),
    window: { days: 30, since: ago(30).toISOString(), until: NOW.toISOString() },
    inviteAcceptance: { sent: 1, atLeast7DaysOld: 1, acceptedWithin7Days: 1, acceptedLater: 0, rate: 1, target: 0.6 },
    timeToFirstRfpOpened: { accepted: 1, opened: 1, notYetOpened: 0, excludedOpenedBeforeAccepting: 0, excludedAcceptedBeforeTracking: 0, medianSeconds: 120, openedWithin5Minutes: 1, targetMedianSeconds: 300 },
    supportAccessUnderGrant: { reads: 1, underActiveGrant: 1, withoutActiveGrant: 0, refusedWithoutGrant: 4, rate: 1, target: 1 },
    organizationsWithTwoOrMoreActiveUsers: { organizations: 2, withTwoOrMoreActiveUsers: 1, rate: 0.5, target: 0.25 },
    orphanedRfps: { total: 2, organizations: 1, target: 0 },
  });
  // Invitations are the cohort that has had its 7 days; the rest use the window as asked.
  for (const [name, since, until] of calls) {
    const shift = name === "invitations" ? 7 : 0;
    assert.equal(since.getTime(), ago(30 + shift).getTime(), name);
    assert.equal(until.getTime(), ago(shift).getTime(), name);
  }
  // A window shorter than 7 days still has a cohort to judge.
  const short = [];
  await launchMetricsReport(fakeSource(short), { days: 3, now: NOW });
  const [, from, to] = short.find(([name]) => name === "invitations");
  assert.deepEqual([from.getTime(), to.getTime()], [ago(10).getTime(), ago(7).getTime()]);
  // Counts, rates, durations and timestamps of the report itself: nothing that names a customer.
  const leaves = [];
  const walk = (value) => (value && typeof value === "object" ? Object.values(value).forEach(walk) : leaves.push(value));
  walk({ ...report, generatedAt: undefined, window: { days: report.window.days } });
  assert.ok(leaves.every((leaf) => leaf === undefined || leaf === null || typeof leaf === "number"), JSON.stringify(leaves));
});

// ── HTTP boundary ────────────────────────────────────────────────────────────────────────────

const fakeResponse = () => {
  const res = { statusCode: 0, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const controllerWith = (overrides = {}) => {
  const audit = [];
  const sourceCalls = [];
  const controller = createLaunchMetricsController({
    source: fakeSource(sourceCalls),
    audit: { append: async (event) => { audit.push(event); } },
    clock: () => NOW,
    ...overrides,
  });
  return { controller, audit, sourceCalls };
};
const staff = { userId: "admin-1", organizationId: "dxg", role: "admin", accountType: "admin", roles: ["dxg_admin"] };

test("staff on an admins account read the metrics, and the read is audited in the staff organization", async () => {
  const { controller, audit } = controllerWith();
  const res = fakeResponse();
  await controller.getLaunchMetrics({ user: staff, query: { days: "14" }, correlationId: "corr-1" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.window.days, 14);
  assert.equal(res.body.data.orphanedRfps.total, 2);
  assert.deepEqual(audit, [{
    organizationId: "dxg", actorUserId: "admin-1", action: "platform.launch_metrics.read", targetType: "platform",
    decision: "allowed", reason: "launch_metrics", correlationId: "corr-1", metadata: { days: 14, agentAccountType: "admin" },
  }]);
});

test("a customer account is refused before any query runs, whatever roles it holds", async () => {
  const customers = [
    { ...staff, accountType: "planner", role: "customer", roles: ["owner"] },
    // A member who still holds a legacy staff role passes the route's role check; the account type refuses them.
    { ...staff, accountType: "planner", role: "admin", roles: ["dxg_admin"] },
    { ...staff, accountType: undefined },
    { ...staff, role: "customer" },
  ];
  for (const user of customers) {
    const { controller, audit, sourceCalls } = controllerWith();
    const res = fakeResponse();
    await controller.getLaunchMetrics({ user, query: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { success: false, code: "LAUNCH_METRICS_FORBIDDEN", message: "Only RFPilot staff can read launch metrics." });
    assert.deepEqual(audit, []);
    assert.deepEqual(sourceCalls, []);
  }
  const anonymous = fakeResponse();
  await controllerWith().controller.getLaunchMetrics({ query: {} }, anonymous);
  assert.equal(anonymous.statusCode, 401);
});

test("a bad window is a 400 and a failing query is a 500 without details", async () => {
  const bad = fakeResponse();
  await controllerWith().controller.getLaunchMetrics({ user: staff, query: { days: "9999" } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.code, "INVALID_WINDOW");

  const failing = controllerWith({ source: { ...fakeSource(), orphanedRfps: async () => { throw new Error("mongo down at host-1"); } } });
  const res = fakeResponse();
  const original = console.error;
  console.error = () => {};
  try {
    await failing.controller.getLaunchMetrics({ user: staff, query: {} }, res);
  } finally {
    console.error = original;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "LAUNCH_METRICS_INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(res.body), /host-1/);
});

test("if the read cannot be audited, nothing is returned", async () => {
  const { controller, sourceCalls } = controllerWith({ audit: { append: async () => { throw new Error("audit down"); } } });
  const res = fakeResponse();
  const original = console.error;
  console.error = () => {};
  try {
    await controller.getLaunchMetrics({ user: staff, query: {} }, res);
  } finally {
    console.error = original;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(sourceCalls, []);
});

// ── Route guard ──────────────────────────────────────────────────────────────────────────────

test("the only launch metrics route is staff-only: authenticate, then the staff role check, before the handler", () => {
  const { authenticate } = require("../middleware/auth");
  const routes = require("../routes/launchMetricsRoute").default.stack.filter((layer) => layer.route);
  assert.deepEqual(routes.map((layer) => `${Object.keys(layer.route.methods).join(",")} ${layer.route.path}`), ["get /admin/launch-metrics"]);
  const handlers = routes[0].route.stack.map((layer) => layer.handle);
  assert.equal(handlers[0], authenticate);
  assert.equal(handlers.length, 4);
  // The second handler is authorize("admin", ...): it refuses a customer role and passes a staff one.
  const verdict = (roles) => {
    const res = fakeResponse();
    let nexted = false;
    handlers[1]({ user: { roles } }, res, () => { nexted = true; });
    return nexted ? "next" : res.statusCode;
  };
  for (const role of ["owner", "organization_admin", "team_manager", "planner", "viewer"]) assert.equal(verdict([role]), 403, role);
  assert.equal(verdict(["dxg_admin"]), "next");
});

test("no customer-facing router or module reads the launch metrics", () => {
  const root = path.join(__dirname, "..");
  const files = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.ts$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const importers = ["routes", "controller", "middleware", "utils", "src"].flatMap(files)
    .filter((file) => !file.startsWith(path.join("src", "modules", "launchMetrics")))
    .filter((file) => /launchMetrics\/(domain|mongoLaunchMetricsSource)|launchMetricsController/.test(fs.readFileSync(path.join(root, file), "utf8")));
  assert.deepEqual(importers.sort(), ["controller/launchMetricsController.ts", "routes/launchMetricsRoute.ts"]);
});

// ── First RFP opened ─────────────────────────────────────────────────────────────────────────

test("opening an RFP stamps the member once, skips staff accounts, and never throws", async () => {
  const stamped = [];
  const record = createRecordFirstRfpOpened(async (input) => { stamped.push(input); }, () => NOW);
  await record({ organizationId: "org", userId: "user", accountType: "planner" });
  await record({ organizationId: "org", userId: "admin", accountType: "admin" });
  await record({ organizationId: null, userId: "user" });
  await record({ organizationId: "org" });
  assert.deepEqual(stamped, [{ organizationId: "org", userId: "user", at: NOW }]);

  const failing = createRecordFirstRfpOpened(async () => { throw new Error("mongo down"); });
  await assert.doesNotReject(failing({ organizationId: "org", userId: "user" }));
});
