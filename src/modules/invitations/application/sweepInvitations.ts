import { REMINDER_LEAD_MS } from "../domain/invitationRules";
import { MAX_DELIVERY_ATTEMPTS, type InvitationDispatcher } from "./dispatchInvitations";

export const DELIVERY_RETRY_AFTER_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 200;

/* `exceptOrganizationIds`: organizations the pass leaves alone, as if they had no invitations:
   those RFPilot staff blocked (owner decision, 2026-11-18). Their invitations are neither
   expired, reminded nor emailed while the block lasts; the next pass after a reactivation
   treats them like any other. */
export interface InvitationSweepRepository {
  // Pending invitations past their expiry become expired. Returns how many.
  markExpired(now: Date, exceptOrganizationIds?: readonly string[]): Promise<number>;
  // Queues the day-six reminder for invitations whose email went out and that have a day or less
  // left. Each invitation is queued at most once per link lifetime (a resend clears the mark).
  queueReminders(input: { now: Date; leadMs: number; limit: number; exceptOrganizationIds?: readonly string[] }): Promise<string[]>;
  // Emails that never went out, failed, or whose sender died mid-attempt.
  dueDeliveries(input: { now: Date; retryAfterMs: number; maxAttempts: number; limit: number; exceptOrganizationIds?: readonly string[] }): Promise<string[]>;
}

// One pass of the invitation cron: expire, queue reminders, then send whatever is due. Every step
// is a conditional write, so overlapping runs (two cron workers, or a run that overlaps an API
// request delivering the same invitation) never send one email twice.
export const createInvitationSweep = (deps: {
  sweeps: InvitationSweepRepository;
  dispatcher: Pick<InvitationDispatcher, "dispatch">;
  /** Every blocked organization's id (organizationBlock). A failed read fails the pass: nothing
      is expired or emailed on a guess, and the next pass, 15 minutes later, tries again. */
  blockedOrganizationIds?: () => Promise<ReadonlySet<string>>;
  now?: () => Date;
}) => async () => {
  const now = (deps.now ?? (() => new Date()))();
  const exceptOrganizationIds = [...((await deps.blockedOrganizationIds?.()) ?? [])];
  const expired = await deps.sweeps.markExpired(now, exceptOrganizationIds);
  const reminders = await deps.sweeps.queueReminders({ now, leadMs: REMINDER_LEAD_MS, limit: BATCH_LIMIT, exceptOrganizationIds });
  const due = await deps.sweeps.dueDeliveries({ now, retryAfterMs: DELIVERY_RETRY_AFTER_MS, maxAttempts: MAX_DELIVERY_ATTEMPTS, limit: BATCH_LIMIT, exceptOrganizationIds });
  const outcomes = { sent: 0, failed: 0, skipped: 0 };
  for (const id of new Set([...reminders, ...due])) {
    const result = await deps.dispatcher.dispatch(id);
    if (result === "sent") outcomes.sent++;
    else if (result === "failed") outcomes.failed++;
    else outcomes.skipped++;
  }
  return { expired, remindersQueued: reminders.length, ...outcomes };
};
