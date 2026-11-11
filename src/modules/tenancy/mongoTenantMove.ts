import mongoose, { type ClientSession, type Model } from "mongoose";
import EmailCampaign from "../../../modal/emailModel";
import Notification from "../../../modal/notificationModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import ProposalCanonicalSnapshot from "../../../modal/proposalCanonicalSnapshotModel";
import Proposal from "../../../modal/proposalsModel";
import PublicAccessGrant from "../../../modal/publicAccessGrantModel";
import RefreshSession from "../../../modal/refreshSessionModel";
import Settings from "../../../modal/settingsModel";
import SupportAttachment from "../../../modal/supportAttachmentModel";
import SupportMessage from "../../../modal/supportMessageModel";
import SupportTicket from "../../../modal/supportTicketModel";
import User from "../../../modal/userModel";
import VendorConfirmationDelivery from "../../../modal/vendorConfirmationDeliveryModel";
import VendorResponseQuestionnaireVersion from "../../../modal/vendorResponseQuestionnaireVersionModel";
import VendorResponse from "../../../modal/vendorResponseModel";
import VendorSubmissionDraft from "../../../modal/vendorSubmissionDraftModel";
import VendorSubmission from "../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../modal/vendorSubmissionVersionModel";

// Which MongoDB documents belong to one customer, for moving them between organizations
// (ORG-107, reused by ORG-110). Not moved: security audit events (append-only history that stays
// with the organization it happened in), support canned replies (staff-owned), admins.
// Memberships are moved separately because their roles change with them.

type AnyModel = Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Rule = { name: string; model: AnyModel; filter: (ids: OwnedIds) => Record<string, unknown> };
type OwnedIds = { userId: mongoose.Types.ObjectId; proposalIds: mongoose.Types.ObjectId[]; ticketIds: mongoose.Types.ObjectId[] };
export type MongoMoveCounts = Record<string, number>;
// _ids of the documents a move changed, per collection (ORG-110 rolls back exactly these).
export type MovedDocumentIds = Record<string, unknown[]>;

const OWNED_BY_USER: Rule[] = [
  { name: "users", model: User, filter: ({ userId }) => ({ _id: userId }) },
  { name: "proposals", model: Proposal, filter: ({ userId }) => ({ userId }) },
  { name: "settings", model: Settings, filter: ({ userId }) => ({ userId }) },
  { name: "emailcampaigns", model: EmailCampaign, filter: ({ userId }) => ({ userId }) },
  { name: "notifications", model: Notification, filter: ({ userId }) => ({ userId }) },
  { name: "refreshsessions", model: RefreshSession, filter: ({ userId }) => ({ userId }) },
  { name: "supporttickets", model: SupportTicket, filter: ({ userId }) => ({ requesterUserId: userId }) },
];
const OWNED_THROUGH_PROPOSALS: Rule[] = [
  ...[VendorResponse, VendorSubmission, VendorSubmissionVersion, VendorSubmissionDraft, VendorConfirmationDelivery, VendorResponseQuestionnaireVersion]
    .map((model) => ({ name: model.collection.collectionName, model: model as AnyModel, filter: ({ proposalIds }: OwnedIds) => ({ proposalId: { $in: proposalIds } }) })),
  { name: "proposalcanonicalsnapshots", model: ProposalCanonicalSnapshot, filter: ({ proposalIds }) => ({ legacyProposalId: { $in: proposalIds } }) },
  { name: "publicaccessgrants", model: PublicAccessGrant, filter: ({ proposalIds }) => ({ resourceId: { $in: proposalIds } }) },
];
const OWNED_THROUGH_TICKETS: Rule[] = [
  { name: "supportmessages", model: SupportMessage, filter: ({ ticketIds }) => ({ ticketId: { $in: ticketIds } }) },
  { name: "supportattachments", model: SupportAttachment, filter: ({ ticketIds }) => ({ ticketId: { $in: ticketIds } }) },
];
export const MOVABLE_COLLECTIONS = [...OWNED_BY_USER, ...OWNED_THROUGH_PROPOSALS, ...OWNED_THROUGH_TICKETS].map((rule) => rule.name);

const objectId = (value: unknown) => new mongoose.Types.ObjectId(String(value));

const ownedIds = async (from: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, session?: ClientSession): Promise<OwnedIds> => {
  const proposals = await Proposal.collection.find({ organizationId: from, userId }, { projection: { _id: 1 }, session }).toArray();
  const tickets = await SupportTicket.collection.find({ organizationId: from, requesterUserId: userId }, { projection: { _id: 1 }, session }).toArray();
  return { userId, proposalIds: proposals.map((p) => p._id as mongoose.Types.ObjectId), ticketIds: tickets.map((t) => t._id as mongoose.Types.ObjectId) };
};

// Counts (dry run) or moves (apply) one customer's documents. Raw collection writes on purpose:
// they change only organizationId and skip model hooks such as the user's password hashing.
// With movedIds (apply only, inside the caller's transaction), records each moved document's _id.
export const moveCustomerDocuments = async (input: {
  fromOrganizationId: string; toOrganizationId: string; userId: string; apply: boolean; session?: ClientSession; movedIds?: MovedDocumentIds;
}): Promise<MongoMoveCounts> => {
  const from = objectId(input.fromOrganizationId);
  const to = objectId(input.toOrganizationId);
  const ids = await ownedIds(from, objectId(input.userId), input.session);
  const counts: MongoMoveCounts = {};
  for (const rule of [...OWNED_THROUGH_TICKETS, ...OWNED_THROUGH_PROPOSALS, ...OWNED_BY_USER]) {
    let filter: Record<string, unknown> = { ...rule.filter(ids), organizationId: from };
    if (input.apply && input.movedIds) {
      const docs = await rule.model.collection.find(filter, { projection: { _id: 1 }, session: input.session }).toArray();
      if (docs.length) input.movedIds[rule.name] = docs.map((d) => d._id);
      filter = { _id: { $in: docs.map((d) => d._id) }, organizationId: from };
    }
    const n = input.apply
      ? (await rule.model.collection.updateMany(filter, { $set: { organizationId: to } }, { session: input.session })).modifiedCount
      : await rule.model.collection.countDocuments(filter, { session: input.session });
    if (n) counts[rule.name] = n;
  }
  return counts;
};

// Moves exactly the documents a journaled move recorded; ones that have since left `from` stay.
export const moveDocumentsById = async (input: {
  fromOrganizationId: string; toOrganizationId: string; ids: MovedDocumentIds; session?: ClientSession;
}): Promise<MongoMoveCounts> => {
  const from = objectId(input.fromOrganizationId);
  const to = objectId(input.toOrganizationId);
  const rules = new Map([...OWNED_BY_USER, ...OWNED_THROUGH_PROPOSALS, ...OWNED_THROUGH_TICKETS].map((rule) => [rule.name, rule]));
  const counts: MongoMoveCounts = {};
  for (const [name, ids] of Object.entries(input.ids)) {
    const rule = rules.get(name);
    if (!rule || ids.length === 0) continue;
    const n = (await rule.model.collection.updateMany({ _id: { $in: ids as mongoose.Types.ObjectId[] }, organizationId: from }, { $set: { organizationId: to } }, { session: input.session })).modifiedCount;
    if (n) counts[name] = n;
  }
  return counts;
};

// Rollback: everything in the holding organization goes back.
export const moveAllDocuments = async (input: {
  fromOrganizationId: string; toOrganizationId: string; session?: ClientSession;
}): Promise<MongoMoveCounts> => {
  const from = objectId(input.fromOrganizationId);
  const to = objectId(input.toOrganizationId);
  const counts: MongoMoveCounts = {};
  for (const rule of [...OWNED_BY_USER, ...OWNED_THROUGH_PROPOSALS, ...OWNED_THROUGH_TICKETS]) {
    const n = (await rule.model.collection.updateMany({ organizationId: from }, { $set: { organizationId: to } }, { session: input.session })).modifiedCount;
    if (n) counts[rule.name] = n;
  }
  return counts;
};

// Moves the customer's membership with them as a plain Planner (DXG roles stripped) and returns
// what it was, for rollback. A customer with no membership gets one.
export const moveMembership = async (input: {
  fromOrganizationId: string; toOrganizationId: string; userId: string; runId: string; session?: ClientSession;
}): Promise<{ previousRoles: string[] | null; previousVersion: number | null; previousStatus: string | null }> => {
  const filter = { organizationId: objectId(input.fromOrganizationId), userId: objectId(input.userId) };
  const existing = await OrganizationMembership.collection.findOne(filter, { session: input.session });
  if (existing) {
    await OrganizationMembership.collection.updateOne(filter, {
      $set: { organizationId: objectId(input.toOrganizationId), roles: ["planner"], status: "active", migrationRunId: input.runId, updatedAt: new Date() },
      $inc: { version: 1 },
    }, { session: input.session });
    return { previousRoles: existing.roles as string[], previousVersion: Number(existing.version ?? 1), previousStatus: String(existing.status ?? "active") };
  }
  const now = new Date();
  await OrganizationMembership.collection.insertOne({
    organizationId: objectId(input.toOrganizationId), userId: objectId(input.userId), roles: ["planner"], status: "active",
    version: 1, activatedAt: now, migrationRunId: input.runId, createdAt: now, updatedAt: now,
  }, { session: input.session });
  return { previousRoles: null, previousVersion: null, previousStatus: null };
};

export const restoreMembership = async (input: {
  holdingOrganizationId: string; fromOrganizationId: string; userId: string;
  previousRoles: string[] | null; previousVersion: number | null; previousStatus?: string | null; session?: ClientSession;
}): Promise<void> => {
  const filter = { organizationId: objectId(input.holdingOrganizationId), userId: objectId(input.userId) };
  if (!input.previousRoles) {
    await OrganizationMembership.collection.deleteOne(filter, { session: input.session });
    return;
  }
  const current = await OrganizationMembership.collection.findOne(filter, { session: input.session });
  await OrganizationMembership.collection.updateOne(filter, {
    $set: {
      organizationId: objectId(input.fromOrganizationId), roles: input.previousRoles, updatedAt: new Date(),
      // The move made the membership active; one that was suspended or removed goes back as it was.
      // Runs journaled before ORG-501 recorded no status and keep the old behaviour.
      ...(input.previousStatus ? { status: input.previousStatus } : {}),
      // Past both the original and the moved version, so no token issued for either still matches.
      version: Math.max(Number(current?.version ?? 1), Number(input.previousVersion ?? 1)) + 1,
    },
    $unset: { migrationRunId: "" },
  }, { session: input.session });
};
