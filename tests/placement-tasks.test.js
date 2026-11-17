require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { PlacementError } = require("../src/modules/tenancy/legacyCustomerPlacement");
const { createPlacementTaskService, placementRunView, placementTaskPolicyFromEnv } = require("../src/modules/tenancy/placementTasks");
const {
  assertPlacementTaskConfig,
  buildRunTaskInput,
  createEcsPlacementTaskLauncher,
  placementTaskCommand,
  placementTaskConfigFromEnv,
  PlacementTaskConfigError,
} = require("../src/modules/tenancy/placementTaskLauncher");

// ORG-110 on production: the API queues a placement or rollback and starts it as a one-off task
// on the migrate task definition (owner's decision, 2026-11-17). In-memory journal and a fake
// launcher here; the journal's real unique indexes, the task's side and the HTTP routes are
// proven in tests-integration/legacy-customer-placement-tasks.test.ts.

const hex = (c) => c.repeat(24);
const ANA = hex("a");
const BEN = hex("b");
const HOLDING = hex("c");
const TARGET = hex("d");
const STAFF = hex("7");
const STAFF_ORG = hex("8");
const START = new Date("2026-11-17T09:00:00.000Z");
const actor = { adminUserId: STAFF, adminOrganizationId: STAFF_ORG, correlationId: "corr-1" };
const existing = { kind: "existing", organizationId: TARGET, role: "planner", teamId: null };

// The journal's rules as the real store enforces them with unique indexes: one in-flight run per
// user, one run per idempotency key, one task per slot.
const memoryStore = () => {
  const rows = new Map();
  const copy = (row) => (row ? structuredClone(row) : null);
  const matches = (row, expect) => {
    const among = (value, wanted) => wanted === undefined || (Array.isArray(wanted) ? wanted.includes(value) : value === wanted);
    return row.task?.requestedAt.getTime() === expect.taskRequestedAt.getTime() && among(row.state, expect.state) && among(row.task?.status, expect.taskStatus);
  };
  const freeSlot = (max) => {
    const taken = new Set([...rows.values()].filter((row) => row.taskSlot !== undefined).map((row) => row.taskSlot));
    for (let slot = 0; slot < max; slot++) if (!taken.has(slot)) return slot;
    return null;
  };
  return {
    rows,
    async find(runId) { return copy(rows.get(runId)); },
    async findByIdempotencyKey(key) { return copy([...rows.values()].find((row) => row.idempotencyKey === key)); },
    async findActiveTasks() { return [...rows.values()].filter((row) => ["queued", "running"].includes(row.task?.status)).map(copy); },
    async queuePlacement(entry, max) {
      if ([...rows.values()].some((row) => row.inFlight && row.userId === entry.userId)) return { queued: false, refusal: "user_busy" };
      if (entry.idempotencyKey && [...rows.values()].some((row) => row.idempotencyKey === entry.idempotencyKey)) return { queued: false, refusal: "idempotency_key" };
      const slot = freeSlot(max);
      if (slot === null) return { queued: false, refusal: "capacity" };
      rows.set(entry.runId, { ...copy(entry), taskSlot: slot });
      return { queued: true };
    },
    async queueRollback(runId, task, max) {
      const row = rows.get(runId);
      if (!row || !["done", "failed"].includes(row.state)) return { queued: false, refusal: "state" };
      const slot = freeSlot(max);
      if (slot === null) return { queued: false, refusal: "capacity" };
      Object.assign(row, { rollbackFrom: row.state, state: "rolling_back", inFlight: true, taskSlot: slot, task: copy(task) });
      return { queued: true };
    },
    async update(runId, expect, change) {
      const row = rows.get(runId);
      if (!row || !matches(row, expect)) return false;
      if (change.state !== undefined) row.state = change.state;
      if (change.error !== undefined) row.error = change.error;
      Object.assign(row.task, change.task ?? {});
      if (change.release) { delete row.inFlight; delete row.taskSlot; }
      if (change.clearRollbackFrom) delete row.rollbackFrom;
      return true;
    },
  };
};

const setup = (options = {}) => {
  const store = memoryStore();
  const launches = [];
  const clock = { now: new Date(START) };
  const state = { launchError: null, refusal: null, rollbackRefusal: null };
  let sequence = 0;
  const service = createPlacementTaskService({
    store,
    launcher: {
      async launch(input) {
        if (state.launchError) throw state.launchError;
        launches.push(input);
        return { taskArn: `arn:aws:ecs:us-east-2:111111111111:task/rfpilot-production/${launches.length}` };
      },
    },
    async validatePlacement(userId, target) {
      if (state.refusal) throw state.refusal;
      return { holdingOrganizationId: HOLDING, previousVersion: 2, targetOrganizationId: TARGET, createdOrganization: target.kind === "new", role: target.kind === "new" ? "owner" : target.role, teamId: null, target };
    },
    async assertRollbackAllowed() {
      if (state.rollbackRefusal) throw state.rollbackRefusal;
    },
    newRunId: () => `placement-2026-11-17T09:00:00.000Z-0000000${++sequence}`,
    now: () => new Date(clock.now),
    policy: options.policy,
  });
  const advance = (ms) => { clock.now = new Date(clock.now.getTime() + ms); };
  // What the task does to the journal as it works (the real one is placementTaskRunner.ts).
  const task = {
    claim(runId) { Object.assign(store.rows.get(runId).task, { status: "running", startedAt: new Date(clock.now), heartbeatAt: new Date(clock.now) }); },
    beat(runId) { store.rows.get(runId).task.heartbeatAt = new Date(clock.now); },
    journal(runId, journalState) { store.rows.get(runId).state = journalState; if (journalState !== "started") delete store.rows.get(runId).inFlight; },
    finish(runId, status, journalState) {
      const row = store.rows.get(runId);
      if (journalState) row.state = journalState;
      Object.assign(row.task, { status, finishedAt: new Date(clock.now) });
      delete row.inFlight; delete row.taskSlot; delete row.rollbackFrom;
    },
  };
  return { service, store, launches, state, advance, task };
};

const refused = async (promise, code, status) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PlacementError, String(error));
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
  });
};

test("a placement request is journaled as queued and starts exactly one task with only the run id", async () => {
  const { service, store, launches } = setup();
  const { run, replayed } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  assert.equal(replayed, false);
  assert.equal(run.status, "queued");
  assert.equal(run.operation, "placement");
  assert.equal(run.state, "queued");
  assert.equal(run.userId, ANA);
  assert.equal(run.targetOrganizationId, TARGET);
  assert.equal(run.task.status, "queued");
  assert.match(run.task.taskArn, /^arn:aws:ecs:/);
  assert.equal(launches.length, 1);
  assert.deepEqual(Object.keys(launches[0]).sort(), ["launchToken", "runId"], "nothing from the request reaches the launcher");
  assert.equal(launches[0].runId, run.runId);
  // The staff member travels in the journal entry the task reads, not on the command line.
  const row = store.rows.get(run.runId);
  assert.deepEqual([row.task.adminUserId, row.task.adminOrganizationId, row.task.correlationId], [STAFF, STAFF_ORG, "corr-1"]);
  assert.deepEqual(row.request.target, existing);
  // The API's own bookkeeping is not in what the client sees.
  for (const key of ["request", "idempotencyKey", "taskSlot", "inFlight"]) assert.ok(!(key in run), key);
});

test("the synchronous path's refusals are returned unchanged and nothing is queued or started", async () => {
  for (const [code, status] of [["USER_NOT_FOUND", 404], ["NOT_A_LEGACY_CUSTOMER", 409], ["ORGANIZATION_NOT_FOUND", 404], ["INVALID_ROLE", 400], ["ALREADY_A_MEMBER", 409], ["UNKNOWN_TEAM", 400], ["ORGANIZATION_NAME_REQUIRED", 400], ["INVALID_ORGANIZATION_TYPE", 400]]) {
    const { service, store, launches, state } = setup();
    state.refusal = new PlacementError(code, "refused", status);
    await refused(service.requestPlacement({ userId: ANA, target: existing, actor }), code, status);
    assert.equal(store.rows.size, 0, code);
    assert.equal(launches.length, 0, code);
  }
});

test("one placement per user at a time, and a global cap, both refused before any task starts", async () => {
  const { service, launches, task } = setup();
  const first = (await service.requestPlacement({ userId: ANA, target: existing, actor })).run;
  await refused(service.requestPlacement({ userId: ANA, target: existing, actor }), "PLACEMENT_IN_PROGRESS", 409);
  await refused(service.requestPlacement({ userId: BEN, target: existing, actor }), "PLACEMENT_CAPACITY_REACHED", 429);
  assert.equal(launches.length, 1);
  // Once the task has finished, the next customer can be placed.
  task.claim(first.runId);
  task.finish(first.runId, "succeeded", "done");
  const second = (await service.requestPlacement({ userId: BEN, target: existing, actor })).run;
  assert.equal(second.status, "queued");
  assert.equal(launches.length, 2);
});

test("a higher cap lets that many tasks run, and no more", async () => {
  const { service, launches } = setup({ policy: { maxConcurrent: 2 } });
  await service.requestPlacement({ userId: ANA, target: existing, actor });
  await service.requestPlacement({ userId: BEN, target: existing, actor });
  await refused(service.requestPlacement({ userId: hex("e"), target: existing, actor }), "PLACEMENT_CAPACITY_REACHED", 429);
  assert.equal(launches.length, 2);
});

test("the same Idempotency-Key returns the same run and starts no second task", async () => {
  const { service, launches, task } = setup();
  const first = await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "key-1" });
  const again = await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "key-1" });
  assert.equal(again.replayed, true);
  assert.equal(again.run.runId, first.run.runId);
  assert.equal(launches.length, 1);
  // Still the same run after it has finished, when a fresh request would be refused.
  task.claim(first.run.runId);
  task.finish(first.run.runId, "succeeded", "done");
  const later = await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "key-1" });
  assert.equal(later.replayed, true);
  assert.equal(later.run.status, "succeeded");
  assert.equal(launches.length, 1);
  // The key belongs to that request.
  await refused(service.requestPlacement({ userId: BEN, target: existing, actor, idempotencyKey: "key-1" }), "IDEMPOTENCY_KEY_REUSED", 409);
  await refused(service.requestPlacement({ userId: ANA, target: { ...existing, role: "team_manager" }, actor, idempotencyKey: "key-1" }), "IDEMPOTENCY_KEY_REUSED", 409);
  await refused(service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "has space" }), "INVALID_IDEMPOTENCY_KEY", 400);
  assert.equal(launches.length, 1);
});

test("two requests with one key that race to the journal start one task", async () => {
  const { service, store, launches } = setup();
  // The second request passed the first lookup before the first request's entry existed.
  const lookup = store.findByIdempotencyKey;
  let misses = 1;
  store.findByIdempotencyKey = async (key) => (misses-- > 0 ? null : lookup(key));
  const first = await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "race" });
  misses = 1;
  const second = await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "race" });
  assert.equal(second.replayed, true);
  assert.equal(second.run.runId, first.run.runId);
  assert.equal(launches.length, 1);
});

test("a task that can't be started fails the request, moves nothing and frees the user and the slot", async () => {
  const { service, store, launches, state } = setup();
  state.launchError = new Error("AccessDeniedException: not authorized to perform ecs:RunTask");
  await refused(service.requestPlacement({ userId: ANA, target: existing, actor }), "PLACEMENT_TASK_START_FAILED", 503);
  const [row] = [...store.rows.values()];
  assert.equal(row.state, "aborted");
  assert.equal(row.task.status, "failed");
  assert.equal(row.task.code, "PLACEMENT_TASK_START_FAILED");
  assert.equal(row.inFlight, undefined);
  assert.equal(row.taskSlot, undefined);
  const view = await service.getRun(row.runId);
  assert.equal(view.status, "failed");
  assert.equal(view.rollbackRequired, false);
  state.launchError = null;
  assert.equal((await service.requestPlacement({ userId: ANA, target: existing, actor })).run.status, "queued");
  assert.equal(launches.length, 1);
});

test("a queued task that never starts is given up on when the run is read, and the user can be placed again", async () => {
  const { service, store, launches, advance } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  advance(9 * 60_000);
  assert.equal((await service.getRun(run.runId)).status, "queued", "still inside the start timeout");
  advance(2 * 60_000);
  const view = await service.getRun(run.runId);
  assert.equal(view.status, "failed");
  assert.equal(view.state, "aborted");
  assert.equal(view.task.code, "PLACEMENT_TASK_NOT_STARTED");
  assert.equal(view.rollbackRequired, false);
  assert.equal(store.rows.get(run.runId).inFlight, undefined);
  assert.equal(store.rows.get(run.runId).taskSlot, undefined);
  assert.equal((await service.requestPlacement({ userId: ANA, target: existing, actor })).run.status, "queued");
  assert.equal(launches.length, 2);
});

test("a stuck run is also given up on by the next request, so it can't block everyone", async () => {
  const { service, advance } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  advance(11 * 60_000);
  assert.equal((await service.requestPlacement({ userId: BEN, target: existing, actor })).run.status, "queued");
  assert.equal((await service.getRun(run.runId)).task.code, "PLACEMENT_TASK_NOT_STARTED");
});

test("a running task is kept while it heartbeats and given up on when it stops", async () => {
  const { service, task, advance } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  task.claim(run.runId);
  task.journal(run.runId, "started");
  for (let i = 0; i < 20; i++) {
    advance(60_000);
    task.beat(run.runId);
    assert.equal((await service.getRun(run.runId)).status, "running");
  }
  advance(3 * 60_000 + 1);
  const view = await service.getRun(run.runId);
  // Not yet `done`, so the MongoDB transaction never committed and Postgres never did.
  assert.equal(view.status, "failed");
  assert.equal(view.state, "aborted");
  assert.equal(view.task.code, "PLACEMENT_TASK_LOST");
  assert.equal(view.rollbackRequired, false);
});

test("a task lost after the move but before its checks leaves a run that must be rolled back", async () => {
  const { service, task, advance, launches } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  task.claim(run.runId);
  task.journal(run.runId, "done");
  advance(4 * 60_000);
  const view = await service.getRun(run.runId);
  assert.equal(view.status, "failed");
  assert.equal(view.state, "failed");
  assert.equal(view.rollbackRequired, true);
  assert.equal(view.task.code, "PLACEMENT_TASK_LOST");
  assert.equal(view.task.details.rollbackRequired, true);
  // And it can be: `failed` is a state a rollback starts from.
  const rollback = await service.requestRollback({ runId: run.runId, actor });
  assert.equal(rollback.run.operation, "rollback");
  assert.equal(rollback.run.status, "queued");
  assert.equal(launches.length, 2);
});

test("giving up never overwrites a task that finished in the meantime", async () => {
  const { service, store, task, advance } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  task.claim(run.runId);
  task.journal(run.runId, "started");
  advance(4 * 60_000);
  // The task commits between the API reading the stale run and writing its verdict.
  const update = store.update;
  store.update = async (...args) => {
    task.finish(run.runId, "succeeded", "done");
    store.update = update;
    return update(...args);
  };
  const view = await service.getRun(run.runId);
  assert.equal(view.status, "succeeded");
  assert.equal(view.task.status, "succeeded");
  assert.equal(view.task.code, null);
});

test("rollback: refusals as before, one at a time, and one task per request", async () => {
  const { service, store, launches, state, task } = setup();
  await refused(service.requestRollback({ runId: "placement-2026-11-17T09:00:00.000Z-ffffffff", actor }), "PLACEMENT_NOT_FOUND", 404);
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  await refused(service.requestRollback({ runId: run.runId, actor }), "PLACEMENT_IN_PROGRESS", 409);
  task.claim(run.runId);
  task.journal(run.runId, "started");
  await refused(service.requestRollback({ runId: run.runId, actor }), "PLACEMENT_IN_PROGRESS", 409);
  task.finish(run.runId, "succeeded", "done");

  for (const code of ["ORGANIZATION_IN_USE", "USER_IS_OWNER"]) {
    state.rollbackRefusal = new PlacementError(code, "refused", 409);
    await refused(service.requestRollback({ runId: run.runId, actor }), code, 409);
    assert.equal(store.rows.get(run.runId).state, "done", "a refused rollback claims nothing");
  }
  state.rollbackRefusal = null;

  const other = { adminUserId: hex("9"), adminOrganizationId: STAFF_ORG, correlationId: "corr-2" };
  const queued = await service.requestRollback({ runId: run.runId, actor: other, idempotencyKey: "rb-1" });
  assert.equal(queued.run.status, "queued");
  assert.equal(queued.run.operation, "rollback");
  assert.equal(queued.run.state, "rolling_back");
  assert.equal(store.rows.get(run.runId).task.adminUserId, hex("9"), "the rollback is audited as whoever asked for it");
  assert.equal(launches.length, 2);
  assert.notEqual(launches[1].launchToken, launches[0].launchToken);
  await refused(service.requestRollback({ runId: run.runId, actor }), "ROLLBACK_IN_PROGRESS", 409);
  assert.equal((await service.requestRollback({ runId: run.runId, actor: other, idempotencyKey: "rb-1" })).replayed, true);
  await refused(service.requestPlacement({ userId: BEN, target: existing, actor }), "PLACEMENT_CAPACITY_REACHED", 429);
  assert.equal(launches.length, 2);

  task.claim(run.runId);
  task.finish(run.runId, "succeeded", "rolled_back");
  assert.equal((await service.getRun(run.runId)).status, "rolled_back");
  await refused(service.requestRollback({ runId: run.runId, actor }), "ALREADY_ROLLED_BACK", 409);
});

test("rollback of a run that never moved anything is refused", async () => {
  const { service, state } = setup();
  state.launchError = new Error("boom");
  await assert.rejects(service.requestPlacement({ userId: ANA, target: existing, actor }));
  const runId = "placement-2026-11-17T09:00:00.000Z-00000001";
  await refused(service.requestRollback({ runId, actor }), "NOTHING_TO_ROLL_BACK", 409);
});

test("a rollback task that is lost or never starts leaves the placement as it was", async () => {
  for (const claimed of [false, true]) {
    const { service, store, task, advance } = setup();
    const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
    task.claim(run.runId);
    task.finish(run.runId, "succeeded", "done");
    await service.requestRollback({ runId: run.runId, actor });
    if (claimed) task.claim(run.runId);
    advance(11 * 60_000);
    const view = await service.getRun(run.runId);
    assert.equal(view.status, "succeeded", "the placement still stands");
    assert.equal(view.state, "done");
    assert.equal(view.task.operation, "rollback");
    assert.equal(view.task.status, "failed");
    assert.equal(view.task.code, claimed ? "ROLLBACK_TASK_LOST" : "ROLLBACK_TASK_NOT_STARTED");
    const row = store.rows.get(run.runId);
    assert.deepEqual([row.inFlight, row.taskSlot, row.rollbackFrom], [undefined, undefined, undefined]);
    // And it can be asked for again.
    assert.equal((await service.requestRollback({ runId: run.runId, actor })).run.status, "queued");
  }
});

test("run view: status follows the journal; a run made by the synchronous path has no task", () => {
  const base = { runId: "r", userId: ANA, holdingOrganizationId: HOLDING, targetOrganizationId: TARGET, createdOrganization: false, role: "planner", adminUserId: STAFF, adminOrganizationId: STAFF_ORG, createdAt: START, updatedAt: START };
  const expected = { queued: "queued", started: "running", done: "succeeded", failed: "failed", aborted: "failed", rolling_back: "running", rolled_back: "rolled_back" };
  for (const [state, status] of Object.entries(expected)) {
    const view = placementRunView({ ...base, state });
    assert.equal(view.status, status, state);
    assert.equal(view.task, null);
    assert.equal(view.rollbackRequired, state === "failed");
  }
});

/* ── What is handed to ECS ─────────────────────────────────────────────────────────────────── */

const config = {
  cluster: "rfpilot-production",
  taskDefinition: "arn:aws:ecs:us-east-2:111111111111:task-definition/rfpilot-production-migrate:42",
  subnets: ["subnet-0123456789abcdef0", "subnet-0fedcba9876543210"],
  securityGroup: "sg-0123456789abcdef0",
  container: "migrate",
};
const RUN = "placement-2026-11-17T09:00:00.000Z-ab12cd34";
const TOKEN = "f".repeat(64);

test("the task is started on the migrate task definition with a fixed command list", () => {
  const input = buildRunTaskInput(config, { runId: RUN, launchToken: TOKEN });
  assert.equal(input.taskDefinition, config.taskDefinition);
  assert.equal(input.cluster, "rfpilot-production");
  assert.equal(input.launchType, "FARGATE");
  assert.equal(input.count, 1);
  assert.equal(input.clientToken, TOKEN);
  assert.deepEqual(input.networkConfiguration.awsvpcConfiguration, { subnets: config.subnets, securityGroups: [config.securityGroup], assignPublicIp: "DISABLED" });
  const [override] = input.overrides.containerOverrides;
  assert.equal(input.overrides.containerOverrides.length, 1);
  assert.equal(override.name, "migrate");
  // Discrete arguments, no shell, and nothing but the run id varies.
  assert.deepEqual(override.command, ["node", "dist/scripts/placeLegacyCustomer.js", `--task-run=${RUN}`]);
  assert.deepEqual(override.environment, [{ name: "PGOPTIONS", value: "-c lock_timeout=15000" }]);
  // No role, image, CPU or memory override: the task runs as the migrate task definition says.
  assert.deepEqual(Object.keys(input.overrides), ["containerOverrides"]);
  assert.deepEqual(Object.keys(override).sort(), ["command", "environment", "name"]);
});

test("a run id that isn't one of ours is never put on a command line", () => {
  const hostile = [
    "", "x", `${RUN}; rm -rf /`, `${RUN} --rollback=other`, `${RUN}\n--apply`, "$(curl evil)", "`id`", "placement-2026-11-17T09:00:00.000Z-AB12CD34",
    "--email=victim@example.com", `${RUN}&&true`, "../../etc/passwd", null, undefined, 42, ["a"], { runId: RUN },
  ];
  for (const runId of hostile) {
    assert.throws(() => placementTaskCommand(runId), PlacementTaskConfigError, JSON.stringify(runId));
    assert.throws(() => buildRunTaskInput(config, { runId, launchToken: TOKEN }), PlacementTaskConfigError, JSON.stringify(runId));
  }
  assert.throws(() => buildRunTaskInput(config, { runId: RUN, launchToken: "not-a-token" }), PlacementTaskConfigError);
});

test("only the migrate task definition can be started, in a well-formed network", () => {
  const bad = [
    { taskDefinition: "arn:aws:ecs:us-east-2:111111111111:task-definition/rfpilot-production-api:7" },
    { taskDefinition: "rfpilot-production-worker" },
    { taskDefinition: "arn:aws:ecs:us-east-2:111111111111:task-definition/rfpilot-production-migrate-evil:1" },
    { taskDefinition: "someone-elses-task" },
    { taskDefinition: "rfpilot-production-migrate:1 --overrides {}" },
    { cluster: "rfpilot production" },
    { subnets: [] },
    { subnets: ["subnet-0123456789abcdef0", "0.0.0.0/0"] },
    { securityGroup: "sg-0123456789abcdef0,sg-00000000000000000" },
    { container: "migrate; sh" },
  ];
  for (const override of bad) assert.throws(() => assertPlacementTaskConfig({ ...config, ...override }), PlacementTaskConfigError, JSON.stringify(override));
  assert.doesNotThrow(() => assertPlacementTaskConfig({ ...config, taskDefinition: "rfpilot-production-migrate" }));
});

test("task settings come from the environment: all, or none", () => {
  assert.equal(placementTaskConfigFromEnv({}), null);
  const env = {
    PLACEMENT_TASK_CLUSTER: config.cluster, PLACEMENT_TASK_DEFINITION: config.taskDefinition, PLACEMENT_TASK_SUBNETS: config.subnets.join(","),
    PLACEMENT_TASK_SECURITY_GROUP: config.securityGroup, PLACEMENT_TASK_CONTAINER: "migrate",
  };
  assert.deepEqual(placementTaskConfigFromEnv(env), { ...config, region: "us-east-2" });
  assert.throws(() => placementTaskConfigFromEnv({ ...env, PLACEMENT_TASK_SECURITY_GROUP: "" }), /incomplete: PLACEMENT_TASK_SECURITY_GROUP/);
  assert.throws(() => placementTaskConfigFromEnv({ ...env, PLACEMENT_TASK_DEFINITION: "rfpilot-production-api" }), PlacementTaskConfigError);
  assert.deepEqual(placementTaskPolicyFromEnv({}), { maxConcurrent: 1, startTimeoutMs: 600_000, heartbeatTimeoutMs: 180_000 });
  assert.equal(placementTaskPolicyFromEnv({ PLACEMENT_TASK_MAX_CONCURRENT: "3" }).maxConcurrent, 3);
  assert.equal(placementTaskPolicyFromEnv({ PLACEMENT_TASK_MAX_CONCURRENT: "500" }).maxConcurrent, 1, "an absurd cap is ignored");
});

test("the launcher sends one RunTask and reports a task ECS did not start as a failure", async () => {
  const sent = [];
  const client = (response) => ({ async send(command) { sent.push(command); return response; } });
  const started = await createEcsPlacementTaskLauncher(config, client({ tasks: [{ taskArn: "arn:aws:ecs:us-east-2:111111111111:task/rfpilot-production/abc" }], failures: [] }))
    .launch({ runId: RUN, launchToken: TOKEN });
  assert.equal(started.taskArn, "arn:aws:ecs:us-east-2:111111111111:task/rfpilot-production/abc");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].constructor.name, "RunTaskCommand");
  assert.deepEqual(sent[0].input, buildRunTaskInput(config, { runId: RUN, launchToken: TOKEN }));
  await assert.rejects(
    createEcsPlacementTaskLauncher(config, client({ tasks: [], failures: [{ reason: "RESOURCE:MEMORY" }] })).launch({ runId: RUN, launchToken: TOKEN }),
    /ECS did not start the task: RESOURCE:MEMORY/,
  );
  await assert.rejects(createEcsPlacementTaskLauncher(config, client({ tasks: [] })).launch({ runId: `${RUN};id`, launchToken: TOKEN }), PlacementTaskConfigError);
  assert.equal(sent.length, 2, "a hostile run id never reaches ECS");
});

/* ── Staff only ────────────────────────────────────────────────────────────────────────────── */

test("every placement route sits behind the staff guard", () => {
  const router = require("../routes/adminLegacyCustomersRoute").default;
  const firstRoute = router.stack.findIndex((layer) => layer.route);
  const guards = router.stack.slice(0, firstRoute);
  assert.equal(guards.length, 2, "authenticate, then authorize, before any route");
  assert.ok(router.stack.slice(firstRoute).every((layer) => layer.route), "no route is registered ahead of the guards");
  assert.deepEqual(
    router.stack.slice(firstRoute).map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`),
    ["GET /", "GET /target-organizations", "POST /:userId/placements", "GET /placements/:runId", "POST /placements/:runId/rollback"],
  );
  const authorize = guards[1].handle;
  const attempt = (user) => {
    const res = { code: null, status(code) { this.code = code; return this; }, json() { return this; } };
    let passed = false;
    authorize({ user }, res, () => { passed = true; });
    return passed ? "passed" : res.code;
  };
  assert.equal(attempt(undefined), 401);
  for (const roles of [["owner"], ["organization_admin"], ["team_manager"], ["planner"], ["viewer"], []]) assert.equal(attempt({ roles }), 403, roles.join());
  assert.equal(attempt({ roles: ["dxg_admin"] }), "passed");
});
