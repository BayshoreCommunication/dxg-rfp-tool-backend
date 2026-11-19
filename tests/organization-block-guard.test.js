const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* Organization block guard (owner decision 2026-11-18; docs/DECISIONS.md "RFPilot staff block and
   reactivate a customer organization"). A block closes EVERYTHING for the organization, so a new
   way to act for an organization must go through the block check or be listed here with the
   reason it is exempt. This test fails when:

   - a route is registered without `authenticate` (which refuses a blocked organization's members)
     or `requirePublicGrant` (which closes a blocked organization's links) and is not in
     PUBLIC_ROUTES below;
   - a BullMQ worker is created that does not defer a blocked organization's job before claiming it;
   - a job is scheduled from the cron starter, or a timer is started in a new file, that is not in
     CRON_JOBS / TIMERS below;
   - the server serves something outside a router that is not in SERVER_SURFACES;
   - the rule "is this organization blocked" is written anywhere but organizationBlock/domain.ts.

   Modelled on tests/tenant-scope-guard.test.js. Keep the lists short and the reasons exact: an
   entry says HOW the block is enforced for that surface, or WHY it does not need to be. */

const repoRoot = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const sourceFiles = (dir) =>
  fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(file);
    return /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [file] : [];
  });

const ENFORCED = {
  session: "ENFORCED: issues or refreshes a session only through beginAuthenticatedSession / the session manager, which refuse a blocked organization",
  step: "ENFORCED: acts on a two-factor challenge that is only issued after the block check, and completes through beginAuthenticatedSession",
  invitation: "ENFORCED: every invitation token is resolved by the invitation service, which answers INVITATION_INVALID for a blocked organization",
  domain: "ENFORCED: the organization comes from organizationForEmailDomain, which offers a blocked organization to nobody",
  tracking: "ENFORCED: trackEmailEngagement records nothing for a blocked organization and answers as an unknown tracking id",
  sso: "ENFORCED: the callback refuses a blocked organization before any account is resolved; the exchange issues its session through beginAuthenticatedSession",
};
const EXEMPT = {
  account: "EXEMPT: acts on a person's own account before any organization is chosen (code by email, password reset); it issues no session and reads or writes nothing of an organization",
  newOrganization: "EXEMPT: creates a NEW organization for a new account; an organization that does not exist yet cannot be blocked. A domain match to an existing organization goes through organizationForEmailDomain",
  staffSignIn: "EXEMPT: RFPilot staff accounts (`admins`) sign in to the staff organization, which can never be blocked; the session still begins through beginAuthenticatedSession",
  logout: "EXEMPT: ends the presented session; a block has already ended every session of the organization, so nothing is revoked and nothing is audited",
  discover: "EXEMPT on purpose: answers one bit per email domain to anyone; it must NOT change with a block, or it would reveal the block",
  ssoStart: "EXEMPT on purpose: redirects anyone who types an email to the identity provider; it must not change with a block. The callback enforces",
};

/* Every route that is registered without `authenticate` and without `requirePublicGrant`. */
const PUBLIC_ROUTES = {
  "routes/accessRequestRoute.ts": { "POST /auth/access-requests": ENFORCED.domain },
  "routes/authRoute.ts": {
    "POST /send-otp": EXEMPT.account,
    "POST /verify-otp": EXEMPT.account,
    "POST /register": EXEMPT.newOrganization,
    "POST /login": ENFORCED.session,
    "POST /google": ENFORCED.session,
    "POST /admin/signup": EXEMPT.staffSignIn,
    "POST /admin/signin": EXEMPT.staffSignIn,
    "POST /refresh": ENFORCED.session,
    "POST /logout-session": EXEMPT.logout,
    "POST /forgot-password/send-otp": EXEMPT.account,
    "POST /forgot-password/verify-otp": EXEMPT.account,
    "POST /forgot-password/reset": EXEMPT.account,
    "POST /admin/forgot-password/send-otp": EXEMPT.staffSignIn,
    "POST /admin/forgot-password/verify-otp": EXEMPT.staffSignIn,
    "POST /admin/forgot-password/reset": EXEMPT.staffSignIn,
  },
  "routes/emailRoute.ts": {
    "GET /open/:trackingId": ENFORCED.tracking,
    "GET /click/:trackingId": ENFORCED.tracking,
    "GET /vendor-click/:trackingId": ENFORCED.tracking,
  },
  "routes/invitationRoute.ts": {
    "POST /invitations/lookup": ENFORCED.invitation,
    "POST /invitations/accept": ENFORCED.invitation,
    "POST /invitations/accept/register": ENFORCED.invitation,
    "POST /invitations/accept/google": ENFORCED.invitation,
  },
  "routes/ssoRoute.ts": {
    "POST /discover": EXEMPT.discover,
    "GET /start": EXEMPT.ssoStart,
    "GET /callback": ENFORCED.sso,
    "POST /exchange": ENFORCED.sso,
  },
  "routes/twoFactorRoute.ts": {
    "POST /challenge": ENFORCED.step,
    "POST /enrolment/start": ENFORCED.step,
    "POST /enrolment/confirm": ENFORCED.step,
  },
};

/* What server.ts serves outside a router. */
const SERVER_SURFACES = {
  'app.get("/"': "EXEMPT: a fixed banner; no organization",
  'app.get("/health"': "EXEMPT: process and dependency health; no organization",
  'app.get("/api"': "EXEMPT: a fixed banner; no organization",
  'app.use("/uploads", express.static(': "NOT ENFORCED (known gap, listed in docs/API.md): legacy local upload files are served by file name with no organization in the path, so there is nothing to ask the gate about. Production stores uploads in private object storage behind signed URLs",
};

/* Every job the cron starter schedules: where its block check is. */
const CRON_JOBS = {
  runExpirationCheck: { enforcedIn: "utils/cronJobs.ts" },
  purgeArchivedProposals: { enforcedIn: "utils/cronJobs.ts" },
  runRetentionSweep: { enforcedIn: "src/modules/dataFoundation/retentionSweeper.ts" },
  runVendorDraftCleanup: { enforcedIn: "src/modules/vendorResponses/application/vendorSubmissionDrafts.ts" },
  runInvitationSweep: { enforcedIn: "src/modules/invitations/application/sweepInvitations.ts" },
  runDomainVerificationSweep: { enforcedIn: "src/modules/domainVerification/application/manageDomains.ts" },
  runOrphanedProposalCheck: { exempt: "EXEMPT: read-only; logs two counts and writes nothing in any organization" },
};

/* Every file that starts a repeating timer. */
const TIMERS = {
  "utils/cronJobs.ts": "the cron starter: each job is in CRON_JOBS",
  "src/modules/supportDesk/infrastructure/scheduler/supportDeskSchedule.ts": "ENFORCED in supportDesk/application/supportDeskSweeper.ts (customer-facing steps skip a blocked organization)",
  "scripts/startDurableDispatcher.ts": "EXEMPT: publishes job references from the outbox to Redis and runs nothing; the worker defers a blocked organization's job before claiming it",
  "src/modules/durableJobs/worker.ts": "the lease heartbeat of a job that already passed the block check",
  "src/modules/tenancy/placementTaskRunner.ts": "EXEMPT: the heartbeat of a legacy-customer placement that RFPilot staff started; a staff action",
  "controller/platformAssistantController.ts": "the heartbeat of a response stream opened by a request that passed `authenticate`",
  "controller/conversationsController.ts": "the poll of a response stream opened by a request that passed `authenticate`",
};

// The text between a call's parentheses.
const argumentsOf = (source, openIndex) => {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(openIndex + 1, i);
  }
  return source.slice(openIndex + 1);
};

// Names of constants in a route file that carry `authenticate` (directly, or through another one).
const guardNames = (source) => {
  const declarations = [...source.matchAll(/const (\w+)(?::[^=]+)? = ([^;]+);/g)].map((m) => [m[1], m[2]]);
  const guards = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, initializer] of declarations) {
      if (guards.has(name)) continue;
      if (/\bauthenticate\b|createAuthenticate\(/.test(initializer) || [...guards].some((guard) => new RegExp(`\\b${guard}\\b`).test(initializer))) {
        guards.add(name);
        grew = true;
      }
    }
  }
  return guards;
};

const routesOf = (file) => {
  const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const guards = guardNames(source);
  const routerGuarded = /router\.use\(\s*authenticate\b/.test(source);
  const routes = [];
  for (const match of source.matchAll(/\brouter\.(get|post|put|patch|delete)\(/g)) {
    const args = argumentsOf(source, match.index + match[0].length - 1);
    // The path: a string literal, or a constant holding one (its name is then the key).
    const first = args.match(/^\s*(?:["'`]([^"'`]*)["'`]|([A-Za-z_]\w*))\s*,/);
    assert.ok(first, `${file}: a route whose path can't be read can't be checked: ${args.slice(0, 60)}`);
    const routePath = first[1] ?? first[2];
    const handlers = args.slice(first[0].length);
    const guarded = routerGuarded
      || /\bauthenticate\b|createAuthenticate\(|requirePublicGrant\(/.test(handlers)
      || [...guards].some((guard) => new RegExp(`\\b${guard}\\b`).test(handlers));
    routes.push({ key: `${match[1].toUpperCase()} ${routePath}`, guarded });
  }
  return routes;
};

test("every route goes through authenticate or requirePublicGrant, or is listed with how the block reaches it", () => {
  const files = sourceFiles("routes");
  assert.ok(files.length > 50, "the route files were found");
  const unlisted = [];
  const stale = [];
  let total = 0;
  for (const file of files) {
    const routes = routesOf(file);
    total += routes.length;
    const listed = PUBLIC_ROUTES[file] ?? {};
    const open = routes.filter((route) => !route.guarded).map((route) => route.key);
    for (const key of open) if (!listed[key]) unlisted.push(`${file}: ${key}`);
    for (const key of Object.keys(listed)) if (!open.includes(key)) stale.push(`${file}: ${key}`);
  }
  assert.ok(total > 350, `the routes were parsed (${total})`);
  assert.deepEqual(unlisted, [], "a route without authenticate or requirePublicGrant must be added to PUBLIC_ROUTES with how the organization block is enforced for it, or why it is exempt");
  assert.deepEqual(stale, [], "PUBLIC_ROUTES names a route that is no longer public; remove it");
  for (const file of Object.keys(PUBLIC_ROUTES)) assert.ok(files.includes(file), `${file} is listed but does not exist`);
  for (const reasons of Object.values(PUBLIC_ROUTES)) for (const reason of Object.values(reasons)) assert.match(reason, /^(ENFORCED|EXEMPT)[ :]/);
  // Every route file is mounted, and nothing else is.
  const server = read("server.ts");
  const imported = [...server.matchAll(/from "\.\/routes\/(\w+)";/g)].map((m) => `routes/${m[1]}.ts`).sort();
  assert.deepEqual(imported, [...files].sort(), "every file in routes/ is mounted by server.ts, so every route was checked");
});

test("the two middlewares the guard relies on do enforce the block", () => {
  const auth = read("middleware/auth.ts");
  assert.match(auth, /if \(isOrganizationBlocked\(organization\)\) \{[\s\S]{0,700}res\.status\(401\)\.json\(\{ success: false, code: ORGANIZATION_BLOCKED\.code, message: ORGANIZATION_BLOCKED\.message \}\);\s+return;/);
  assert.match(auth, /export const authenticate = createAuthenticate\(verifyAccessToken\);/);
  // requirePublicGrant admits a request only with a grant from validateAndConsume (or a user
  // that authenticate already admitted); validateAndConsume asks the gate before using the link.
  const grant = read("middleware/publicAccess.ts");
  assert.match(grant, /grant = await publicAccess\.validateAndConsume\(\{/);
  assert.match(grant, /if \(\(req as AuthRequest\)\.user\) return next\(\);/);
  const manager = read("src/modules/publicAccess/application/managePublicAccess.ts");
  const consume = manager.slice(manager.indexOf("async validateAndConsume("));
  assert.ok(consume.indexOf("await organizationBlocked(organizationId)") > 0);
  assert.ok(consume.indexOf("await organizationBlocked(organizationId)") < consume.indexOf("return repository.consume("), "asked before the link is used");
  assert.equal((manager.match(/repository\.consume\(/g) ?? []).length, 1);
  // `optionalAuth` on the public proposal routes is `authenticate` when a bearer token is sent.
  assert.match(read("routes/proposalsRoute.ts"), /void authenticate\(req as AuthRequest, _res, next\);/);
});

test("staff routes keep working on a blocked organization: they act on the path's organization, and the staff organization can never be blocked", () => {
  // Staff requests pass `authenticate` for the STAFF organization (the session's), not the
  // customer's, so a block of the customer organization does not touch them.
  const service = read("src/modules/staffAccess/application/manageOrganizationBlock.ts");
  assert.match(service, /const standing = unmanageableStanding\(organization, staff\.organizationId\);\s+if \(standing\) throw notManageable\(standing\);/);
  // None of the staff services or stores asks the gate: a block must not stop staff from reading or fixing the organization.
  const staffFiles = sourceFiles("src/modules/staffAccess").filter((file) => !/OrganizationBlock/.test(file));
  assert.ok(staffFiles.length >= 6);
  for (const file of [...staffFiles, "src/modules/entitlements/application/organizationAccountDetail.ts", "src/modules/supportAccess/application/manageSupportAccess.ts"].filter((f) => fs.existsSync(path.join(repoRoot, f)))) {
    assert.doesNotMatch(read(file), /organizationBlockGate|isOrganizationBlocked\(|blockedOrganizationIds/, `${file} must not refuse a blocked organization`);
  }
});

test("server.ts serves nothing outside a router except the listed surfaces", () => {
  const server = read("server.ts").replace(/^\s*\/\/.*$/gm, "");
  const direct = [...server.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => `app.${m[1]}("${m[2]}"`);
  const statics = [...server.matchAll(/app\.use\(\s*"([^"]+)",\s*express\.static\(/g)].map((m) => `app.use("${m[1]}", express.static(`);
  assert.deepEqual([...direct, ...statics].sort(), Object.keys(SERVER_SURFACES).sort());
  // Everything else mounted on a path is a router from routes/.
  const mounts = [...server.matchAll(/app\.use\(\s*"[^"]+",\s*(\w+)/g)].map((m) => m[1]).filter((name) => name !== "express");
  assert.ok(mounts.length > 50);
  for (const name of mounts) assert.match(name, /Routes$/, `${name} is mounted on a path but is not a router from routes/`);
});

test("every durable worker defers a blocked organization's job before it claims it", () => {
  const files = ["src", "scripts", "utils", "controller"].flatMap(sourceFiles);
  const workers = files.filter((file) => /new Worker\s*</.test(read(file)) || /new Worker\(/.test(read(file)));
  assert.deepEqual(workers.sort(), ["src/modules/durableJobs/aiGatewayWorker.ts", "src/modules/durableJobs/worker.ts"], "a new BullMQ worker must defer blocked organizations' jobs and be added here");
  for (const file of workers) {
    const source = read(file);
    assert.equal((source.match(/new Worker\s*</g) ?? []).length, 1, `${file}: one worker per file`);
    const processor = source.slice(source.search(/new Worker\s*</));
    const deferral = processor.indexOf("await deferJobOfBlockedOrganization(job");
    assert.ok(deferral > 0, `${file}: the processor must call deferJobOfBlockedOrganization`);
    for (const later of ["repository.claim(", "execute(", "handleAiGatewayTest("]) {
      const at = processor.indexOf(later);
      if (at > 0) assert.ok(deferral < at, `${file}: the block check comes before ${later}`);
    }
  }
  // Every job type runs inside one of those two processors: none is handled anywhere else.
  const domain = read("src/modules/durableJobs/domain.ts");
  const jobTypes = [...domain.slice(domain.indexOf("jobType:"), domain.lastIndexOf(";inputReference")).matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.ok(jobTypes.length >= 13, `the job types were parsed (${jobTypes.length})`);
  const worker = read("src/modules/durableJobs/worker.ts");
  const gateway = read("src/modules/durableJobs/aiGatewayWorker.ts");
  for (const type of jobTypes) {
    if (type === "ai_gateway_test") assert.match(gateway, /handleAiGatewayTest\(job\.data\)/);
    else assert.ok(worker.includes(`"${type}"`), `job type ${type} must be executed by the durable worker, behind its block check`);
  }
  // The dispatcher only publishes references; it runs no job.
  assert.doesNotMatch(read("src/modules/durableJobs/dispatcher.ts"), /handle[A-Z]\w+\(/);
});

test("every scheduled job skips a blocked organization, or is listed with the reason it need not", () => {
  const cron = read("utils/cronJobs.ts");
  const starter = cron.slice(cron.indexOf("export const startCronJobs"));
  const scheduled = [...new Set([...starter.matchAll(/\b(run\w+|purge\w+)\(\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(scheduled, Object.keys(CRON_JOBS).sort(), "a job added to startCronJobs must be added to CRON_JOBS with where its block check is");
  const usesRule = /blockedOrganizationIds|isOrganizationBlocked\(/;
  for (const [name, entry] of Object.entries(CRON_JOBS)) {
    if (entry.exempt) { assert.match(entry.exempt, /^EXEMPT: /); continue; }
    if (entry.enforcedIn === "utils/cronJobs.ts") {
      const start = cron.indexOf(`export const ${name}`);
      const body = cron.slice(start, cron.indexOf("\n};", start));
      assert.match(body, /await blockedOrganizationIds\(\)/, `${name} must skip blocked organizations`);
    } else {
      assert.match(read(entry.enforcedIn), usesRule, `${name}: ${entry.enforcedIn} must skip blocked organizations`);
    }
  }
  const timers = ["src", "scripts", "utils", "controller", "middleware", "routes"].flatMap(sourceFiles).filter((file) => /\bsetInterval\(|cron\.schedule\(/.test(read(file))).sort();
  assert.deepEqual(timers, Object.keys(TIMERS).sort(), "a file that starts a repeating timer must be added to TIMERS with how the organization block applies to it");
  assert.match(read("src/modules/supportDesk/application/supportDeskSweeper.ts"), /dependencies\.blockedOrganizationIds\?\.\(\)/);
  assert.doesNotMatch(read("server.ts"), /\bsetInterval\(/);
});

test("the rule exists once: only organizationBlock/domain.ts reads the marker, and every other file asks it", () => {
  const files = ["src", "controller", "routes", "middleware", "utils", "scripts"].flatMap(sourceFiles);
  // Reading `blocked.at` is deciding. Only the predicate may (the gate's query narrows a read
  // and then asks the predicate; it is the one other place the path is written).
  const readers = files.filter((file) => /\bblocked\??\.at\b|["']blocked\.at["']/.test(read(file))).sort();
  assert.deepEqual(readers, ["src/modules/organizationBlock/domain.ts", "src/modules/organizationBlock/organizationBlockGate.ts"]);
  const gate = read("src/modules/organizationBlock/organizationBlockGate.ts");
  assert.match(gate, /return isOrganizationBlocked\(await lookup\(id\)\);/);
  assert.doesNotMatch(gate, /setTimeout|new Map\(|ttl|cache\s*=/i, "the gate is not cached: a block applies on the next call everywhere");
  // `Organization.status` is not what the block enforces on.
  const domain = read("src/modules/organizationBlock/domain.ts");
  assert.doesNotMatch(domain.replace(/\/\*[\s\S]*?\*\//g, ""), /\.status\b|status\s*[!=]==?/);
  // Nothing compares `status` to decide a block.
  for (const file of files.filter((f) => /organizationBlock|OrganizationBlock/.test(f))) {
    assert.doesNotMatch(read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /status\s*[!=]==?\s*"(in)?active"/, file);
  }
  // The model: a dedicated field, no default.
  const model = read("modal/organizationModel.ts");
  const field = model.slice(model.indexOf("    blocked: {"), model.indexOf("  { timestamps: true }"));
  assert.match(field, /at: \{ type: Date, required: true \}/);
  assert.doesNotMatch(field, /default/);
  assert.match(model, /status: \{\s+type: String,\s+enum: \["active", "inactive"\],\s+default: "active",/);
});
