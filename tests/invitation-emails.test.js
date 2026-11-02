require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { renderInvitationEmail } = require("../src/modules/invitations/infrastructure/invitationEmailTemplate");
const { createTransactionalInvitationMailer } = require("../src/modules/invitations/infrastructure/invitationMailer");
const { createInvitationSweep } = require("../src/modules/invitations/application/sweepInvitations");
const { REMINDER_LEAD_MS } = require("../src/modules/invitations/domain/invitationRules");

const base = {
  kind: "invite",
  to: "new.planner@example.com",
  organizationName: "Acme Events",
  inviterName: "Ada Admin",
  role: "team_manager",
  teamName: null,
  acceptUrl: "https://app.example.com/invite/abcDEF123_-",
  expiresAt: new Date("2026-11-09T12:00:00Z"),
};

test("the invitation names the organization, the inviter and the role, and links to the accept page", () => {
  const email = renderInvitationEmail(base);
  assert.equal(email.subject, "Ada Admin invited you to join Acme Events on RFPilot");
  for (const part of [email.html, email.text]) {
    assert.ok(part.includes("Acme Events"));
    assert.ok(part.includes("Ada Admin"));
    assert.ok(part.includes("Team Manager"));
    assert.ok(part.includes("https://app.example.com/invite/abcDEF123_-"));
    assert.ok(part.includes("November 9, 2026"));
  }
  assert.ok(email.html.includes('href="https://app.example.com/invite/abcDEF123_-"'));
  assert.ok(!email.text.includes("replaces"));
});

test("a team invitation names the team; a missing inviter still reads well", () => {
  const email = renderInvitationEmail({ ...base, role: "planner", teamName: "East Coast", inviterName: null });
  assert.equal(email.subject, "You're invited to join Acme Events on RFPilot");
  assert.ok(email.text.includes("You've been invited to join Acme Events on RFPilot as a Planner in the East Coast team."));
});

test("resend and reminder say the link replaces earlier ones; the reminder says it expires tomorrow", () => {
  const resend = renderInvitationEmail({ ...base, kind: "resend" });
  assert.ok(resend.text.includes("replaces any earlier invitation link"));
  const reminder = renderInvitationEmail({ ...base, kind: "reminder" });
  assert.match(reminder.subject, /^Reminder: .*expires tomorrow$/);
  assert.ok(reminder.html.includes("expires tomorrow"));
  assert.ok(reminder.text.includes("replaces any earlier invitation link"));
});

test("names are escaped in HTML and flattened in the subject", () => {
  const email = renderInvitationEmail({ ...base, organizationName: 'Evil <script>alert(1)</script>\r\nBcc: x@example.com', inviterName: '"Mallory" <img src=x>' });
  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<img"));
  assert.ok(email.html.includes("&lt;script&gt;"));
  assert.ok(!/[\r\n]/.test(email.subject));
});

test("the mail adapter sends the rendered email through the existing mail module, to the invitee only", async () => {
  const sent = [];
  const mailer = createTransactionalInvitationMailer(async (message) => { sent.push(message); });
  await mailer.send(base);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["html", "subject", "text", "to"]);
  assert.equal(sent[0].to, "new.planner@example.com");
  assert.equal(sent[0].subject, renderInvitationEmail(base).subject);
});

test("one sweep expires, queues reminders with a day's lead, and sends what is due once", async () => {
  const calls = [];
  const dispatched = [];
  const sweep = createInvitationSweep({
    now: () => new Date("2026-11-08T12:00:00Z"),
    sweeps: {
      async markExpired(now) { calls.push(["expire", now.toISOString()]); return 2; },
      async queueReminders(input) { calls.push(["remind", input.leadMs]); return ["r1", "shared"]; },
      async dueDeliveries(input) { calls.push(["due", input.maxAttempts]); return ["d1", "shared"]; },
    },
    dispatcher: { async dispatch(id) { dispatched.push(id); return id === "d1" ? "failed" : "sent"; } },
  });
  const result = await sweep();
  assert.deepEqual(calls, [["expire", "2026-11-08T12:00:00.000Z"], ["remind", REMINDER_LEAD_MS], ["due", 5]]);
  assert.equal(REMINDER_LEAD_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual(dispatched, ["r1", "shared", "d1"]);
  assert.deepEqual(result, { expired: 2, remindersQueued: 2, sent: 2, failed: 1, skipped: 0 });
});
