// ORG-204: the invitation cron against real Mongo with a controllable clock and a fake mailer:
// day-six reminder (once, with a fresh link), expiry, and retry of a failed send.
import { TEST_MONGODB_DB_NAME } from './env';
import { connectMongo, disconnectMongo, randomMongoId } from './setup';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import Invitation from '../modal/invitationModel';
import Organization from '../modal/organizationModel';
import User from '../modal/userModel';
import { createInvitationModule } from '../src/modules/invitations/composition';
import type { InvitationEmail } from '../src/modules/invitations/domain/ports';
import { closePostgres } from '../config/postgres';

const DAY = 24 * 60 * 60 * 1000;
const tag = randomMongoId().slice(0, 10);
const organizationIds: unknown[] = [];
let clock = new Date();
const sent: InvitationEmail[] = [];
let failNext = 0;
const mailer = {
  async send(email: InvitationEmail) {
    if (failNext > 0) { failNext--; throw new Error('provider down'); }
    sent.push(email);
  },
};
const invitationModule = createInvitationModule({ mailer, now: () => clock });
let actor: { organizationId: string; userId: string; roles: string[]; managedTeamIds: string[] };
const tokenOf = (email: InvitationEmail) => email.acceptUrl.split('/invite/')[1];
const sentTo = (to: string) => sent.filter((email) => email.to === to);

before(async () => {
  await connectMongo();
  assert.equal(mongoose.connection.name, TEST_MONGODB_DB_NAME);
  await Invitation.init();
  const organization = await Organization.create({ name: 'Reminder Co', slug: `intg-remind-${tag}` });
  organizationIds.push(organization._id);
  const inviter = await User.create({ name: 'Rita Inviter', email: `inviter-${tag}@example.com`, password: 'x'.repeat(20), organizationId: organization._id });
  actor = { organizationId: String(organization._id), userId: String(inviter._id), roles: ['owner'], managedTeamIds: [] };
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    await Invitation.deleteMany({ organizationId: { $in: organizationIds } });
    await User.deleteMany({ email: `inviter-${tag}@example.com` });
    await Organization.deleteMany({ _id: { $in: organizationIds } });
  }
  await disconnectMongo();
  await closePostgres();
});

const invite = async (who: string) => {
  const to = `${who}-${tag}@example.com`;
  const outcome = await invitationModule.service.create(actor, { email: to, role: 'planner' }, randomMongoId());
  assert.equal(outcome.kind, 'done');
  return { to, row: (outcome as any).rows[0] };
};

test('the invitation email carries organization, inviter and role and links to the dashboard accept page', async () => {
  const { to, row } = await invite('first');
  assert.equal(row.outcome, 'invited');
  const [email] = sentTo(to);
  assert.equal(email.kind, 'invite');
  assert.equal(email.organizationName, 'Reminder Co');
  assert.equal(email.inviterName, 'Rita Inviter');
  assert.equal(email.role, 'planner');
  assert.match(email.acceptUrl, /^https?:\/\/[^/]+\/invite\/[A-Za-z0-9_-]{43}$/);
});

test('the reminder goes out once on day six with a fresh link; the original link then says a newer one was sent', async () => {
  const start = new Date();
  clock = start;
  const { to } = await invite('remind');
  const original = tokenOf(sentTo(to)[0]);

  clock = new Date(start.getTime() + 5 * DAY);
  await invitationModule.sweep();
  assert.equal(sentTo(to).length, 1, 'no reminder on day five');

  clock = new Date(start.getTime() + 6 * DAY + 60_000);
  const result = await invitationModule.sweep();
  assert.ok(result.remindersQueued >= 1);
  const reminders = sentTo(to).filter((email) => email.kind === 'reminder');
  assert.equal(reminders.length, 1);
  const fresh = tokenOf(reminders[0]);
  assert.notEqual(fresh, original);
  assert.equal((await invitationModule.service.lookup(fresh)).kind, 'found');
  assert.equal((await invitationModule.service.lookup(original) as any).code, 'INVITATION_SUPERSEDED');
  // The reminder doesn't extend the expiry.
  assert.equal(new Date(reminders[0].expiresAt).getTime(), start.getTime() + 7 * DAY);

  clock = new Date(start.getTime() + 6 * DAY + 2 * 60 * 60_000);
  await invitationModule.sweep();
  assert.equal(sentTo(to).filter((email) => email.kind === 'reminder').length, 1, 'only one reminder');
});

test('a resend clears the reminder mark and restarts the week; the sweep expires what is left', async () => {
  const start = new Date();
  clock = start;
  const { to, row } = await invite('resend');
  clock = new Date(start.getTime() + 6 * DAY + 60_000);
  await invitationModule.sweep();
  assert.equal(sentTo(to).filter((email) => email.kind === 'reminder').length, 1);

  const resent = await invitationModule.service.resend(actor, row.invitation.id, randomMongoId());
  assert.equal(resent.kind, 'resent');
  assert.equal(sentTo(to).at(-1)!.kind, 'resend');
  const stored = await Invitation.findById(row.invitation.id).lean();
  assert.equal(stored!.reminderQueuedAt, null);

  // Day six of the new week brings a new reminder.
  clock = new Date(clock.getTime() + 6 * DAY + 60_000);
  await invitationModule.sweep();
  assert.equal(sentTo(to).filter((email) => email.kind === 'reminder').length, 2);

  clock = new Date(clock.getTime() + 2 * DAY);
  await invitationModule.sweep();
  const expired = await Invitation.findById(row.invitation.id).lean();
  assert.equal(expired!.status, 'expired');
  assert.ok(expired!.expiredAt);
  assert.equal((await invitationModule.service.lookup(tokenOf(sentTo(to).at(-1)!)) as any).code, 'INVITATION_EXPIRED');
});

test('a failed send is retried by the sweep after the back-off, with a new link', async () => {
  clock = new Date();
  failNext = 1;
  const { to, row } = await invite('retry');
  assert.equal(row.invitation.emailDelivery, 'failed');
  assert.equal(sentTo(to).length, 0);

  clock = new Date(clock.getTime() + 60_000);
  await invitationModule.sweep();
  assert.equal(sentTo(to).length, 0, 'not before the back-off');

  clock = new Date(clock.getTime() + 6 * 60_000);
  await invitationModule.sweep();
  assert.equal(sentTo(to).length, 1);
  const stored = await Invitation.findById(row.invitation.id).lean();
  assert.equal(stored!.delivery.state, 'sent');
  assert.equal(stored!.delivery.attempts, 2);
  assert.equal((await invitationModule.service.lookup(tokenOf(sentTo(to)[0]))).kind, 'found');
});
