require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { PlacementError } = require("../src/modules/tenancy/legacyCustomerPlacement");
const { createPlacementTaskService, placementRunView, placementTaskPolicyFromEnv, PlacementTaskSettingsError, unfinishedPlacementOutcome } = require("../src/modules/tenancy/placementTasks");
const {
  buildStartExecutionInput,
  createPlacementTaskLauncher,
  placementTaskRunIdFromArgv,
  placementTaskConfigFromEnv,
  PlacementTaskConfigError,
} = require("../src/modules/tenancy/placementTaskLauncher");

// ORG-110 on production: the API queues a placement or rollback and starts an execution of the
// placement state machine, which runs the task (owner's decision, 2026-11-17). In-memory journal
// and a fake launcher here; the journal's real unique indexes, the task's side and the HTTP
// routes are proven in tests-integration/legacy-customer-placement-tasks.test.ts.

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
      if (!row || !["done", "failed"].includes(row.state) || ["queued", "running"].includes(row.task?.status)) return { queued: false, refusal: "state" };
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
      if (change.releaseIdempotencyKey) delete row.idempotencyKey;
      return true;
    },
  };
};

const setup = (options = {}) => {
  const store = memoryStore();
  const launches = [];
  const clock = { now: new Date(START) };
  const state = { launchError: null, refusal: null, rollbackRefusal: null };
  const logs = [];
  const described = [];
  let sequence = 0;
  const service = createPlacementTaskService({
    store,
    launcher: {
      async launch(input) {
        if (state.launchError) throw state.launchError;
        launches.push(input);
      },
      async describe(input) {
        described.push(input.launchToken);
        return { status: "FAILED", error: "States.TaskFailed", cause: "arn:aws:ecs:us-east-2:111111111111:task/x stoppedReason: CannotPullContainerError" };
      },
    },
    log: (event, fields) => logs.push({ event, ...fields }),
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
  return { service, store, launches, state, advance, task, logs, described };
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
  // Nothing that names the AWS account or a resource is shown to staff.
  assert.ok(!JSON.stringify(run).includes("arn:"));
  assert.ok(!("taskArn" in run.task));
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
  // And to that staff member: a colleague who happens to send the same key makes a new request.
  const colleague = { adminUserId: hex("9"), adminOrganizationId: STAFF_ORG, correlationId: "corr-9" };
  const theirs = await service.requestPlacement({ userId: BEN, target: existing, actor: colleague, idempotencyKey: "key-1" });
  assert.equal(theirs.replayed, false);
  assert.notEqual(theirs.run.runId, first.run.runId);
  assert.equal(launches.length, 2);
  await refused(service.requestPlacement({ userId: ANA, target: { ...existing, role: "team_manager" }, actor, idempotencyKey: "key-1" }), "IDEMPOTENCY_KEY_REUSED", 409);
  await refused(service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "has space" }), "INVALID_IDEMPOTENCY_KEY", 400);
  assert.equal(launches.length, 2);
});

test("a staff account without an organization can't queue anything", async () => {
  const { service, store, launches } = setup();
  for (const bad of [{ ...actor, adminOrganizationId: undefined }, { ...actor, adminOrganizationId: "" }, { ...actor, adminUserId: "not-an-id" }]) {
    await refused(service.requestPlacement({ userId: ANA, target: existing, actor: bad }), "STAFF_ORGANIZATION_REQUIRED", 403);
    await refused(service.requestRollback({ runId: "placement-2026-11-17T09:00:00.000Z-00000001", actor: bad }), "STAFF_ORGANIZATION_REQUIRED", 403);
  }
  assert.equal(store.rows.size, 0);
  assert.equal(launches.length, 0);
});

test("after a start failure or a task that never started, the same Idempotency-Key tries again", async () => {
  const { service, store, launches, state, advance } = setup();
  state.launchError = new Error("boom");
  await refused(service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "retry-me" }), "PLACEMENT_TASK_START_FAILED", 503);
  const [failed] = [...store.rows.values()];
  assert.equal(failed.idempotencyKey, undefined, "the key is released with the run");
  state.launchError = null;
  const second = await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "retry-me" });
  assert.equal(second.replayed, false);
  assert.notEqual(second.run.runId, failed.runId);
  assert.equal(launches.length, 1);
  // While that one is queued the key replays it.
  assert.equal((await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "retry-me" })).replayed, true);
  // It never starts; once given up on, the key starts a third run.
  advance(5 * 60_000);
  const third = await service.requestPlacement({ userId: ANA, target: existing, actor, idempotencyKey: "retry-me" });
  assert.equal(third.replayed, false);
  assert.equal(store.rows.size, 3);
  assert.equal(launches.length, 2);
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
  const awsText = "AccessDeniedException: User: arn:aws:sts::111111111111:assumed-role/rfpilot-api-task-role/abc is not authorized to perform: states:StartExecution";
  state.launchError = new Error(awsText);
  let thrown;
  await service.requestPlacement({ userId: ANA, target: existing, actor }).catch((error) => { thrown = error; });
  assert.equal(thrown.code, "PLACEMENT_TASK_START_FAILED");
  assert.equal(thrown.status, 503);
  const [row] = [...store.rows.values()];
  // AWS's own words (account id, role names) are for the server log, not the client or the journal.
  for (const text of [thrown.message, JSON.stringify(thrown.details), JSON.stringify(row), JSON.stringify(await service.getRun(row.runId))]) {
    assert.ok(!/111111111111|arn:|AccessDenied|assumed-role/.test(text), text);
  }
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
  const { service, store, launches, advance, logs, described } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  advance(3 * 60_000);
  assert.equal((await service.getRun(run.runId)).status, "queued", "still inside the start timeout");
  advance(61_000);
  const view = await service.getRun(run.runId);
  assert.equal(view.status, "failed");
  assert.equal(view.state, "aborted");
  assert.equal(view.task.code, "PLACEMENT_TASK_NOT_STARTED");
  assert.equal(view.rollbackRequired, false);
  assert.equal(store.rows.get(run.runId).inFlight, undefined);
  assert.equal(store.rows.get(run.runId).taskSlot, undefined);
  assert.equal((await service.requestPlacement({ userId: ANA, target: existing, actor })).run.status, "queued");
  assert.equal(launches.length, 2);
  // Why it never started is fetched for the server log, and only for it.
  assert.deepEqual(described, [launches[0].launchToken]);
  const given = logs.find((entry) => entry.event === "placement_task_given_up");
  assert.equal(given.execution.status, "FAILED");
  assert.match(given.execution.cause, /CannotPullContainerError/);
  assert.ok(!JSON.stringify(view).includes("CannotPull"));
  assert.ok(!JSON.stringify(store.rows.get(run.runId)).includes("CannotPull"));
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
  // The same key from another staff member is not a replay.
  await refused(service.requestRollback({ runId: run.runId, actor, idempotencyKey: "rb-1" }), "ROLLBACK_IN_PROGRESS", 409);
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
    await service.requestRollback({ runId: run.runId, actor, idempotencyKey: "rb" });
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
    // And it can be asked for again, with the same key: the failed attempt moved nothing.
    const again = await service.requestRollback({ runId: run.runId, actor, idempotencyKey: "rb" });
    assert.deepEqual([again.replayed, again.run.status], [false, "queued"]);
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

/* ── What is handed to Step Functions ──────────────────────────────────────────────────────── */

const MACHINE = "arn:aws:states:us-east-2:111111111111:stateMachine:rfpilot-production-placement";
const config = { stateMachineArn: MACHINE, region: "us-east-2" };
const RUN = "placement-2026-11-17T09:00:00.000Z-ab12cd34";
const TOKEN = "f".repeat(64);

test("an execution is started on the placement state machine with the run id as its whole input", () => {
  const input = buildStartExecutionInput(config, { runId: RUN, launchToken: TOKEN });
  assert.deepEqual(Object.keys(input).sort(), ["input", "name", "stateMachineArn"]);
  assert.equal(input.stateMachineArn, MACHINE);
  assert.equal(input.name, TOKEN);
  // The state machine reads $.runId and nothing else; nothing else is sent.
  assert.deepEqual(JSON.parse(input.input), { runId: RUN });
  // Extra fields on the request never travel.
  const extra = buildStartExecutionInput(config, { runId: RUN, launchToken: TOKEN, command: ["sh"], taskRoleArn: "arn:aws:iam::1:role/x", overrides: {} });
  assert.deepEqual(extra, input);
});

test("a run id that isn't one of ours never becomes an execution input", () => {
  const hostile = [
    "", "x", `${RUN}; rm -rf /`, `${RUN} --rollback=other`, `${RUN}\n--apply`, "$(curl evil)", "`id`", "placement-2026-11-17T09:00:00.000Z-AB12CD34",
    "--email=victim@example.com", `${RUN}&&true`, "../../etc/passwd", `${RUN}","command":["sh"]`, null, undefined, 42, ["a"], { runId: RUN },
  ];
  for (const runId of hostile) {
    assert.throws(() => buildStartExecutionInput(config, { runId, launchToken: TOKEN }), PlacementTaskConfigError, JSON.stringify(runId));
  }
  for (const launchToken of ["not-a-token", "", null, `${TOKEN}x`, RUN]) {
    assert.throws(() => buildStartExecutionInput(config, { runId: RUN, launchToken }), PlacementTaskConfigError, JSON.stringify(launchToken));
  }
});

test("only the placement state machine can be started", () => {
  const bad = [
    "arn:aws:states:us-east-2:111111111111:stateMachine:something-else",
    "arn:aws:states:us-east-2:111111111111:stateMachine:rfpilot-production-placement-evil",
    "arn:aws:states:us-east-2:111111111111:execution:rfpilot-production-placement",
    "arn:aws:ecs:us-east-2:111111111111:task-definition/rfpilot-production-migrate:1",
    "rfpilot-production-placement",
    `${MACHINE} extra`,
  ];
  for (const stateMachineArn of bad) {
    assert.throws(() => placementTaskConfigFromEnv({ PLACEMENT_STATE_MACHINE_ARN: stateMachineArn }), PlacementTaskConfigError, stateMachineArn);
    assert.throws(() => buildStartExecutionInput({ stateMachineArn, region: "us-east-2" }, { runId: RUN, launchToken: TOKEN }), PlacementTaskConfigError, stateMachineArn);
  }
  // Unset is how the feature is switched off.
  assert.equal(placementTaskConfigFromEnv({}), null);
  assert.equal(placementTaskConfigFromEnv({ PLACEMENT_STATE_MACHINE_ARN: "  " }), null);
  assert.deepEqual(placementTaskConfigFromEnv({ PLACEMENT_STATE_MACHINE_ARN: MACHINE }), config);
});

test("timeouts have floors and a setting out of range is an error, not a silent default", () => {
  assert.deepEqual(placementTaskPolicyFromEnv({}), { maxConcurrent: 1, startTimeoutMs: 240_000, heartbeatTimeoutMs: 180_000 });
  assert.equal(placementTaskPolicyFromEnv({ PLACEMENT_TASK_MAX_CONCURRENT: "3" }).maxConcurrent, 3);
  assert.equal(placementTaskPolicyFromEnv({ PLACEMENT_TASK_START_TIMEOUT_SECONDS: "60" }).startTimeoutMs, 60_000);
  assert.equal(placementTaskPolicyFromEnv({ PLACEMENT_TASK_HEARTBEAT_TIMEOUT_SECONDS: "120" }).heartbeatTimeoutMs, 120_000);
  const bad = [
    { PLACEMENT_TASK_START_TIMEOUT_SECONDS: "59" }, { PLACEMENT_TASK_START_TIMEOUT_SECONDS: "0" }, { PLACEMENT_TASK_START_TIMEOUT_SECONDS: "soon" },
    { PLACEMENT_TASK_HEARTBEAT_TIMEOUT_SECONDS: "119" }, { PLACEMENT_TASK_HEARTBEAT_TIMEOUT_SECONDS: "30" }, { PLACEMENT_TASK_HEARTBEAT_TIMEOUT_SECONDS: "1.5" },
    { PLACEMENT_TASK_MAX_CONCURRENT: "0" }, { PLACEMENT_TASK_MAX_CONCURRENT: "500" },
  ];
  for (const env of bad) {
    assert.throws(() => placementTaskPolicyFromEnv(env), (error) => error instanceof PlacementTaskSettingsError && error.message.includes(Object.keys(env)[0]), JSON.stringify(env));
  }
});

test("the launcher sends one StartExecution, treats a repeat of the same attempt as started, and passes other errors on", async () => {
  const sent = [];
  const client = (respond) => ({ async send(command) { sent.push(command); return respond(command); } });
  await createPlacementTaskLauncher(config, client(() => ({ executionArn: "x" }))).launch({ runId: RUN, launchToken: TOKEN });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].constructor.name, "StartExecutionCommand");
  assert.deepEqual(sent[0].input, buildStartExecutionInput(config, { runId: RUN, launchToken: TOKEN }));

  const already = Object.assign(new Error("Execution Already Exists"), { name: "ExecutionAlreadyExists" });
  await createPlacementTaskLauncher(config, client(() => { throw already; })).launch({ runId: RUN, launchToken: TOKEN });
  const denied = Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
  await assert.rejects(createPlacementTaskLauncher(config, client(() => { throw denied; })).launch({ runId: RUN, launchToken: TOKEN }), /not authorized/);

  const before = sent.length;
  await assert.rejects(createPlacementTaskLauncher(config, client(() => ({}))).launch({ runId: `${RUN};id`, launchToken: TOKEN }), PlacementTaskConfigError);
  assert.equal(sent.length, before, "a hostile run id never reaches Step Functions");

  const described = await createPlacementTaskLauncher(config, client(() => ({ status: "FAILED", error: "States.TaskFailed", cause: "stopped" }))).describe({ launchToken: TOKEN });
  assert.deepEqual(described, { status: "FAILED", error: "States.TaskFailed", cause: "stopped" });
  assert.equal(sent.at(-1).constructor.name, "DescribeExecutionCommand");
  assert.equal(sent.at(-1).input.executionArn, `arn:aws:states:us-east-2:111111111111:execution:rfpilot-production-placement:${TOKEN}`);
});

test("the API's code has no way to start an ECS task", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(!("@aws-sdk/client-ecs" in manifest.dependencies), "the ECS client is not a dependency");
  for (const file of ["placementTaskLauncher.ts", "placementTasks.ts", "placementTaskStore.ts"]) {
    const source = fs.readFileSync(path.join(root, "src/modules/tenancy", file), "utf8");
    assert.ok(!/RunTaskCommand|client-ecs/.test(source), file);
  }
});

/* ── Staff only ────────────────────────────────────────────────────────────────────────────── */

test("every placement route sits behind the staff guard: a staff membership role and an admins account", () => {
  const route = require("../routes/adminLegacyCustomersRoute");
  const router = route.default;
  const firstRoute = router.stack.findIndex((layer) => layer.route);
  const guards = router.stack.slice(0, firstRoute);
  assert.equal(guards.length, 3, "authenticate, authorize, then the staff-account check, before any route");
  assert.equal(guards[2].handle, route.requireStaffAccount);
  assert.ok(router.stack.slice(firstRoute).every((layer) => layer.route), "no route is registered ahead of the guards");
  assert.deepEqual(
    router.stack.slice(firstRoute).map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`),
    ["GET /", "GET /target-organizations", "POST /:userId/placements", "GET /placements/:runId", "POST /placements/:runId/rollback"],
  );
  const attempt = (guard, user) => {
    const res = { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    let passed = false;
    guard({ user }, res, () => { passed = true; });
    return passed ? "passed" : res.code;
  };
  const authorize = guards[1].handle;
  assert.equal(attempt(authorize, undefined), 401);
  for (const roles of [["owner"], ["organization_admin"], ["team_manager"], ["planner"], ["viewer"], []]) assert.equal(attempt(authorize, { roles }), 403, roles.join());
  assert.equal(attempt(authorize, { roles: ["dxg_admin"] }), "passed");

  // The membership role is not enough: the account itself must be an admins account with a
  // staff account role. A users account left holding a staff membership is refused.
  const account = route.requireStaffAccount;
  assert.equal(attempt(account, { roles: ["dxg_admin"], accountType: "admin", role: "admin" }), "passed");
  assert.equal(attempt(account, { roles: ["super_admin"], accountType: "admin", role: "super_admin" }), "passed");
  for (const user of [
    undefined,
    { roles: ["dxg_admin"] },
    { roles: ["dxg_admin"], accountType: "user", role: "customer" },
    { roles: ["dxg_admin"], accountType: "user", role: "admin" },
    { roles: ["super_admin"], accountType: "user", role: "super_admin" },
    { roles: ["dxg_admin"], accountType: "admin", role: "customer" },
    { roles: ["dxg_admin"], accountType: "admin" },
  ]) assert.equal(attempt(account, user), 403, JSON.stringify(user));
  // And each route has a per-staff rate limit ahead of its handler.
  for (const layer of router.stack.slice(firstRoute)) assert.equal(layer.route.stack.length, 2, layer.route.path);
  // Reading a run (what a screen polls) has a bucket of its own, apart from the lists.
  const limiterOf = (path, method) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  assert.notEqual(limiterOf("/placements/:runId", "get"), limiterOf("/", "get"));
  assert.equal(limiterOf("/", "get"), limiterOf("/target-organizations", "get"));
  assert.equal(limiterOf("/:userId/placements", "post"), limiterOf("/placements/:runId/rollback", "post"));
});

test("the rate limiter's refusal carries its own code, not the capacity code", async () => {
  const { securityRateLimit } = require("../middleware/securityRateLimit");
  const limiter = securityRateLimit({ name: `placement-test-${Date.now()}`, limit: 1, windowMs: 60_000, identity: () => "staff-1", code: "PLACEMENT_RATE_LIMITED" });
  const hit = () => new Promise((resolve) => {
    const res = { headers: {}, code: null, body: null, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; resolve(this); } };
    limiter({ ip: "127.0.0.1" }, res, () => resolve("passed"));
  });
  assert.equal(await hit(), "passed");
  const refusal = await hit();
  assert.equal(refusal.code, 429);
  assert.equal(refusal.body.code, "PLACEMENT_RATE_LIMITED");
  assert.ok(Number(refusal.headers["Retry-After"]) > 0);
  // Other users of the limiter are unchanged: no code unless one is asked for.
  const plain = securityRateLimit({ name: `placement-test-plain-${Date.now()}`, limit: 0, windowMs: 60_000, identity: () => "x" });
  const plainRefusal = await new Promise((resolve) => {
    const res = { setHeader() {}, status() { return this; }, json(body) { resolve(body); } };
    plain({ ip: "127.0.0.1" }, res, () => resolve("passed"));
  });
  assert.deepEqual(plainRefusal, { success: false, message: "Too many requests. Please try again later." });
});

/* ── A placement is not finished until its task is ─────────────────────────────────────────── */

test("while the placement task is still verifying, the run reads running and cannot be rolled back", async () => {
  const { service, store, launches, task } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  task.claim(run.runId);
  // The MongoDB move has committed: the journal says done and the user's lock is gone, but the
  // task still has the Postgres commit, the checks and the audit events to do.
  task.journal(run.runId, "done");
  const view = await service.getRun(run.runId);
  assert.deepEqual([view.status, view.operation, view.state, view.rollbackRequired], ["running", "placement", "done", false]);
  await refused(service.requestRollback({ runId: run.runId, actor }), "PLACEMENT_IN_PROGRESS", 409);
  // The journal refuses the claim too, whatever the service checked.
  const direct = await store.queueRollback(run.runId, { operation: "rollback", status: "queued", requestedAt: new Date(), adminUserId: STAFF, adminOrganizationId: STAFF_ORG, correlationId: "x" }, 1);
  assert.deepEqual(direct, { queued: false, refusal: "state" });
  assert.equal(store.rows.get(run.runId).task.operation, "placement", "the placement task's record is not overwritten");
  assert.equal(launches.length, 1);
  // Its own rollback after failed checks is not a finished run either.
  task.journal(run.runId, "rolling_back");
  assert.deepEqual([(await service.getRun(run.runId)).status, (await service.getRun(run.runId)).operation], ["running", "placement"]);
  await refused(service.requestRollback({ runId: run.runId, actor }), "PLACEMENT_IN_PROGRESS", 409);
  // Once the task has reported, it can be.
  task.finish(run.runId, "succeeded", "done");
  assert.equal((await service.getRun(run.runId)).status, "succeeded");
  assert.equal((await service.requestRollback({ runId: run.runId, actor })).run.status, "queued");
});

test("a task lost after a verified placement leaves a placement that stands, not one to roll back", async () => {
  const { service, store, task, advance } = setup();
  const { run } = await service.requestPlacement({ userId: ANA, target: existing, actor });
  task.claim(run.runId);
  task.journal(run.runId, "done");
  store.rows.get(run.runId).verification = { passed: true, holdingLeftovers: { mongo: {}, postgres: {} }, orphanedProposalsInTarget: 0, lostProposals: [] };
  advance(4 * 60_000);
  const view = await service.getRun(run.runId);
  assert.deepEqual([view.status, view.state, view.rollbackRequired, view.task.status, view.task.code], ["succeeded", "done", false, "failed", "PLACEMENT_TASK_LOST"]);
  assert.deepEqual(view.task.details, { verified: true, auditUnconfirmed: true });
});

test("a placement whose task failed or was lost after the move: succeeded only if its checks passed", async () => {
  // The one rule, used by the task when it fails after the move and by the API when it gives up.
  assert.deepEqual(unfinishedPlacementOutcome({ verification: { passed: true } }), { stands: true, details: { verified: true, auditUnconfirmed: true } });
  for (const verification of [undefined, null, { passed: false }, {}, { passed: "yes" }]) {
    assert.deepEqual(unfinishedPlacementOutcome({ verification }), { stands: false, details: { rollbackRequired: true } }, JSON.stringify(verification));
  }
  // What the client then sees. The task failed after the move, before its checks were recorded:
  // it marks the run failed, and the view agrees.
  const base = { runId: "r", userId: ANA, holdingOrganizationId: HOLDING, targetOrganizationId: TARGET, createdOrganization: false, role: "planner", adminUserId: STAFF, adminOrganizationId: STAFF_ORG, createdAt: START, updatedAt: START };
  const failedTask = (details) => ({ operation: "placement", status: "failed", requestedAt: START, adminUserId: STAFF, adminOrganizationId: STAFF_ORG, correlationId: "c", code: "PLACEMENT_TASK_ERROR", details });
  const unchecked = placementRunView({ ...base, state: "failed", task: failedTask({ rollbackRequired: true }) });
  assert.deepEqual([unchecked.status, unchecked.rollbackRequired, unchecked.task.details.rollbackRequired], ["failed", true, true]);
  // The audit write failed after the checks passed: the placement stands, flagged.
  const unaudited = placementRunView({ ...base, state: "done", verification: { passed: true }, task: failedTask({ verified: true, auditUnconfirmed: true }) });
  assert.deepEqual([unaudited.status, unaudited.rollbackRequired, unaudited.task.status, unaudited.task.details.auditUnconfirmed], ["succeeded", false, "failed", true]);
});

/* ── The task's command line ───────────────────────────────────────────────────────────────── */

test("the placement task accepts exactly one argument, --task-run=<run id>", () => {
  assert.equal(placementTaskRunIdFromArgv([`--task-run=${RUN}`]), RUN);
  const refusedArgv = [
    [], [""], [RUN], ["--task-run"], ["--task-run="], [`--task-run=${RUN}`, "--apply"], ["--apply", `--task-run=${RUN}`],
    [`--task-run=${RUN}`, `--task-run=${RUN}`], [`--task-run=${RUN}\n`], [`--task-run=${RUN}\n--apply`], [`--task-run=${RUN} --apply`],
    [` --task-run=${RUN}`], [`--Task-Run=${RUN}`], [`--rollback=${RUN}`], [`--task-run=${RUN.toUpperCase()}`], ["--task-run=x; rm -rf /"],
    ["--email=victim@example.com"], ["--list"], ["--help"], [`-task-run=${RUN}`], [`--task-run==${RUN}`], [null], [42], [[`--task-run=${RUN}`]],
  ];
  for (const argv of refusedArgv) assert.equal(placementTaskRunIdFromArgv(argv), null, JSON.stringify(argv));
  assert.equal(placementTaskRunIdFromArgv(`--task-run=${RUN}`), null, "a string is not an argument list");
  // The entry file uses this parser and nothing else to decide what to run.
  const fs = require("node:fs");
  const entry = fs.readFileSync(require("node:path").join(__dirname, "../scripts/runPlacementTask.ts"), "utf8");
  assert.match(entry, /placementTaskRunIdFromArgv\(process\.argv\.slice\(2\)\)/);
  assert.ok(!/--email|--new-org|--org-slug|--rollback|--apply|--list/.test(entry.replace(/\/\/.*$/gm, "")), "none of the operator CLI's flags");
});

/* ── A source check of the infrastructure definition (not a synth check) ───────────────────────
   This reads deploy/aws/lib/app-stack.ts as text. It catches an edit that adds an input path to
   the state machine or an ECS/IAM action to the API role in the placement block. It does not
   prove what CloudFormation receives: that is the synthesized template in the pull request. */
test("source check: the state machine reads only the run id, and the API gets only states actions", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require("node:path").join(__dirname, "../deploy/aws/lib/app-stack.ts"), "utf8");
  const start = source.indexOf("Legacy-customer placement: API");
  assert.ok(start > 0);
  const block = source.slice(start).replace(/\/\/.*$/gm, "");
  // Every Amazon States Language key that takes a path from the input ends in `.$`.
  assert.deepEqual(block.match(/['"][A-Za-z]+\.\$['"]/g), ["'Command.$'"]);
  assert.match(block, /States\.Array\(States\.Format\('--task-run=\{\}', \$\.runId\)\)/);
  assert.equal((block.match(/\$\.[A-Za-z]/g) ?? []).length, 1, "one reference to the execution input");
  // What is added to the API task role.
  const apiStatements = [...block.matchAll(/apiTaskDef\.taskRole\.addToPrincipalPolicy\(\s*new iam\.PolicyStatement\(\{[\s\S]*?\}\),\s*\);/g)].map((m) => m[0]);
  assert.equal(apiStatements.length, 2);
  const actions = apiStatements.flatMap((statement) => [...statement.matchAll(/actions: \[([^\]]*)\]/g)].flatMap((m) => m[1].match(/'[^']+'/g)));
  assert.deepEqual(actions.sort(), ["'states:DescribeExecution'", "'states:StartExecution'"]);
  for (const statement of apiStatements) assert.ok(!/ecs:|iam:|\*'\]/.test(statement.replace(/resourceName: `[^`]*`/, "")), statement);
  // Outside this block the API role is granted nothing by hand.
  assert.equal((source.match(/apiTaskDef\.taskRole\.addToPrincipalPolicy/g) ?? []).length, 2);
});
