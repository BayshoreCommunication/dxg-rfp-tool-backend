const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

/* Organization block guard (owner decision 2026-11-18; docs/DECISIONS.md "RFPilot staff block and
   reactivate a customer organization"). A block closes EVERYTHING for the organization, so a new
   way to act for an organization must go through the block check or be listed here with the
   reason it is exempt. Source is read as a TypeScript syntax tree, not by text patterns, so quote
   style, line breaks and one-line files make no difference.

   THIS TEST FAILS WHEN

   Routes
   - a route (any HTTP method, `all` included) has no guard AT ITS OWN POSITION and is not in
     PUBLIC_ROUTES. A guard is exactly one of: the `authenticate` imported from middleware/auth
     (or `createAuthenticate(...)` from there, the same middleware for the upload ticket),
     a `requirePublicGrant(...)` call imported from middleware/publicAccess, a chain named in
     GUARD_CHAINS (verified to be an array literal that STARTS with `authenticate`), or a
     `router.use(authenticate, ...)` that comes BEFORE the route on the same router. A route above
     its file's `router.use(authenticate)` is public. A constant that merely mentions
     `authenticate` (a conditional wrapper, say) is not a guard;
   - `authenticate`, `createAuthenticate` or `requirePublicGrant` is an alias or a local
     declaration in a route file;
   - a route file uses `router.route(`, `router.param(`, a path that cannot be read, or a
     `router.use(` that is not `authenticate` first;
   - a router is created outside routes/, a second express application or HTTP server exists, or
     server.ts mounts on a path anything that is not a default import from ./routes/.

   Server surfaces
   - server.ts registers a direct handler (`app.get`, `app.all`, ...; any quote style), a path
     mount of an inline handler, or a global middleware that is not listed in SERVER_SURFACES or
     SERVER_MIDDLEWARE;
   - a file handles the HTTP `upgrade` (or `request`) event, or creates a WebSocket server, and is
     not in UPGRADE_SURFACES; or the one listed handler gains a second `upgrade` listener or a
     second path.

   Background work
   - a `new Worker` (BullMQ or worker thread) appears ANYWHERE in the repository's TypeScript
     outside the two durable workers, or one of those does not defer before it claims;
   - a file anywhere (config/, modal/ and the repository root included) calls `setInterval`,
     `setTimeout` or `setImmediate` and is not in TIMERS, or calls one MORE often than TIMERS
     records for it. Every recursive `setTimeout` loop is a `setTimeout`, so it is counted here;
   - a `while (true)` / `for (;;)` loop, a BullMQ repeatable job (`repeat:`, a job scheduler) or a
     scheduler library in package.json appears;
   - a starter (`startCronJobs`, `startSupportDeskSweeper`) is called from a new place, the cron
     starter references ANY name that is not in CRON_JOBS (whatever it is called), utils/cronJobs.ts
     gains a function that is not listed, or a cron job runs something other than what CRON_JOBS
     records for it;
   - inside a listed sweep FUNCTION (not file) a call on its repository port is not in SWEEPS, a
     batch read does not carry the blocked organization ids, or its repository query does not
     exclude them. A second sweep can only be scheduled through a starter, a cron job or a timer,
     each of which is pinned above; a second read added inside a listed sweep is pinned here.

   The rule
   - "is this organization blocked" is written anywhere but organizationBlock/domain.ts.

   WHAT THIS TEST DOES NOT CATCH (review these by hand)
   - whether a handler behind a listed ENFORCED reason really asks the gate: the reasons are
     claims, proven by tests/organization-block-enforcement.test.js, not by this file;
   - a route or timer registered through a computed member (`router[method](...)`,
     `global["setInterval"]`), `eval`, or code in node_modules or in a dependency's callback
     (a library that schedules its own work);
   - scheduling that lives outside this repository's TypeScript: PM2 `cron_restart`, the CDK
     stacks under deploy/ (an EventBridge rule or scheduled task), a GitHub workflow, a database
     job. The operator scripts under scripts/ that a person runs by hand are listed in
     docs/API.md as not asking about the block;
   - a loop built from `await`-ed promises without a timer or `while (true)` (a recursive async
     function that awaits a network call, a stream or queue consumer that is not a BullMQ Worker);
   - a new cross-organization read placed in a function that some already-pinned sweep function
     calls as a helper OUTSIDE its own body, or a sweep function that reads a model directly
     instead of through its repository port (utils/cronJobs.ts is the one file where that is
     the style, and its functions are each checked for the blocked set);
   - an authenticated route that acts for an organization OTHER than the session's (staff routes
     do so on purpose and are exempt by design; tests/tenant-scope-guard.test.js covers the rest);
   - a boot-time one-shot call that acts across organizations without a timer, a worker or a
     route: for example `void sendWeeklyDigests()` added to `startServer()` or to a start script.
     It runs once per process start, so nothing above counts it.

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
/* Every TypeScript file of the application: every top-level directory except the ones named
   here, plus the files at the repository root. A new top-level directory is scanned by default. */
const NOT_APPLICATION = new Set(["node_modules", "dist", "tests", "tests-integration", "deploy", "docs", "uploads", "migrations", "coverage"]);
const allSources = () =>
  fs.readdirSync(repoRoot, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || NOT_APPLICATION.has(entry.name)) return [];
    if (entry.isDirectory()) return sourceFiles(entry.name);
    return /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [entry.name] : [];
  }).sort();

// ── Syntax-tree helpers ─────────────────────────────────────────────────────────────────────
const trees = new Map();
const parse = (file) => {
  if (!trees.has(file)) trees.set(file, ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true));
  return trees.get(file);
};
const visit = (node, fn) => { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); };
const nodesOf = (root, test_) => { const found = []; visit(root, (node) => { if (test_(node)) found.push(node); }); return found; };
const callsIn = (root) => nodesOf(root, ts.isCallExpression);
const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null);
// `a.b.c` for a callee, seen through parentheses, casts and `!` (so `(repository as any).list`
// is `repository.list`); null when the callee is not a plain dotted name.
const dotted = (node) => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || (ts.isSatisfiesExpression?.(node) ?? false)) node = node.expression;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) { const left = dotted(node.expression); return left === null ? null : `${left}.${node.name.text}`; }
  return null;
};
const squash = (text) => text.replace(/\s+/g, " ").trim();
const isFunction = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
// The function-like node declared under `name` (a const, a method, a property or a declaration).
const functionNamed = (file, name) => {
  const found = nodesOf(parse(file), (node) =>
    ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name.getText() === name && node.initializer && isFunction(node.initializer))
    || ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText() === name));
  assert.equal(found.length, 1, `${file}: exactly one function named ${name} (found ${found.length})`);
  return ts.isVariableDeclaration(found[0]) || ts.isPropertyAssignment(found[0]) ? found[0].initializer : found[0];
};
// local name -> { module, imported, alias } for every import of a file.
const importsOf = (file) => {
  const map = new Map();
  for (const statement of parse(file).statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const module_ = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name) map.set(clause.name.text, { module: module_, imported: "default", alias: false });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) map.set(element.name.text, { module: module_, imported: (element.propertyName ?? element.name).text, alias: Boolean(element.propertyName) });
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) map.set(clause.namedBindings.name.text, { module: module_, imported: "*", alias: false });
  }
  return map;
};

const ENFORCED = {
  session: "ENFORCED: issues or refreshes a session only through beginAuthenticatedSession / the session manager, which refuse a blocked organization",
  step: "ENFORCED: acts on a two-factor challenge that is only issued after the block check, and completes through beginAuthenticatedSession",
  invitation: "ENFORCED: every invitation token is resolved by the invitation service, which answers INVITATION_INVALID for a blocked organization",
  domain: "ENFORCED: a blocked organization still matches its domain (an outsider sees no difference), but the request waits as pending: accessRequests.request asks the gate, runs no auto-approve and notifies nobody in the organization",
  tracking: "ENFORCED: trackEmailEngagement records nothing for a blocked organization and answers as an unknown tracking id",
  sso: "ENFORCED: the callback refuses a blocked organization before any account is resolved; the exchange issues its session through beginAuthenticatedSession",
};
const EXEMPT = {
  account: "EXEMPT: acts on a person's own account before any organization is chosen (code by email, password reset); it issues no session and reads or writes nothing of an organization",
  newOrganization: "EXEMPT: creates a NEW organization for a new account; an organization that does not exist yet cannot be blocked. A domain match to an existing organization, blocked or not, answers 409 ORGANIZATION_DOMAIN_MATCH unless the person explicitly chooses a separate organization",
  domainMatch: "EXEMPT on purpose: answers the same for a blocked organization, by decision 2026-11-19: the domain keeps matching. After the code proved the address it names the organization that owns the email's domain (organizationForEmailDomain); it issues no session and writes nothing in that organization",
  staffSignIn: "EXEMPT: RFPilot staff accounts (`admins`) sign in to the staff organization, which the block route refuses to block; the session still begins through beginAuthenticatedSession",
  logout: "EXEMPT: ends the presented session; a block has already ended every session of the organization, so nothing is revoked and nothing is audited",
  discover: "EXEMPT on purpose: answers one bit per email domain to anyone; it must NOT change with a block, or it would reveal the block",
  ssoStart: "EXEMPT on purpose: redirects anyone who types an email to the identity provider; it must not change with a block. The callback enforces",
};

/* Every route that is registered without `authenticate` and without `requirePublicGrant`. */
const PUBLIC_ROUTES = {
  "routes/accessRequestRoute.ts": { "POST /auth/access-requests": ENFORCED.domain },
  "routes/authRoute.ts": {
    "POST /send-otp": EXEMPT.account,
    "POST /verify-otp": EXEMPT.domainMatch,
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

/* The named guard chains of the route files. Each was read and is verified below to be an array
   literal whose FIRST element is `authenticate` (or the spread of another chain listed for the same
   file). Nothing else named in a route is a guard: a new
   chain must be added here, and a constant that only mentions `authenticate` never qualifies. */
const GUARD_CHAINS = {
  "routes/adminOrganizationBlockRoute.ts": ["write"],
  "routes/adminOrganizationContentRoute.ts": ["staff"],
  "routes/adminOrganizationMembersRoute.ts": ["staff"],
  "routes/adminOrganizationPlansRoute.ts": ["staff"],
  "routes/adminOrganizationTeamsRoute.ts": ["staff"],
  "routes/adminUserRoute.ts": ["adminGuard", "superAdminGuard"],
  "routes/allClientsRoute.ts": ["adminGuard", "superAdminGuard"],
  "routes/auditLogRoute.ts": ["read"],
  "routes/organizationSecurityRoute.ts": ["manage"],
  "routes/organizationSsoRoute.ts": ["manage"],
  "routes/organizationVendorsRoute.ts": ["read", "write"],
  "routes/proposalTemplatesRoute.ts": ["use", "manage"],
  "routes/supportAccessRoute.ts": ["manage", "agentGuard", "contentGuard"],
  "routes/supportDeskRoute.ts": ["agentGuard"],
  "routes/teamsRoute.ts": ["admin"],
};

/* What server.ts serves outside a router: direct handlers and path mounts that are not routers. */
const SERVER_SURFACES = {
  'app.get("/")': "EXEMPT: a fixed banner; no organization",
  'app.get("/health")': "EXEMPT: process and dependency health; no organization",
  'app.get("/api")': "EXEMPT: a fixed banner; no organization",
  'app.use("/uploads", express.static(...))': "NOT ENFORCED (known gap, listed in docs/API.md): legacy local upload files are served by file name with no organization in the path, so there is nothing to ask the gate about. Production stores uploads in private object storage behind signed URLs",
};

/* Every middleware server.ts applies to all paths, in order. None reads or writes anything of an
   organization. An inline one is named by how its body begins. */
const SERVER_MIDDLEWARE = {
  "helmet(...)": "EXEMPT: response security headers",
  "cors(...)": "EXEMPT: CORS headers",
  "express.json(...)": "EXEMPT: body parser",
  "express.urlencoded(...)": "EXEMPT: body parser",
  "morgan(...)": "EXEMPT: request log line (development only)",
  correlationMiddleware: "EXEMPT: assigns the correlation id",
  'inline: res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-reval': "EXEMPT: no-cache headers",
  "inline: try { if (mongoose.connection.readyState !== 1) { await connectDB(); } next(); }": "EXEMPT: reconnects MongoDB for serverless; no organization",
  'inline: res.status(404).json({ success: false, message: "Route not found", }); }': "EXEMPT: the 404 answer",
  'inline: console.error("Global Error Handler:", err); res.status(err.status || 500).json(': "EXEMPT: the error answer",
};

/* Every file that answers an HTTP upgrade or opens a WebSocket server. */
const UPGRADE_SURFACES = {
  "utils/notificationService.ts": "ENFORCED: one `upgrade` listener on one path (WS_PATH); it refuses a session of a blocked organization (the block ended the session, and the gate is asked as well) before the handshake",
};

/* Every job the cron starter schedules, whatever it is called. `runs` is everything the job calls
   out to (the names it imports inside its body); `sweep` points at the sweep function in SWEEPS;
   `self` means the job's own body reads the blocked set and skips those organizations. */
const CRON_JOBS = {
  runExpirationCheck: { self: true, imports: [] },
  purgeArchivedProposals: { self: true, imports: ["../src/modules/dataFoundation/purgeProposalArtifacts"] },
  runRetentionSweep: { from: "../src/modules/dataFoundation/retentionSweeper", runs: ["retentionSweepEnabled", "sweepExpiredArtifacts"], sweep: "retention" },
  runVendorDraftCleanup: { from: "../src/modules/vendorResponses/composition", runs: ["cleanupExpiredVendorResponseDrafts"], sweep: "vendorDrafts" },
  runInvitationSweep: { from: "../src/modules/invitations/composition", runs: ["sweepInvitations"], sweep: "invitations" },
  runDomainVerificationSweep: { from: "../src/modules/domainVerification/composition", runs: ["domainVerification.sweep"], sweep: "domains" },
  runOrphanedProposalCheck: { from: "../src/modules/tenancy/migrationVerification", runs: ["findOrphanedProposals"], exempt: "EXEMPT: read-only; logs two counts and writes nothing in any organization" },
};
/* The other functions of utils/cronJobs.ts. */
const CRON_HELPERS = { parseExpiryDays: "pure: parses a setting", startCronJobs: "the starter" };

/* Where the starters are called. */
const STARTERS = {
  startCronJobs: ["scripts/startCronWorker.ts", "server.ts", "utils/cronJobs.ts"],
  startSupportDeskSweeper: ["server.ts", "src/modules/supportDesk/infrastructure/scheduler/supportDeskSchedule.ts"],
};

/* Every sweep FUNCTION that walks many organizations. `port` is how the function reaches its
   repository; every call on it inside the function body must be listed in `calls`:
   - "excluded": a batch read across organizations. It must be given the blocked organization
     ids, and each method in `queries` must put them in its MongoDB query (`$nin`), so a blocked
     organization's rows cannot fill a limited batch and starve the others;
   - any other text: why that call needs no exclusion (it acts on one row the excluded batch
     returned, or is exempt for the reason given). */
const SWEEPS = {
  retention: {
    file: "src/modules/dataFoundation/retentionSweeper.ts", fn: "sweepExpiredArtifacts",
    enumerates: /Organization\.find\(\{ status: "active" \}\)\.select\("_id blocked"\)[\s\S]{0,200}tenants\.filter\(\(row\) => !isOrganizationBlocked\(row\)\)/,
    exports: ["retentionSweepApplies", "retentionSweepEnabled", "sweepExpiredArtifacts"],
  },
  vendorDrafts: {
    file: "src/modules/vendorResponses/application/vendorSubmissionDrafts.ts", fn: "cleanupExpired", port: "dependencies.repository.",
    calls: { listCleanupCandidates: "excluded", markExpiredAbandoned: "one draft, by the id the excluded batch returned" },
    wiredIn: "src/modules/vendorResponses/composition.ts",
    queries: { file: "src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionDraftRepository.ts", methods: ["listCleanupCandidates"] },
  },
  invitations: {
    file: "src/modules/invitations/application/sweepInvitations.ts", fn: "createInvitationSweep", port: "deps.sweeps.",
    calls: { markExpired: "excluded", queueReminders: "excluded", dueDeliveries: "excluded" },
    wiredIn: "src/modules/invitations/composition.ts",
    queries: { file: "src/modules/invitations/infrastructure/mongoInvitationSweepRepository.ts", methods: ["markExpired", "queueReminders", "dueDeliveries"] },
  },
  domains: {
    file: "src/modules/domainVerification/application/manageDomains.ts", fn: "sweep", port: "dependencies.domains.",
    calls: { due: "excluded", claimDue: "one domain, by the id the excluded batch returned", recordCheck: "one domain, by the id the excluded batch returned" },
    wiredIn: "src/modules/domainVerification/composition.ts",
    queries: { file: "src/modules/domainVerification/infrastructure/mongo/mongoDomainRepository.ts", methods: ["due"] },
  },
  supportDesk: {
    file: "src/modules/supportDesk/application/supportDeskSweeper.ts", fn: "run", port: "repository.",
    calls: {
      listNeedingCloseReminder: "excluded", listDueToAutoResolve: "excluded", listResolvedBefore: "excluded",
      listUnansweredSince: "EXEMPT: the escalation is addressed to RFPilot staff, who still work a blocked organization's ticket; nothing customer-facing",
      backfillServiceLevels: "EXEMPT: fills the service-level fields of tickets created before they existed; no message, no email, no status change",
      updateTicket: "one ticket, by the id a batch above returned",
      appendMessage: "one ticket, by the id a batch above returned",
    },
    wiredIn: "src/modules/supportDesk/composition.ts",
    queries: { file: "src/modules/supportDesk/infrastructure/mongo/mongoSupportDeskRepository.ts", methods: ["listNeedingCloseReminder", "listDueToAutoResolve", "listResolvedBefore"] },
  },
};

/* Every loop with no end condition. */
const LOOPS = {
  "src/modules/tenancy/placementTasks.ts": "EXEMPT: the bounded retry of one optimistic write inside a legacy-customer placement that RFPilot staff started; it returns or throws, and is a staff action",
};

/* Every file that calls setInterval, setTimeout or setImmediate, with how many of each. A count
   that grows is a new timer: read it before raising the number. */
const TIMERS = {
  "utils/cronJobs.ts": { setInterval: 7, why: "the cron starter: one interval per job in CRON_JOBS" },
  "src/modules/supportDesk/infrastructure/scheduler/supportDeskSchedule.ts": { setInterval: 1, setTimeout: 1, why: "ENFORCED in supportDesk/application/supportDeskSweeper.ts (SWEEPS.supportDesk): the first run and the 5-minute interval of the one sweeper" },
  "scripts/startDurableDispatcher.ts": { setInterval: 2, why: "EXEMPT: publishes job references from the outbox to Redis and runs nothing; the worker defers a blocked organization's job before claiming it, and reconcile leaves blocked organizations out of its batch" },
  "src/modules/durableJobs/worker.ts": { setInterval: 1, why: "the lease heartbeat of a job that already passed the block check (a job running when the block commits finishes: docs/API.md, known limits)" },
  "src/modules/tenancy/placementTaskRunner.ts": { setInterval: 1, why: "EXEMPT: the heartbeat of a legacy-customer placement that RFPilot staff started; a staff action" },
  "controller/platformAssistantController.ts": { setInterval: 1, why: "the heartbeat of a response stream opened by a request that passed `authenticate`" },
  "controller/conversationsController.ts": { setInterval: 1, setTimeout: 1, why: "the poll and the time limit of a response stream opened by a request that passed `authenticate`" },
  "server.ts": { setTimeout: 2, why: "EXEMPT: time limits on the health checks and on shutdown; no organization" },
  "src/modules/documentIngestion/clamAvScanner.ts": { setTimeout: 1, why: "EXEMPT: the time limit of one malware scan, inside a job or request that passed its own check" },
  "src/modules/durableJobs/workerStartup.ts": { setTimeout: 1, why: "EXEMPT: the wait between MongoDB connection attempts at worker start-up, before any worker exists; no organization" },
  "config/db.ts": { setImmediate: 1, why: "EXEMPT: lowers the quiet-attempt flag one tick after a failed MongoDB connection; no organization" },
  "src/modules/durableJobs/queue.ts": { setTimeout: 1, why: "EXEMPT: the time limit of the queue health check" },
  "src/modules/platformAssistant/openAiAssistantProvider.ts": { setTimeout: 2, why: "EXEMPT: time limits of one provider call, inside a request that passed `authenticate`" },
  "scripts/verifyAuthRefreshE2E.ts": { setTimeout: 1, why: "EXEMPT: an operator's verification script; a wait" },
  "scripts/verifyCandidateApplicationE2E.ts": { setTimeout: 1, why: "EXEMPT: an operator's verification script; a wait" },
  "scripts/verifyDurableJobsE2E.ts": { setTimeout: 1, why: "EXEMPT: an operator's verification script; a wait" },
  "scripts/verifyProposalContextE2E.ts": { setTimeout: 1, why: "EXEMPT: an operator's verification script; a wait" },
};

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);
// `createAuthenticate(verifier)` builds the same middleware as `authenticate` for another token
// (the upload ticket); the block is decided inside it whatever the verifier.
const GUARD_IMPORTS = { authenticate: "../middleware/auth", createAuthenticate: "../middleware/auth", requirePublicGrant: "../middleware/publicAccess" };

const routesOf = (file) => {
  const tree = parse(file);
  const imports = importsOf(file);
  // The two guards are the real ones: imported under their own names, never redeclared.
  for (const [name, module_] of Object.entries(GUARD_IMPORTS)) {
    const imported = imports.get(name);
    if (imported) assert.deepEqual([imported.module, imported.imported, imported.alias], [module_, name, false], `${file}: \`${name}\` must be the one from ${module_}, not an alias`);
    const redeclared = nodesOf(tree, (node) => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node)) && node.name && node.name.getText() === name);
    assert.equal(redeclared.length, 0, `${file}: \`${name}\` is declared locally; a route guarded by it cannot be trusted`);
    if (!imported) assert.equal(nodesOf(tree, (node) => ts.isIdentifier(node) && node.text === name).length, 0, `${file}: \`${name}\` is used but not imported from ${module_}`);
  }
  // The listed chains are array literals that start with `authenticate`.
  const chains = new Set(GUARD_CHAINS[file] ?? []);
  const usedChains = new Set();
  for (const name of chains) {
    const declared = tree.statements.flatMap((statement) => (ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])).filter((d) => d.name.getText() === name);
    assert.equal(declared.length, 1, `${file}: GUARD_CHAINS names \`${name}\`, which is not a top-level constant of the file`);
    const init = declared[0].initializer;
    const head = init && ts.isArrayLiteralExpression(init) ? init.elements[0] : undefined;
    const startsWithAuthenticate = head && ts.isIdentifier(head) && head.text === "authenticate";
    const startsWithChain = head && ts.isSpreadElement(head) && ts.isIdentifier(head.expression) && chains.has(head.expression.text) && head.expression.text !== name;
    assert.ok(startsWithAuthenticate || startsWithChain, `${file}: \`${name}\` must be an array literal that starts with \`authenticate\` (or with another listed chain) to be a guard chain`);
    if (startsWithChain) usedChains.add(head.expression.text);
  }
  const isGuard = (argument) => {
    if (ts.isIdentifier(argument)) { if (chains.has(argument.text)) usedChains.add(argument.text); return argument.text === "authenticate" || chains.has(argument.text); }
    if (ts.isSpreadElement(argument) && ts.isIdentifier(argument.expression)) { if (chains.has(argument.expression.text)) usedChains.add(argument.expression.text); return chains.has(argument.expression.text); }
    if (ts.isCallExpression(argument)) return ts.isIdentifier(argument.expression) && ["requirePublicGrant", "createAuthenticate"].includes(argument.expression.text);
    if (ts.isArrayLiteralExpression(argument)) return Boolean(argument.elements[0]) && ts.isIdentifier(argument.elements[0]) && argument.elements[0].text === "authenticate";
    return false;
  };

  const routers = new Set(nodesOf(tree, (node) => ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && /^(express\.)?Router$/.test(node.initializer.expression.getText())).map((node) => node.name.getText()));
  assert.ok(routers.size >= 1, `${file}: no router found`);
  const guardedFrom = new Map(); // router name -> position of its first `router.use(authenticate, ...)`
  const routes = [];
  const onRouter = callsIn(tree)
    .filter((call) => ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) && routers.has(call.expression.expression.text))
    .sort((x, y) => x.getStart() - y.getStart());
  for (const call of onRouter) {
    const router = call.expression.expression.text;
    const method = call.expression.name.text;
    if (method === "use") {
      const first = call.arguments[0];
      assert.ok(first && ts.isIdentifier(first) && first.text === "authenticate", `${file}: \`${squash(call.getText()).slice(0, 80)}\` is a router.use that does not start with \`authenticate\`; it cannot be checked`);
      if (!guardedFrom.has(router)) guardedFrom.set(router, call.getStart());
      continue;
    }
    assert.ok(method !== "route" && method !== "param", `${file}: router.${method}( cannot be checked; register each route with router.<method>(path, ...)`);
    if (!HTTP_METHODS.has(method)) continue;
    const [first, ...handlers] = call.arguments;
    // A string in any quote style, a constant holding one, or a template built on one.
    const routePath = literal(first) ?? (first && ts.isIdentifier(first) ? first.text : first && ts.isTemplateExpression(first) ? first.getText().slice(1, -1) : null);
    assert.ok(routePath !== null, `${file}: a route whose path can't be read can't be checked: ${squash(call.getText()).slice(0, 60)}`);
    // Guarded only by a guard at this route's own position: among its handlers, or a
    // router.use(authenticate) registered EARLIER on the same router.
    const guarded = (guardedFrom.has(router) && guardedFrom.get(router) < call.getStart()) || handlers.some(isGuard);
    routes.push({ key: `${method.toUpperCase()} ${routePath}`, guarded });
  }
  for (const name of chains) assert.ok(usedChains.has(name), `${file}: GUARD_CHAINS names \`${name}\`, which no route uses; remove it`);
  return routes;
};

test("every route goes through authenticate or requirePublicGrant at its own position, or is listed with how the block reaches it", () => {
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
  for (const file of Object.keys(GUARD_CHAINS)) assert.ok(files.includes(file), `${file} is in GUARD_CHAINS but does not exist`);
  for (const reasons of Object.values(PUBLIC_ROUTES)) for (const reason of Object.values(reasons)) assert.match(reason, /^(ENFORCED|EXEMPT)[ :]/);
  /* The reasons must be true of the handler. `POST /verify-otp` reads an organization (it names the
     one that owns the email's domain), so it is not listed as "reads nothing of an organization";
     the handlers listed that way do not call the domain lookup. */
  const authController = read("controller/authController.ts");
  const handler = (name) => { const start = authController.indexOf(`export const ${name} = `); assert.ok(start > 0, name); const next = authController.indexOf("\nexport const ", start + 1); return authController.slice(start, next < 0 ? undefined : next); };
  assert.equal(PUBLIC_ROUTES["routes/authRoute.ts"]["POST /verify-otp"], EXEMPT.domainMatch);
  assert.match(EXEMPT.domainMatch, /answers the same for a blocked organization, by decision 2026-11-19: the domain keeps matching/);
  assert.match(handler("verifySignupOtp"), /organizationForEmailDomain\(/);
  assert.doesNotMatch(handler("sendSignupOtp"), /organizationForEmailDomain\(/);
  for (const factory of ["createSendForgotPasswordOtp", "createVerifyForgotPasswordOtp"]) { const start = authController.indexOf(`const ${factory} = `); assert.ok(start > 0, factory); assert.doesNotMatch(authController.slice(start, authController.indexOf("\nconst ", start + 1)), /organizationForEmailDomain\(/, factory); }
  assert.doesNotMatch(EXEMPT.staffSignIn, /can never be blocked/);
  assert.match(EXEMPT.staffSignIn, /staff organization, which the block route refuses to block/);
  // Routers exist only in routes/, and there is one application and one HTTP server.
  const sources = allSources();
  const creates = (pattern) => sources.filter((file) => callsIn(parse(file)).some((call) => pattern.test(call.expression.getText())));
  assert.deepEqual(creates(/^(express\.)?Router$/).filter((file) => !file.startsWith("routes/")), [], "a router created outside routes/ is not checked by this guard");
  assert.deepEqual(creates(/^express$/), ["server.ts"], "a second express application is not checked by this guard");
  assert.deepEqual(creates(/^(https?\.)?createServer$/), ["server.ts"], "a second HTTP server is not checked by this guard");
  assert.deepEqual(callsIn(parse("server.ts")).filter((call) => /^(https?\.)?createServer$/.test(call.expression.getText())).map((call) => call.arguments.map((a) => a.getText()).join(",")), ["app"]);
});

test("the two middlewares the guard relies on do enforce the block", () => {
  const auth = read("middleware/auth.ts");
  assert.match(auth, /const blocked = isOrganizationBlocked\(organization\);/);
  assert.match(auth, /if \(blocked\) \{[\s\S]{0,700}res\.status\(401\)\.json\(\{ success: false, code: ORGANIZATION_BLOCKED\.code, message: ORGANIZATION_BLOCKED\.message \}\);\s+return;/);
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
  // Blocking applies the full rule before the store is reached; reactivating leaves the decision
  // to the store, which removes a marker from any organization that carries one (F9).
  assert.match(service, /const standing = unmanageableStanding\(organization, staff\.organizationId\);\s+if \(standing && requireManageable\) throw notManageable\(standing\);/);
  assert.match(service, /audit: eventOf\(current, \{\}\),\s+\}\), true\),/, "block requires a manageable organization");
  // None of the staff services or stores asks the gate: a block must not stop staff from reading or fixing the organization.
  const staffFiles = sourceFiles("src/modules/staffAccess").filter((file) => !/OrganizationBlock/.test(file));
  assert.ok(staffFiles.length >= 6);
  for (const file of [...staffFiles, "src/modules/entitlements/application/organizationAccountDetail.ts", "src/modules/supportAccess/application/manageSupportAccess.ts"].filter((f) => fs.existsSync(path.join(repoRoot, f)))) {
    assert.doesNotMatch(read(file), /organizationBlockGate|isOrganizationBlocked\(|blockedOrganizationIds/, `${file} must not refuse a blocked organization`);
  }
});

// ── Server surfaces ─────────────────────────────────────────────────────────────────────────

test("server.ts serves nothing outside a router except the listed surfaces, and every router it mounts is a file in routes/", () => {
  const imports = importsOf("server.ts");
  const appCalls = callsIn(parse("server.ts")).filter((call) => ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText() === "app");
  const surfaces = [];
  const middleware = [];
  const mounted = [];
  const describe = (argument) => {
    if (ts.isCallExpression(argument)) return `${argument.expression.getText()}(...)`;
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return `inline: ${squash(argument.body.getText().replace(/\/\/.*$/gm, "")).replace(/^\{\s*/, "").slice(0, 80)}`;
    return argument.getText();
  };
  for (const call of appCalls) {
    const method = call.expression.name.text;
    const [first, ...rest] = call.arguments;
    if (["listen", "set", "disable", "enable", "get"].includes(method) && call.arguments.length === 1 && method !== "get") continue;
    if (method === "set" || method === "disable" || method === "enable") continue;
    assert.notEqual(method, "route", "app.route( cannot be checked");
    if (HTTP_METHODS.has(method)) {
      // A direct handler, in any quote style. (`app.get("setting")` with one argument reads a setting.)
      if (method === "get" && call.arguments.length === 1) continue;
      surfaces.push(`app.${method}(${JSON.stringify(literal(first) ?? first.getText())})`);
      continue;
    }
    if (method !== "use") continue;
    const mountPath = literal(first);
    if (mountPath === null) { for (const argument of call.arguments) middleware.push(describe(argument)); continue; }
    for (const argument of rest) {
      const imported = ts.isIdentifier(argument) ? imports.get(argument.text) : undefined;
      // Only a default import from ./routes/ is a router this guard has checked.
      if (imported && imported.imported === "default" && /^\.\/routes\/\w+$/.test(imported.module)) mounted.push(`${imported.module.slice(2)}.ts`);
      else surfaces.push(`app.use(${JSON.stringify(mountPath)}, ${describe(argument)})`);
    }
  }
  assert.deepEqual([...surfaces].sort(), Object.keys(SERVER_SURFACES).sort(), "a direct handler or a path mount that is not a router from routes/ must be added to SERVER_SURFACES with how the organization block applies to it");
  assert.deepEqual([...new Set(middleware)].sort(), Object.keys(SERVER_MIDDLEWARE).sort(), "a middleware applied to every path must be added to SERVER_MIDDLEWARE with why it needs no block check");
  for (const reason of [...Object.values(SERVER_SURFACES), ...Object.values(SERVER_MIDDLEWARE)]) assert.match(reason, /^(ENFORCED|EXEMPT|NOT ENFORCED)[ :(]/);
  // Every file in routes/ is mounted, and every mounted router is a file in routes/: every route was checked.
  assert.ok(mounted.length > 50);
  assert.deepEqual([...new Set(mounted)].sort(), sourceFiles("routes").sort());
  // `app` is not handed to anything that could register on it elsewhere.
  const appUses = nodesOf(parse("server.ts"), (node) => ts.isIdentifier(node) && node.text === "app" && !ts.isPropertyAccessExpression(node.parent) && !ts.isVariableDeclaration(node.parent) && !ts.isExportAssignment(node.parent));
  assert.deepEqual(appUses.map((node) => squash(node.parent.getText()).slice(0, 40)), ["http.createServer(app)"], "`app` is passed somewhere this guard does not look");
});

test("the HTTP upgrade and WebSocket surfaces are the listed ones, with one listener and one path", () => {
  const listens = /\.(on|once|addListener|prependListener)\(\s*["'`](upgrade|request)["'`]/g;
  const sockets = /new WebSocketServer|WebSocket\.Server|handleUpgrade\(|socket\.io|sec-websocket-accept/i;
  const found = allSources().filter((file) => { const source = read(file); listens.lastIndex = 0; return listens.test(source) || sockets.test(source); });
  assert.deepEqual(found, Object.keys(UPGRADE_SURFACES).sort(), "a file that answers an HTTP upgrade or opens a WebSocket must be added to UPGRADE_SURFACES with how the organization block applies to it");
  const source = read("utils/notificationService.ts");
  assert.equal((source.match(listens) ?? []).length, 1, "a second upgrade or request listener must refuse a blocked organization too: check it, then raise this count");
  // One path: the listener answers only WS_PATH, and nothing else in the file compares a pathname.
  assert.equal((source.match(/\bpathname\b/g) ?? []).length, 1);
  assert.match(source, /if \(requestUrl\.pathname !== WS_PATH\) \{\s+socket\.destroy\(\);\s+return;/);
  assert.equal((source.match(/\bWS_PATH\b/g) ?? []).length, 2, "WS_PATH is declared once and compared once");
  // The gate is asked before the handshake is answered.
  const handler = source.slice(source.indexOf('server.on("upgrade"'));
  const asked = handler.indexOf("await organizationBlockGate.isBlocked(payload.organizationId)");
  assert.ok(asked > 0 && asked < handler.indexOf("sec-websocket-key"), "the block is asked before the handshake");
  assert.deepEqual(allSources().filter((file) => /\binitializeNotificationWebSocketServer\b/.test(read(file))), ["server.ts", "utils/notificationService.ts"]);
});

test("every durable worker defers a blocked organization's job before it claims it", () => {
  // Anywhere in the application, config/, modal/ and the repository root included; BullMQ's
  // Worker and a worker thread alike.
  const workers = allSources().filter((file) => nodesOf(parse(file), (node) => ts.isNewExpression(node) && /(^|\.)Worker$/.test(node.expression.getText())).length > 0);
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
  // No other way to run code off the request path: no child process or worker thread outside the
  // one operator script that shells out, and no BullMQ repeatable job or job scheduler.
  assert.deepEqual(allSources().filter((file) => /worker_threads|child_process|cluster\b.*\bfork\(/.test(read(file))), ["scripts/rehearseCustomerOrganizations.ts"]);
  assert.deepEqual(allSources().filter((file) => /\brepeat\s*:|upsertJobScheduler|JobScheduler|QueueScheduler|removeRepeatable|\.every\(\s*\d/.test(read(file))), [], "a BullMQ repeatable job runs without a request: it must skip blocked organizations and be listed here");
  // The dispatcher only publishes references; it runs no job.
  assert.doesNotMatch(read("src/modules/durableJobs/dispatcher.ts"), /handle[A-Z]\w+\(/);
});

// ── Scheduled work ──────────────────────────────────────────────────────────────────────────

const TIMER_FUNCTIONS = ["setInterval", "setTimeout", "setImmediate"];

test("every timer, loop and scheduler in the application is a listed one", () => {
  const counted = {};
  for (const file of allSources()) {
    const counts = {};
    for (const call of callsIn(parse(file))) {
      const name = calleeName(call);
      if (TIMER_FUNCTIONS.includes(name)) counts[name] = (counts[name] ?? 0) + 1;
    }
    if (Object.keys(counts).length) counted[file] = counts;
  }
  const listed = Object.fromEntries(Object.entries(TIMERS).map(([file, { why, ...counts }]) => [file, counts]));
  assert.deepEqual(counted, listed, "a file that starts a timer (or one more timer than listed) must be added to TIMERS with how the organization block applies to it");
  for (const { why } of Object.values(TIMERS)) assert.ok(why && why.length > 20);
  // Timers under another name, endless loops, and scheduler libraries.
  const sources = allSources();
  assert.deepEqual(sources.filter((file) => /timers\/promises|node-cron|node-schedule|\bcron\.schedule\(|scheduleJob\(/.test(read(file))), [], "a scheduler under another name must be listed like a timer");
  const endless = (node) => (ts.isWhileStatement(node) || ts.isDoStatement(node)) ? node.expression.kind === ts.SyntaxKind.TrueKeyword || node.expression.getText() === "1" : ts.isForStatement(node) && !node.condition;
  assert.deepEqual(Object.fromEntries(sources.map((file) => [file, nodesOf(parse(file), endless).length]).filter(([, count]) => count > 0)), Object.fromEntries(Object.keys(LOOPS).map((file) => [file, 1])), "a loop with no end condition may be scheduled work: it must skip blocked organizations and be listed in LOOPS");
  const packages = JSON.parse(read("package.json"));
  const schedulers = ["node-cron", "cron", "node-schedule", "agenda", "bree", "toad-scheduler", "bull", "pg-boss", "bottleneck", "ws", "socket.io"];
  assert.deepEqual(Object.keys({ ...packages.dependencies, ...packages.devDependencies }).filter((name) => schedulers.includes(name)), [], "a scheduler or socket library brings its own way to act without a request: extend this guard for it");
  assert.doesNotMatch(read("ecosystem.config.js"), /cron_restart/);
});

test("the starters are called only where listed, and the cron starter schedules only listed jobs, whatever they are named", () => {
  for (const [starter, files] of Object.entries(STARTERS)) {
    assert.deepEqual(allSources().filter((file) => nodesOf(parse(file), (node) => ts.isIdentifier(node) && node.text === starter && !ts.isImportSpecifier(node.parent)).length > 0), files, `${starter} is referenced from a new place`);
  }
  // Every name the cron starter mentions is a listed job or a timer function: a job passed by
  // reference (`setInterval(job, ms)`) or called under any name is seen.
  const starter = functionNamed("utils/cronJobs.ts", "startCronJobs");
  const mentioned = [...new Set(nodesOf(starter.body, ts.isIdentifier).map((node) => node.text))].filter((name) => !TIMER_FUNCTIONS.includes(name)).sort();
  assert.deepEqual(mentioned, Object.keys(CRON_JOBS).sort(), "a job added to startCronJobs must be added to CRON_JOBS with where its block check is");
  assert.equal(nodesOf(starter.body, (node) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)).length, 0, "the cron starter calls only listed jobs, by name");
  // Every function of utils/cronJobs.ts is a listed job or helper.
  const tree = parse("utils/cronJobs.ts");
  const functions = tree.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations.filter((d) => d.initializer && isFunction(d.initializer)).map((d) => d.name.getText())
    : ts.isFunctionDeclaration(statement) ? [statement.name.getText()] : []);
  assert.deepEqual(functions.sort(), [...Object.keys(CRON_JOBS), ...Object.keys(CRON_HELPERS)].sort(), "a function added to utils/cronJobs.ts must be listed in CRON_JOBS (or CRON_HELPERS)");
  assert.deepEqual([...importsOf("utils/cronJobs.ts").values()].map((entry) => entry.module).filter((module_) => !["./notificationService", "../modal/proposalsModel", "../modal/settingsModel", "../src/modules/proposalLifecycle/composition", "../src/modules/organizationBlock/organizationBlockGate"].includes(module_)), [], "a new static import of utils/cronJobs.ts is a new thing its jobs can run: check it against the block");

  for (const [name, entry] of Object.entries(CRON_JOBS)) {
    const body = functionNamed("utils/cronJobs.ts", name).body;
    const dynamicImports = callsIn(body).filter((call) => call.expression.kind === ts.SyntaxKind.ImportKeyword).map((call) => literal(call.arguments[0]));
    if (entry.self) {
      // The job's own body reads the blocked set and skips those organizations.
      assert.deepEqual(dynamicImports, entry.imports, `${name} imports something that is not listed for it`);
      assert.match(body.getText(), /const blocked = await blockedOrganizationIds\(\);/, `${name} must read the blocked organizations`);
      assert.match(body.getText(), /blocked\.has\(String\((proposal|doc)\.organizationId/, `${name} must skip blocked organizations`);
      continue;
    }
    // The job runs exactly what is listed for it, from the one module listed for it.
    assert.deepEqual(dynamicImports, [entry.from], `${name} imports something other than ${entry.from}`);
    const bound = nodesOf(body, ts.isBindingElement).filter((element) => ts.isObjectBindingPattern(element.parent) && ts.isVariableDeclaration(element.parent.parent) && element.parent.parent.initializer && /import\(/.test(element.parent.parent.initializer.getText())).map((element) => element.name.getText());
    const roots = [...new Set(entry.runs.map((run) => run.split(".")[0]))].sort();
    assert.deepEqual(bound.sort(), roots, `${name} takes something else from ${entry.from}`);
    const ran = [...new Set(callsIn(body).map((call) => dotted(call.expression)).filter((callee) => callee !== null && roots.includes(callee.split(".")[0])))].sort();
    assert.deepEqual(ran, [...entry.runs].sort(), `${name} runs something that is not listed for it`);
    if (entry.exempt) assert.match(entry.exempt, /^EXEMPT: /);
    else assert.ok(SWEEPS[entry.sweep], `${name}: no sweep is listed for it`);
  }
  // The support desk schedule can run only the sweeper it is handed.
  const schedule = "src/modules/supportDesk/infrastructure/scheduler/supportDeskSchedule.ts";
  assert.deepEqual([...importsOf(schedule).values()].map((entry) => entry.module).sort(), ["../../application/supportDeskSweeper", "../redis/supportRedis"]);
  assert.deepEqual(nodesOf(parse(schedule), (node) => ts.isIdentifier(node) && node.text === "sweeper" && !ts.isParameter(node.parent)).map((node) => node.parent.getText()), ["sweeper.run"]);
  assert.match(read("server.ts"), /startSupportDeskSweeper\(supportDeskSweeper\);/);
});

test("every sweep function gives the blocked organizations to each batch read it makes, and each batch query leaves them out", () => {
  for (const [name, sweep] of Object.entries(SWEEPS)) {
    const fn = functionNamed(sweep.file, sweep.fn);
    const body = fn.body.getText();
    if (sweep.enumerates) {
      // Enumerates the organizations itself: blocked ones are dropped from the list it walks.
      assert.match(body, sweep.enumerates, `${name}: ${sweep.fn} must leave blocked organizations out of the list it walks`);
      const exported = parse(sweep.file).statements.filter((statement) => ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap((statement) => statement.declarationList.declarations.map((d) => d.name.getText())).sort();
      assert.deepEqual(exported, sweep.exports, `${name}: a new export of ${sweep.file} must be checked against the block and listed`);
      continue;
    }
    assert.match(body, /blockedOrganizationIds\?\.\(\)/, `${name}: ${sweep.fn} must read the blocked organizations`);
    // Every call on the repository port inside the sweep function is a listed one.
    // (a call chained on a port call's result, `.catch(...)`, is not itself a port call)
    const portCalls = callsIn(fn.body).filter((call) => (dotted(call.expression) ?? "").startsWith(sweep.port));
    const seen = new Set();
    for (const call of portCalls) {
      const method = dotted(call.expression).slice(sweep.port.length);
      seen.add(method);
      const kind = sweep.calls[method];
      assert.ok(kind, `${name}: ${sweep.fn} calls ${sweep.port}${method}, which is not listed in SWEEPS: say whether it reads across organizations`);
      if (kind === "excluded") assert.match(call.arguments.map((argument) => argument.getText()).join(", "), /\bexceptOrganizationIds\b|\[\.\.\.blocked\]/, `${name}: ${sweep.port}${method} must be given the blocked organization ids`);
    }
    assert.deepEqual([...seen].sort(), Object.keys(sweep.calls).sort(), `${name}: SWEEPS lists a call ${sweep.fn} no longer makes`);
    for (const reason of Object.values(sweep.calls)) assert.ok(reason === "excluded" || reason.length > 20);
    // The excluded reads put the ids in their query.
    for (const method of sweep.queries.methods) {
      const query = functionNamed(sweep.queries.file, method).body.getText();
      assert.match(query, /\.\.\.(exceptOrganizations|except)\(exceptOrganizationIds\)/, `${name}: ${sweep.queries.file} ${method} must exclude the organizations in its query`);
    }
    assert.deepEqual(Object.entries(sweep.calls).filter(([, kind]) => kind === "excluded").map(([method]) => method).sort(), [...sweep.queries.methods].sort(), `${name}: every excluded read has its query checked`);
    // The real gate is wired in.
    assert.match(read(sweep.wiredIn), /blockedOrganizationIds,/, `${name}: ${sweep.wiredIn} must pass blockedOrganizationIds`);
  }
  // The files that hold a sweep export only what is listed: a second sweep is a new export.
  const exportsOf = (file) => parse(file).statements.filter((statement) => ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap((statement) => statement.declarationList.declarations.map((d) => d.name.getText())).sort();
  assert.deepEqual(exportsOf("src/modules/supportDesk/application/supportDeskSweeper.ts"), ["createSupportDeskSweeper"]);
  assert.deepEqual(exportsOf("src/modules/invitations/application/sweepInvitations.ts"), ["DELIVERY_RETRY_AFTER_MS", "createInvitationSweep"]);
  // The sweeper object has one entry point.
  const sweeper = functionNamed("src/modules/supportDesk/application/supportDeskSweeper.ts", "createSupportDeskSweeper");
  const returned = nodesOf(sweeper.body, ts.isReturnStatement).filter((node) => node.expression && ts.isObjectLiteralExpression(node.expression) && node.parent === sweeper.body);
  assert.deepEqual(returned.flatMap((node) => node.expression.properties.map((property) => property.name.getText())), ["run"]);
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
