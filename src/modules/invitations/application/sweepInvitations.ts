import { REMINDER_LEAD_MS } from "../domain/invitationRules";
import { MAX_DELIVERY_ATTEMPTS, type InvitationDispatcher } from "./dispatchInvitations";

export const DELIVERY_RETRY_AFTER_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 200;

export interface InvitationSweepRepository {
  // Pending invitations past their expiry become expired. Returns how many.
  markExpired(now: Date): Promise<number>;
  // Queues the day-six reminder for invitations whose email went out and that have a day or less
  // left. Each invitation is queued at most once per link lifetime (a resend clears the mark).
  queueReminders(input: { now: Date; leadMs: number; limit: number }): Promise<string[]>;
  // Emails that never went out, failed, or whose sender died mid-attempt.
  dueDeliveries(input: { now: Date; retryAfterMs: number; maxAttempts: number; limit: number }): Promise<string[]>;
}

// One pass of the invitation cron: expire, queue reminders, then send whatever is due. Every step
// is a conditional write, so overlapping runs (two cron workers, or a run that overlaps an API
// request delivering the same invitation) never send one email twice.
export const createInvitationSweep = (deps: {
  sweeps: InvitationSweepRepository;
  dispatcher: Pick<InvitationDispatcher, "dispatch">;
  now?: () => Date;
}) => async () => {
  const now = (deps.now ?? (() => new Date()))();
  const expired = await deps.sweeps.markExpired(now);
  const reminders = await deps.sweeps.queueReminders({ now, leadMs: REMINDER_LEAD_MS, limit: BATCH_LIMIT });
  const due = await deps.sweeps.dueDeliveries({ now, retryAfterMs: DELIVERY_RETRY_AFTER_MS, maxAttempts: MAX_DELIVERY_ATTEMPTS, limit: BATCH_LIMIT });
  const outcomes = { sent: 0, failed: 0, skipped: 0 };
  for (const id of new Set([...reminders, ...due])) {
    const result = await deps.dispatcher.dispatch(id);
    if (result === "sent") outcomes.sent++;
    else if (result === "failed") outcomes.failed++;
    else outcomes.skipped++;
  }
  return { expired, remindersQueued: reminders.length, ...outcomes };
};
