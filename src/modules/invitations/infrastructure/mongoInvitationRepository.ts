import mongoose from "mongoose";
import Invitation from "../../../../modal/invitationModel";
import type { InvitationRecord, InvitationRepository } from "../domain/ports";

// Enough old links to tell "a newer email was sent" apart from "never valid" for every resend and
// reminder an invitation can realistically get.
const PREVIOUS_TOKEN_LIMIT = 20;
const LIST_LIMIT = 1000;

type InvitationDocument = {
  _id: unknown;
  organizationId: unknown;
  email: string;
  role: InvitationRecord["role"];
  teamId?: unknown;
  invitedBy: unknown;
  status: InvitationRecord["status"];
  expiresAt: Date;
  createdAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  delivery?: { state?: InvitationRecord["delivery"]["state"]; kind?: InvitationRecord["delivery"]["kind"]; attempts?: number; sentAt?: Date | null };
};

export const toInvitationRecord = (doc: InvitationDocument): InvitationRecord => ({
  id: String(doc._id),
  organizationId: String(doc.organizationId),
  email: doc.email,
  role: doc.role,
  teamId: doc.teamId ? String(doc.teamId) : null,
  invitedBy: String(doc.invitedBy),
  status: doc.status,
  expiresAt: doc.expiresAt,
  createdAt: doc.createdAt,
  acceptedAt: doc.acceptedAt ?? null,
  revokedAt: doc.revokedAt ?? null,
  delivery: {
    state: doc.delivery?.state ?? "pending",
    kind: doc.delivery?.kind ?? "invite",
    attempts: doc.delivery?.attempts ?? 0,
    sentAt: doc.delivery?.sentAt ?? null,
  },
});

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;
const isObjectId = (value: string) => mongoose.isValidObjectId(value) && /^[a-f0-9]{24}$/i.test(value);

// Moves the current link (if any) onto the list of replaced ones, keeping the most recent.
const retireCurrentToken = {
  $slice: [
    { $concatArrays: [{ $ifNull: ["$previousTokenHashes", []] }, { $cond: [{ $eq: [{ $type: "$tokenHash" }, "string"] }, ["$tokenHash"], []] }] },
    -PREVIOUS_TOKEN_LIMIT,
  ],
};

export const mongoInvitationRepository: InvitationRepository = {
  async insertPending(input) {
    try {
      const [doc] = await Invitation.create([{
        organizationId: input.organizationId,
        email: input.email,
        role: input.role,
        teamId: input.teamId,
        invitedBy: input.invitedBy,
        status: "pending",
        expiresAt: input.expiresAt,
        delivery: { state: "pending", kind: "invite", attempts: 0 },
      }]);
      return { kind: "created", invitation: toInvitationRecord(doc.toObject()) };
    } catch (error) {
      if (isDuplicateKey(error)) return { kind: "duplicate" };
      throw error;
    }
  },

  async findById(organizationId, id) {
    if (!isObjectId(id)) return null;
    const doc = await Invitation.findOne({ _id: id, organizationId }).lean<InvitationDocument>();
    return doc ? toInvitationRecord(doc) : null;
  },

  async list(organizationId, filter) {
    // A pending row past its expiry reads as expired, so "expired" also looks at pending rows.
    const status = filter.status === "expired" ? { $in: ["pending", "expired"] } : filter.status;
    const docs = await Invitation.find({ organizationId, ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .limit(LIST_LIMIT)
      .lean<InvitationDocument[]>();
    return docs.map(toInvitationRecord);
  },

  async pendingEmails(organizationId, emails, now) {
    if (!emails.length) return new Set();
    const docs = await Invitation.find({ organizationId, status: "pending", expiresAt: { $gt: now }, email: { $in: emails } })
      .select("email")
      .lean<{ email: string }[]>();
    return new Set(docs.map((doc) => doc.email));
  },

  async findByTokenHash(tokenHash) {
    const current = await Invitation.findOne({ tokenHash }).lean<InvitationDocument>();
    if (current) return { invitation: toInvitationRecord(current), current: true };
    const replaced = await Invitation.findOne({ previousTokenHashes: tokenHash }).lean<InvitationDocument>();
    return replaced ? { invitation: toInvitationRecord(replaced), current: false } : null;
  },

  async prepareResend(organizationId, id, input) {
    if (!isObjectId(id)) return null;
    try {
      // An expired row whose email has since been re-invited hits the one-pending index and is
      // refused; the newer invitation is the one to resend.
      const doc = await Invitation.findOneAndUpdate(
        { _id: id, organizationId, status: { $in: ["pending", "expired"] } },
        [{
          $set: {
            status: "pending",
            expiredAt: null,
            expiresAt: input.expiresAt,
            previousTokenHashes: retireCurrentToken,
            tokenHash: null,
            tokenIssuedAt: null,
            reminderQueuedAt: null,
            delivery: { state: "pending", kind: "resend", attempts: 0, leaseUntil: null, lastAttemptAt: null, sentAt: null },
            updatedAt: input.now,
          },
        }],
        { new: true },
      ).lean<InvitationDocument>();
      return doc ? toInvitationRecord(doc) : null;
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  },

  async revoke(organizationId, id, input) {
    if (!isObjectId(id)) return null;
    // The token hash stays, so the withdrawn link gets its own answer.
    const doc = await Invitation.findOneAndUpdate(
      { _id: id, organizationId, status: "pending" },
      { $set: { status: "revoked", revokedAt: input.now, revokedBy: input.by } },
      { new: true },
    ).lean<InvitationDocument>();
    return doc ? toInvitationRecord(doc) : null;
  },

  async claimDelivery(id, input) {
    if (!isObjectId(id)) return null;
    const doc = await Invitation.findOneAndUpdate(
      {
        _id: id,
        status: "pending",
        expiresAt: { $gt: input.now },
        "delivery.attempts": { $lt: input.maxAttempts },
        $or: [
          { "delivery.state": { $in: ["pending", "failed"] } },
          { "delivery.state": "sending", "delivery.leaseUntil": { $lte: input.now } },
        ],
      },
      [{
        $set: {
          previousTokenHashes: retireCurrentToken,
          tokenHash: input.tokenHash,
          tokenIssuedAt: input.now,
          delivery: {
            $mergeObjects: [
              "$delivery",
              {
                state: "sending",
                leaseUntil: input.leaseUntil,
                lastAttemptAt: input.now,
                attempts: { $add: [{ $ifNull: ["$delivery.attempts", 0] }, 1] },
              },
            ],
          },
        },
      }],
      { new: true },
    ).lean<InvitationDocument>();
    return doc ? toInvitationRecord(doc) : null;
  },

  async completeDelivery(id, input) {
    await Invitation.updateOne(
      { _id: id, tokenHash: input.tokenHash, "delivery.state": "sending" },
      {
        $set: {
          "delivery.state": input.outcome,
          "delivery.leaseUntil": null,
          ...(input.outcome === "sent" ? { "delivery.sentAt": input.now } : {}),
        },
      },
    );
  },
};
