require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createSupportDeskSweeper } = require("../src/modules/supportDesk/application/supportDeskSweeper");
const { createSupportPresence, PRESENCE_FRESH_MS } = require("../src/modules/supportDesk/application/supportPresence");
const { SupportDeskError } = require("../src/modules/supportDesk/domain");

const ORG = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PLANNER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT = "cccccccccccccccccccccccc";
const AGENT_TWO = "cccccccccccccccccccccccd";
const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const ticket = (overrides) => ({
  id: "t1", ticketNumber: 1, organizationId: ORG, requesterUserId: PLANNER, assigneeUserId: AGENT,
  subject: "Help", category: "other", priority: "normal", status: "open", messageCount: 2,
  unreadForRequester: 0, unreadForAgents: 1, lastMessageAt: ago(0), lastCustomerMessageAt: ago(0),
  lastAgentMessageAt: null, firstAgentResponseAt: null, resolvedAt: null, closedAt: null,
  responseDueAt: null, escalatedAt: null, waitingSince: null, autoCloseReminderSentAt: null,
  createdAt: ago(0), updatedAt: ago(0),
  ...overrides,
});

const people = new Map([
  [PLANNER, { id: PLANNER, name: "Pat Planner", email: "pat@example.com", company: null, role: "customer" }],
  [AGENT, { id: AGENT, name: "Dana DXG", email: "dana@example.com", company: null, role: "admin" }],
  [AGENT_TWO, { id: AGENT_TWO, name: "Eli DXG", email: "eli@example.com", company: null, role: "admin" }],
]);

const sweepFixture = ({ unanswered = [], remind = [], resolve = [], close = [], failOn } = {}) => {
  const updates = [];
  const messages = [];
  const events = [];
  const calls = {};
  const repository = {
    async backfillServiceLevels() { return 0; },
    async listUnansweredSince(before) { calls.unansweredBefore = before; return unanswered; },
    async listNeedingCloseReminder(before) { calls.remindBefore = before; return remind; },
    async listDueToAutoResolve(waitingBefore, remindedBefore) { calls.resolve = [waitingBefore, remindedBefore]; return resolve; },
    async listResolvedBefore(resolvedBefore) { calls.close = resolvedBefore; return close; },
    async updateTicket(organizationId, id, patch) {
      if (failOn === id) throw new Error("database hiccup");
      updates.push([id, patch]);
      return { ...[...unanswered, ...remind, ...resolve, ...close].find((t) => t.id === id), ...patch };
    },
    async appendMessage(input) { messages.push(input); return { id: `m${messages.length}`, ...input, createdAt: input.now.toISOString() }; },
    async findUserSummaries(organizationId, ids) { return new Map(ids.filter((id) => people.has(id)).map((id) => [id, people.get(id)])); },
  };
  const notifier = {
    async ticketEscalated(input) { events.push(["escalated", input]); },
    async autoCloseReminder(input) { events.push(["reminder", input]); },
    async autoResolved(input) { events.push(["resolved", input]); },
  };
  const sweeper = createSupportDeskSweeper({ repository, notifier, clock: () => NOW });
  return { sweeper, updates, messages, events, calls };
};

test("an answer owed for 30 minutes alerts every agent once and names the owner", async () => {
  const late = ticket({ id: "late", lastCustomerMessageAt: ago(45 * MIN), responseDueAt: ago(-3 * 60 * MIN) });
  const { sweeper, updates, events, calls } = sweepFixture({ unanswered: [late] });
  const result = await sweeper.run();
  assert.equal(calls.unansweredBefore.toISOString(), ago(30 * MIN));
  assert.deepEqual(updates, [["late", { escalatedAt: NOW.toISOString() }]]);
  assert.equal(events[0][0], "escalated");
  assert.equal(events[0][1].assignee.name, "Dana DXG");
  assert.equal(events[0][1].waitingMinutes, 45);
  assert.equal(result.escalated, 1);
});

test("five days waiting posts a friendly check-in in the thread and emails the planner", async () => {
  const quiet = ticket({ id: "quiet", status: "waiting_on_customer", waitingSince: ago(5 * DAY + MIN), unreadForRequester: 0 });
  const { sweeper, updates, messages, events, calls } = sweepFixture({ remind: [quiet] });
  const result = await sweeper.run();
  assert.equal(calls.remindBefore.toISOString(), ago(5 * DAY));
  assert.equal(messages[0].authorRole, "system");
  assert.equal(messages[0].kind, "message", "customer-visible, signed as DXG support");
  assert.match(messages[0].body, /^Hi Pat, just checking in/);
  assert.match(messages[0].body, /mark it as resolved in 2 days/);
  assert.equal(updates[0][1].autoCloseReminderSentAt, NOW.toISOString());
  assert.equal(updates[0][1].unreadForRequester, 1);
  assert.equal(events[0][0], "reminder");
  assert.equal(result.reminded, 1);
});

test("seven days waiting, reminded at least a day earlier, resolves the ticket and tells the planner", async () => {
  const stale = ticket({
    id: "stale", status: "waiting_on_customer", waitingSince: ago(7 * DAY + MIN), autoCloseReminderSentAt: ago(2 * DAY),
  });
  const { sweeper, updates, messages, events, calls } = sweepFixture({ resolve: [stale] });
  const result = await sweeper.run();
  assert.deepEqual(calls.resolve.map((d) => d.toISOString()), [ago(7 * DAY), ago(DAY)]);
  assert.match(messages[0].body, /Resolved automatically after 7 days/);
  const patch = updates[0][1];
  assert.equal(patch.status, "resolved");
  assert.equal(patch.resolvedAt, NOW.toISOString());
  assert.equal(patch.waitingSince, null);
  assert.equal(events[0][0], "resolved");
  assert.equal(result.resolved, 1);
});

test("three days after resolving, a ticket closes quietly", async () => {
  const done = ticket({ id: "done", status: "resolved", resolvedAt: ago(3 * DAY + MIN) });
  const { sweeper, updates, messages, events, calls } = sweepFixture({ close: [done] });
  const result = await sweeper.run();
  assert.equal(calls.close.toISOString(), ago(3 * DAY));
  assert.equal(messages[0].kind, "system");
  assert.match(messages[0].body, /Closed automatically 3 days after it was resolved/);
  assert.equal(updates[0][1].status, "closed");
  assert.equal(updates[0][1].closedAt, NOW.toISOString());
  assert.deepEqual(events, [], "the planner was already told when it was resolved");
  assert.equal(result.closed, 1);
});

test("one failing ticket never stops the rest of the sweep", async () => {
  const a = ticket({ id: "a", lastCustomerMessageAt: ago(40 * MIN) });
  const b = ticket({ id: "b", lastCustomerMessageAt: ago(50 * MIN) });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const { sweeper } = sweepFixture({ unanswered: [a, b], failOn: "a" });
    const result = await sweeper.run();
    assert.equal(result.escalated, 1);
    assert.equal(result.failed, 1);
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => line.includes("ticket a")));
});

const presenceFixture = () => {
  const entries = new Map();
  let now = NOW.getTime();
  const store = {
    async touch(org, id, entry) { entries.set(`${id}:${entry.userId}`, entry); },
    async list(org, id) { return [...entries.entries()].filter(([k]) => k.startsWith(`${id}:`)).map(([, v]) => v); },
    async remove(org, id, userId) { entries.delete(`${id}:${userId}`); },
  };
  const repository = {
    async findTicket(org, id) { return id === "dddddddddddddddddddddddd" ? { id } : null; },
    async findUserSummaries(org, ids) { return new Map(ids.filter((id) => people.has(id)).map((id) => [id, people.get(id)])); },
  };
  const presence = createSupportPresence({ store, repository, clock: () => new Date(now) });
  return { presence, advance: (ms) => { now += ms; } };
};

const TICKET = "dddddddddddddddddddddddd";
const actor = (userId) => ({ userId, organizationId: ORG, role: "admin", roles: ["dxg_admin"] });

test("agents see who else has the ticket open, replying first, never themselves", async () => {
  const { presence } = presenceFixture();
  assert.deepEqual(await presence.heartbeat(actor(AGENT), TICKET, { state: "viewing" }), { others: [] });
  const seen = await presence.heartbeat(actor(AGENT_TWO), TICKET, { state: "replying" });
  assert.deepEqual(seen.others, [{ userId: AGENT, name: "Dana DXG", state: "viewing" }]);
  const back = await presence.heartbeat(actor(AGENT), TICKET, {});
  assert.deepEqual(back.others, [{ userId: AGENT_TWO, name: "Eli DXG", state: "replying" }]);
});

test("presence fades out without a heartbeat and clears on leave", async () => {
  const { presence, advance } = presenceFixture();
  await presence.heartbeat(actor(AGENT), TICKET, { state: "replying" });
  advance(PRESENCE_FRESH_MS + 1);
  assert.deepEqual((await presence.heartbeat(actor(AGENT_TWO), TICKET, {})).others, []);
  await presence.heartbeat(actor(AGENT), TICKET, { state: "viewing" });
  await presence.leave(actor(AGENT), TICKET);
  assert.deepEqual((await presence.heartbeat(actor(AGENT_TWO), TICKET, {})).others, []);
});

test("presence is agent-only and checks the ticket exists", async () => {
  const { presence } = presenceFixture();
  await assert.rejects(
    () => presence.heartbeat({ userId: PLANNER, organizationId: ORG, role: "customer", roles: ["planner"] }, TICKET, {}),
    (error) => error instanceof SupportDeskError && error.status === 403,
  );
  await assert.rejects(
    () => presence.heartbeat(actor(AGENT), "eeeeeeeeeeeeeeeeeeeeeeee", {}),
    (error) => error instanceof SupportDeskError && error.code === "SUPPORT_TICKET_NOT_FOUND",
  );
});
