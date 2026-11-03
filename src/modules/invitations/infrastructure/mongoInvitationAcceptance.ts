import mongoose from "mongoose";
import Invitation from "../../../../modal/invitationModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import User from "../../../../modal/userModel";
import type { InvitationAcceptanceStore, JoinResult } from "../domain/ports";
import { standingsForUsers } from "./mongoInviteeDirectory";
import { placeInTeam as placeInTeamsModule, type TeamPlacement } from "./teamsInvitationDirectory";

class StaleInvitation extends Error {}
class RefusedJoin extends Error {
  constructor(readonly code: Extract<JoinResult, { kind: "refused" }>["code"]) {
    super(code);
  }
}

type OpenInvitation = { _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; role: string; teamId?: mongoose.Types.ObjectId | null; createdAt: Date };

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

// The membership, the account's organization, the team placement and the invitation's single use
// commit together. The invitation is re-read inside the transaction by its current token, so a
// link that was revoked, resent, expired or used a moment ago can't slip through, and two accepts
// of one link race on the same invitation document: exactly one commits.
export const createMongoInvitationAcceptance = (placeInTeam: TeamPlacement = placeInTeamsModule): InvitationAcceptanceStore => {
  const run = async (
    input: { invitationId: string; tokenHash: string; now: Date },
    resolveUser: (invitation: OpenInvitation, session: mongoose.ClientSession) => Promise<mongoose.Types.ObjectId>,
  ): Promise<JoinResult> => {
    const session = await mongoose.startSession();
    try {
      let userId = "";
      let placedInTeam = false;
      await session.withTransaction(async () => {
        const invitation = await Invitation.findOne({
          _id: input.invitationId,
          tokenHash: input.tokenHash,
          status: "pending",
          expiresAt: { $gt: input.now },
        }).session(session).lean<OpenInvitation | null>();
        if (!invitation) throw new StaleInvitation();
        const organizationId = String(invitation.organizationId);
        const resolvedUserId = await resolveUser(invitation, session);

        await OrganizationMembership.findOneAndUpdate(
          { organizationId: invitation.organizationId, userId: resolvedUserId },
          {
            $set: {
              roles: [invitation.role],
              status: "active",
              invitedAt: invitation.createdAt,
              activatedAt: input.now,
              suspendedAt: null,
              removedAt: null,
            },
            // A returning member's old tokens carry the old version and go stale.
            $inc: { version: 1 },
          },
          { upsert: true, runValidators: true, setDefaultsOnInsert: false, session },
        );
        // Sign-in follows the account's organization, so the account moves with the membership.
        await User.updateOne({ _id: resolvedUserId }, { $set: { organizationId: invitation.organizationId } }, { session });
        const used = await Invitation.updateOne(
          { _id: invitation._id, tokenHash: input.tokenHash, status: "pending" },
          { $set: { status: "accepted", acceptedAt: input.now, acceptedBy: resolvedUserId } },
          { session },
        );
        if (used.modifiedCount !== 1) throw new StaleInvitation();
        placedInTeam = invitation.teamId
          ? await placeInTeam({ organizationId, userId: String(resolvedUserId), teamId: String(invitation.teamId), at: input.now, session })
          : false;
        userId = String(resolvedUserId);
      });
      return { kind: "joined", userId, placedInTeam };
    } catch (error) {
      if (error instanceof StaleInvitation) return { kind: "stale" };
      if (error instanceof RefusedJoin) return { kind: "refused", code: error.code };
      if (isDuplicateKey(error)) return { kind: "account_exists" };
      throw error;
    } finally {
      await session.endSession();
    }
  };

  return {
    joinExistingAccount(input) {
      return run(input, async (invitation, session) => {
        const user = await User.findById(input.userId).select("_id email organizationId isBlocked").session(session).lean<{
          _id: mongoose.Types.ObjectId; email: string; organizationId?: mongoose.Types.ObjectId | null; isBlocked?: boolean;
        } | null>();
        if (!user) throw new StaleInvitation();
        const standing = (await standingsForUsers(String(invitation.organizationId), [user], session)).get(user.email);
        if (standing?.inLegacyHolding) throw new RefusedJoin("LEGACY_ACCOUNT_PENDING_PLACEMENT");
        if (standing?.membershipHere === "active" || standing?.membershipHere === "suspended") throw new RefusedJoin("ALREADY_MEMBER");
        if (standing?.activeElsewhere) throw new RefusedJoin("EMAIL_IN_ANOTHER_ORGANIZATION");
        // Written in the transaction even though it's rewritten below: concurrent accepts by one
        // account (two organizations' invitations) conflict on this document and one aborts.
        await User.updateOne({ _id: user._id }, { $set: { updatedAt: input.now } }, { session });
        return user._id;
      });
    },

    joinNewAccount(input) {
      return run(input, async (invitation, session) => {
        const email = (await Invitation.findById(invitation._id).select("email").session(session).lean<{ email: string } | null>())?.email;
        if (!email) throw new StaleInvitation();
        // Upsert on a fresh id, as signup does, so the model's save hook never re-hashes the hash.
        const user = await User.findOneAndUpdate(
          { _id: new mongoose.Types.ObjectId() },
          {
            $setOnInsert: {
              name: input.name,
              email,
              ...(input.phone ? { phone: input.phone } : {}),
              ...(input.googleId ? { googleId: input.googleId } : {}),
              ...(input.avatar ? { avatar: input.avatar } : {}),
              password: input.passwordHash,
              organizationId: invitation.organizationId,
              role: "customer",
              isBlocked: false,
            },
          },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true, session },
        ).select("_id").lean<{ _id: mongoose.Types.ObjectId } | null>();
        if (!user) throw new Error("Invited account was not created");
        return user._id;
      });
    },
  };
};
