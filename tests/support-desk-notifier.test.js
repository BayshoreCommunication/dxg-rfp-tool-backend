require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

// The notifier talks to Mongo and the notification service directly, so both are replaced
// here before it loads. What is under test: who is alerted for a ticket that belongs to a
// customer's organization, where no RFPilot staff account lives.
const Admin = require("../modal/adminModel").default;
const Organization = require("../modal/organizationModel").default;
const notificationService = require("../utils/notificationService");
const emailService = require("../utils/emailService");

const hex = (n) => n.toString(16).padStart(24, "0");
const STAFF_ORG = hex(0xd0);
const BAYSHORE = hex(0xb0);
const STAFF_ONE = hex(0xd1);
const STAFF_TWO = hex(0xd2);
const REQUESTER = hex(0xb1);

const adminQueries = [];
const notifications = [];
const emails = [];
Admin.find = (filter) => {
  adminQueries.push(filter);
  return { select: () => ({ lean: async () => [{ _id: STAFF_ONE }, { _id: STAFF_TWO }] }) };
};
Organization.findById = (id) => ({
  select: () => ({ lean: async () => (String(id) === BAYSHORE ? { _id: BAYSHORE, name: "Bayshore Communication" } : null) }),
});
notificationService.createNotification = async (input) => { notifications.push(input); };
emailService.sendCustomEmail = async (input) => { emails.push(input); };

const { supportDeskNotifier } = require("../src/modules/supportDesk/infrastructure/notifications/supportDeskNotifier");

const ticket = (overrides = {}) => ({
  id: hex(0x1001), ticketNumber: 3, organizationId: BAYSHORE, requesterUserId: REQUESTER, assigneeUserId: null,
  subject: "QA check", status: "open", priority: "normal", lastCustomerMessageAt: "2026-11-12T09:00:00.000Z",
  updatedAt: "2026-11-12T09:00:00.000Z",
  ...overrides,
});
const message = { id: hex(0x5001), body: "Checking the helpdesk." };
const requester = { id: REQUESTER, name: "Bea Owner", email: "bea@bayshore.test" };

const reset = () => { adminQueries.length = 0; notifications.length = 0; emails.length = 0; };

test("an unowned ticket from a customer organization alerts every RFPilot staff account", async () => {
  reset();
  await supportDeskNotifier.ticketCreated({ ticket: ticket(), requester, message });
  // The staff lookup is not narrowed by the ticket's organization (the production bug:
  // it was, and a customer's organization has no staff, so nobody was alerted).
  assert.equal(adminQueries.length, 1);
  assert.equal("organizationId" in adminQueries[0], false);
  assert.deepEqual(adminQueries[0].role, { $in: ["admin", "super_admin", "superadmin"] });
  assert.deepEqual(adminQueries[0].isBlocked, { $ne: true });
  assert.deepEqual(notifications.map((n) => n.userId).sort(), [STAFF_ONE, STAFF_TWO]);
  // Numbers are per organization, so the alert names the customer's organization.
  assert.ok(notifications.every((n) => n.title === "New support ticket #3 QA check (Bayshore Communication)"));
  assert.ok(notifications.every((n) => n.type === "support_ticket" && n.metadata.audience === "agent"));
});

test("an owned ticket alerts its owner only; an escalation reaches every staff account", async () => {
  reset();
  await supportDeskNotifier.customerReplied({ ticket: ticket({ assigneeUserId: STAFF_TWO }), requester, message });
  assert.equal(adminQueries.length, 0);
  assert.deepEqual(notifications.map((n) => [n.userId, n.title]), [[STAFF_TWO, "Reply on #3 QA check (Bayshore Communication)"]]);

  reset();
  await supportDeskNotifier.ticketEscalated({ ticket: ticket({ assigneeUserId: STAFF_TWO }), assignee: { name: "Eli RFPilot" }, waitingMinutes: 31 });
  assert.equal("organizationId" in adminQueries[0], false);
  assert.deepEqual(notifications.map((n) => n.userId).sort(), [STAFF_ONE, STAFF_TWO]);
});

test("the customer hears from RFPilot support with their own ticket number and no organization label", async () => {
  reset();
  await supportDeskNotifier.agentReplied({ ticket: ticket({ assigneeUserId: STAFF_ONE }), requester, agent: { name: "Dana RFPilot" }, message });
  assert.deepEqual(notifications.map((n) => [n.userId, n.title, n.metadata.audience]), [
    [REQUESTER, "RFPilot support replied on #3 QA check", "requester"],
  ]);
  assert.equal(notifications[0].message.includes("Dana"), false);
});

test("a ticket whose organization cannot be named still alerts staff", async () => {
  reset();
  await supportDeskNotifier.ticketCreated({ ticket: ticket({ organizationId: STAFF_ORG }), requester, message });
  assert.ok(notifications.length === 2 && notifications.every((n) => n.title === "New support ticket #3 QA check"));
});
