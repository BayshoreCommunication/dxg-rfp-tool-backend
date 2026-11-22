import mongoose from "mongoose";
import Invitation from "../../../../modal/invitationModel";
import type { InvitationSweepRepository } from "../application/sweepInvitations";

// The invitation cron is cross-tenant by design: it walks every organization's open invitations,
// except those of the organizations it is told to leave alone (blocked by RFPilot staff).
const except = (organizationIds: readonly string[] | undefined) =>
  organizationIds?.length ? { organizationId: { $nin: organizationIds.map((id) => new mongoose.Types.ObjectId(id)) } } : {};

export const mongoInvitationSweepRepository: InvitationSweepRepository = {
  async markExpired(now, exceptOrganizationIds) {
    const result = await Invitation.updateMany(
      { status: "pending", expiresAt: { $lte: now }, ...except(exceptOrganizationIds) },
      { $set: { status: "expired", expiredAt: now } },
    );
    return result.modifiedCount;
  },

  async queueReminders({ now, leadMs, limit, exceptOrganizationIds }) {
    const window = { ...except(exceptOrganizationIds), status: "pending", expiresAt: { $gt: now, $lte: new Date(now.getTime() + leadMs) }, reminderQueuedAt: null, "delivery.state": "sent" };
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

  async dueDeliveries({ now, retryAfterMs, maxAttempts, limit, exceptOrganizationIds }) {
    const retryBefore = new Date(now.getTime() - retryAfterMs);
    const docs = await Invitation.find({
      ...except(exceptOrganizationIds),
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
