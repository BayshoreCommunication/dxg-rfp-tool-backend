require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RESPONSE_TARGET_MS,
  autoCloseReminderBody,
  pickAssignee,
  responseDueAt,
  serviceLevelPatch,
} = require("../src/modules/supportDesk/serviceLevels");

const NOW = new Date("2026-10-26T10:00:00.000Z");
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const HOUR = 3_600_000;

const open = (overrides = {}) => ({
  status: "open",
  priority: "normal",
  responseDueAt: iso(4 * HOUR),
  waitingSince: null,
  lastCustomerMessageAt: NOW.toISOString(),
  ...overrides,
});

test("response targets tighten with priority", () => {
  assert.ok(RESPONSE_TARGET_MS.urgent < RESPONSE_TARGET_MS.high);
  assert.ok(RESPONSE_TARGET_MS.high < RESPONSE_TARGET_MS.normal);
  assert.ok(RESPONSE_TARGET_MS.normal < RESPONSE_TARGET_MS.low);
  assert.equal(responseDueAt(NOW.toISOString(), "urgent"), iso(HOUR));
});

test("a customer message starts the response clock and clears any escalation", () => {
  assert.deepEqual(
    serviceLevelPatch({ before: null, status: "open", priority: "high", event: "customer_message", now: NOW }),
    { responseDueAt: iso(2 * HOUR), escalatedAt: null, waitingSince: null, autoCloseReminderSentAt: null },
  );
});

test("an agent reply stops the response clock and starts the auto-close clock", () => {
  assert.deepEqual(
    serviceLevelPatch({ before: open(), status: "waiting_on_customer", priority: "normal", event: "agent_message", now: NOW }),
    { responseDueAt: null, escalatedAt: null, waitingSince: NOW.toISOString(), autoCloseReminderSentAt: null },
  );
  // Replying but leaving the ticket open still counts as answered.
  assert.equal(
    serviceLevelPatch({ before: open(), status: "open", priority: "normal", event: "agent_message", now: NOW }).responseDueAt,
    null,
  );
});

test("a priority change re-times a running clock from the customer's message", () => {
  const before = open({ lastCustomerMessageAt: iso(-30 * 60_000) });
  assert.equal(
    serviceLevelPatch({ before, status: "open", priority: "urgent", event: "change", now: NOW }).responseDueAt,
    iso(-30 * 60_000 + HOUR),
  );
  // No clock running: a priority change does not start one.
  assert.equal(
    serviceLevelPatch({ before: open({ responseDueAt: null }), status: "open", priority: "urgent", event: "change", now: NOW }).responseDueAt,
    undefined,
  );
});

test("reopening by hand starts the clock; resolving or closing clears everything", () => {
  const waiting = { ...open({ responseDueAt: null }), status: "waiting_on_customer", waitingSince: iso(-HOUR) };
  assert.equal(
    serviceLevelPatch({ before: waiting, status: "open", priority: "normal", event: "change", now: NOW }).responseDueAt,
    iso(4 * HOUR),
  );
  for (const status of ["resolved", "closed"]) {
    assert.deepEqual(
      serviceLevelPatch({ before: waiting, status, priority: "normal", event: "change", now: NOW }),
      { responseDueAt: null, escalatedAt: null, waitingSince: null, autoCloseReminderSentAt: null },
    );
  }
});

test("staying in waiting-on-customer without a reply keeps the auto-close clock", () => {
  const waiting = { ...open({ responseDueAt: null }), status: "waiting_on_customer", waitingSince: iso(-2 * HOUR) };
  assert.deepEqual(
    serviceLevelPatch({ before: waiting, status: "waiting_on_customer", priority: "high", event: "change", now: NOW }),
    { responseDueAt: null, escalatedAt: null },
  );
});

test("new tickets go to the agent with the fewest active tickets, ties at random", () => {
  const agents = [
    { id: "a", name: "Ana", email: "a@x", company: null, role: "admin" },
    { id: "b", name: "Ben", email: "b@x", company: null, role: "admin" },
    { id: "c", name: "Cy", email: "c@x", company: null, role: "admin" },
  ];
  const loads = new Map([["a", 3], ["b", 1], ["c", 1]]);
  assert.equal(pickAssignee(agents, loads, () => 0).id, "b");
  assert.equal(pickAssignee(agents, loads, () => 0.99).id, "c");
  assert.equal(pickAssignee(agents, new Map(), () => 0.5).id, "b");
  assert.equal(pickAssignee([], loads), null);
});

test("the auto-close reminder greets by first name and promises to stay open on reply", () => {
  assert.match(autoCloseReminderBody("Pat Planner"), /^Hi Pat, just checking in/);
  assert.match(autoCloseReminderBody(null), /^Hi, just checking in/);
  assert.match(autoCloseReminderBody("Pat"), /reply here and it stays open/);
});
