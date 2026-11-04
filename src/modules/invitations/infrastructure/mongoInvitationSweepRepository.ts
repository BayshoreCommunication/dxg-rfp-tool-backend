import Invitation from "../../../../modal/invitationModel";
import type { InvitationSweepRepository } from "../application/sweepInvitations";

// The invitation cron is cross-tenant by design: it walks every organization's open invitations.
export const mongoInvitationSweepRepository: InvitationSweepRepository = {
  async markExpired(now) {
    const result = await Invitation.updateMany(
      { status: "pending", expiresAt: { $lte: now } },
      { $set: { status: "expired", expiredAt: now } },
    );
    return result.modifiedCount;
  },

  async queueReminders({ now, leadMs, limit }) {
    const window = { status: "pending", expiresAt: { $gt: now, $lte: new Date(now.getTime() + leadMs) }, reminderQueuedAt: null, "delivery.state": "sent" };
    const candidates = await Invitation.find(window).select("_id").limit(limit).lean<{ _id: unknown }[]>();
    const queued: string[] = [];
    for (const { _id } of candidates) {
      // Conditional on the same window, so a concurrent sweep or a resend in between wins cleanly.
      const result = await Invitation.updateOne(
        { _id, ...window },
        { $set: { reminderQueuedAt: now, delivery: { state: "pending", kind: "reminder", attempts: 0, leaseUntil: null, lastAttemptAt: null, sentAt: null } } },
      );
      if (result.modifiedCount === 1) queued.push(String(_id));
    }
    return queued;
  },

  async dueDeliveries({ now, retryAfterMs, maxAttempts, limit }) {
    const retryBefore = new Date(now.getTime() - retryAfterMs);
    const docs = await Invitation.find({
      status: "pending",
      expiresAt: { $gt: now },
      "delivery.attempts": { $lt: maxAttempts },
      $or: [
        // Never attempted and not just created: bulk sends in the background right after insert.
        { "delivery.state": "pending", "delivery.lastAttemptAt": null, updatedAt: { $lte: retryBefore } },
        { "delivery.state": "failed", "delivery.lastAttemptAt": { $lte: retryBefore } },
        { "delivery.state": "sending", "delivery.leaseUntil": { $lte: now } },
      ],
    }).select("_id").sort({ updatedAt: 1 }).limit(limit).lean<{ _id: unknown }[]>();
    return docs.map((doc) => String(doc._id));
  },
};
