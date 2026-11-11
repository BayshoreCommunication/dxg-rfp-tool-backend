import mongoose from "mongoose";
import Organization from "../../../../modal/organizationModel";
import Proposal from "../../../../modal/proposalsModel";
import SecurityAuditEvent from "../../../../modal/securityAuditEventModel";
import SupportAccessGrant from "../../../../modal/supportAccessGrantModel";
import User from "../../../../modal/userModel";
import VendorResponse from "../../../../modal/vendorResponseModel";
import { mongoSupportDeskRepository } from "../../supportDesk/infrastructure/mongo/mongoSupportDeskRepository";
import {
  SUPPORT_AUDIT,
  type GrantedRfpListItem,
  type GrantedRfpReader,
  type SupportAccessDirectory,
  type SupportActivityLog,
  type SupportGrantRecord,
  type SupportGrantRepository,
  type SupportTicketLookup,
} from "../domain";

const oid = (value: string) => new mongoose.Types.ObjectId(value);
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : value ? String(value) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

// Lower-case only: stored ids are compared as strings, so one spelling per id.
export const isValidSupportAccessId = (value: string) => typeof value === "string" && /^[0-9a-f]{24}$/.test(value);

const grantRecord = (doc: Record<string, unknown>): SupportGrantRecord => ({
  id: String(doc._id),
  organizationId: String(doc.organizationId),
  proposalId: doc.proposalId ? String(doc.proposalId) : null,
  grantedBy: String(doc.grantedBy),
  reason: text(doc.reason),
  createdAt: doc.createdAt as Date,
  expiresAt: doc.expiresAt as Date,
  revokedAt: (doc.revokedAt as Date | null | undefined) ?? null,
  revokedBy: doc.revokedBy ? String(doc.revokedBy) : null,
});

const active = (now: Date) => ({ revokedAt: null, expiresAt: { $gt: now } });
// More active grants than this in one answer means something is wrong; the newest win.
const ACTIVE_LIMIT = 500;

export const mongoSupportGrantRepository: SupportGrantRepository = {
  async create(input) {
    const created = await SupportAccessGrant.create({
      organizationId: oid(input.organizationId),
      proposalId: input.proposalId ? oid(input.proposalId) : null,
      grantedBy: oid(input.grantedBy),
      reason: input.reason,
      expiresAt: input.expiresAt,
    });
    return grantRecord(created.toObject() as unknown as Record<string, unknown>);
  },

  async findInOrganization(organizationId, grantId) {
    const doc = await SupportAccessGrant.findOne({ _id: oid(grantId), organizationId: oid(organizationId) }).lean<Record<string, unknown>>();
    return doc ? grantRecord(doc) : null;
  },

  async listForOrganization(organizationId, page) {
    const [docs, total] = await Promise.all([
      SupportAccessGrant.find({ organizationId: oid(organizationId) })
        .sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit).lean<Record<string, unknown>[]>(),
      SupportAccessGrant.countDocuments({ organizationId: oid(organizationId) }),
    ]);
    return { grants: docs.map(grantRecord), total };
  },

  async revoke({ organizationId, grantId, revokedBy, now }) {
    const updated = await SupportAccessGrant.findOneAndUpdate(
      { _id: oid(grantId), organizationId: oid(organizationId), revokedAt: null },
      { $set: { revokedAt: now, revokedBy: oid(revokedBy) } },
      { new: true },
    ).lean<Record<string, unknown>>();
    if (updated) return { grant: grantRecord(updated), changed: true };
    const existing = await SupportAccessGrant.findOne({ _id: oid(grantId), organizationId: oid(organizationId) }).lean<Record<string, unknown>>();
    return existing ? { grant: grantRecord(existing), changed: false } : null;
  },

  async activeForOrganization(organizationId, now) {
    const docs = await SupportAccessGrant.find({ organizationId: oid(organizationId), ...active(now) })
      .sort({ expiresAt: -1 }).limit(ACTIVE_LIMIT).lean<Record<string, unknown>[]>();
    return docs.map(grantRecord);
  },

  async activeEverywhere(now) {
    // scope-exempt: RFPilot Support's "granted to me" list spans every organization by design.
    const docs = await SupportAccessGrant.find(active(now)).sort({ expiresAt: 1 }).limit(ACTIVE_LIMIT).lean<Record<string, unknown>[]>();
    return docs.map(grantRecord);
  },
};

const eventName = (doc: Record<string, unknown>) => text(((doc.event ?? {}) as Record<string, unknown>).eventName) ?? "Untitled event";

export const mongoSupportAccessDirectory: SupportAccessDirectory = {
  async findRfp(organizationId, proposalId) {
    const doc = await Proposal.findOne({ _id: oid(proposalId), organizationId: oid(organizationId) })
      .select("organizationId userId teamId event.eventName").lean<Record<string, unknown>>();
    if (!doc) return null;
    return {
      id: String(doc._id),
      organizationId: String(doc.organizationId),
      ownerUserId: doc.userId ? String(doc.userId) : null,
      teamId: doc.teamId ? String(doc.teamId) : null,
      title: eventName(doc),
    };
  },

  async rfpTitles(organizationId, proposalIds) {
    if (proposalIds.length === 0) return new Map();
    const docs = await Proposal.find({ _id: { $in: proposalIds.map(oid) }, organizationId: oid(organizationId) })
      .select("event.eventName").lean<Record<string, unknown>[]>();
    return new Map(docs.map((doc) => [String(doc._id), eventName(doc)]));
  },

  async memberNames(organizationId, userIds) {
    if (userIds.length === 0) return new Map();
    const docs = await User.find({ _id: { $in: [...new Set(userIds)].map(oid) }, organizationId: oid(organizationId) }).select("name").lean();
    return new Map(docs.map((doc) => [String(doc._id), String(doc.name ?? "")]));
  },

  async organizationNames(organizationIds) {
    const ids = organizationIds.filter(isValidSupportAccessId);
    if (ids.length === 0) return new Map();
    const docs = await Organization.find({ _id: { $in: ids.map(oid) } }).select("name").lean();
    return new Map(docs.map((doc) => [String(doc._id), String(doc.name ?? "")]));
  },
};

// SecurityAuditEvent rows written by createSupportAccess, read back for the organization that owns them.
export const mongoSupportActivityLog: SupportActivityLog = {
  async summarize(organizationId, grantIds) {
    if (grantIds.length === 0) return new Map();
    const rows = await SecurityAuditEvent.aggregate<{ _id: string; useCount: number; lastUsedAt: Date }>([
      { $match: { organizationId: oid(organizationId), action: SUPPORT_AUDIT.used, "metadata.grantId": { $in: [...grantIds] } } },
      { $group: { _id: "$metadata.grantId", useCount: { $sum: 1 }, lastUsedAt: { $max: "$createdAt" } } },
    ]);
    return new Map(rows.map((row) => [String(row._id), { useCount: row.useCount, lastUsedAt: row.lastUsedAt }]));
  },

  async listForGrant(organizationId, grantId, limit) {
    const docs = await SecurityAuditEvent.find({ organizationId: oid(organizationId), action: SUPPORT_AUDIT.used, "metadata.grantId": grantId })
      .sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map((doc) => ({
      at: doc.createdAt,
      agentId: doc.actorUserId ? String(doc.actorUserId) : null,
      operation: String((doc.metadata as Record<string, unknown> | undefined)?.operation ?? doc.reason),
      targetType: doc.targetType,
      targetId: doc.targetId ?? null,
    }));
  },
};

// Internal bookkeeping a reader never needs (the same fields the admin RFP view hides).
const HIDDEN_FIELDS = ["__v", "organizationId", "candidateApplicationIds", "proposalSettings"];

const owners = async (organizationId: string, userIds: readonly string[]) => {
  if (userIds.length === 0) return new Map<string, GrantedRfpListItem["owner"]>();
  const docs = await User.find({ _id: { $in: [...new Set(userIds)].map(oid) }, organizationId: oid(organizationId) }).select("name email").lean();
  return new Map(docs.map((doc) => [String(doc._id), { id: String(doc._id), name: text(doc.name), email: text(doc.email) }]));
};

export const mongoGrantedRfpReader: GrantedRfpReader = {
  async list(organizationId, filter) {
    const query: Record<string, unknown> = { organizationId: oid(organizationId) };
    if (filter.proposalIds) query._id = { $in: filter.proposalIds.map(oid) };
    if (filter.ownerUserId) query.userId = oid(filter.ownerUserId);
    if (filter.search) query["event.eventName"] = new RegExp(escapeRegex(filter.search), "i");
    const [docs, total] = await Promise.all([
      // tenant-scoped: query always carries the granting organization's id (built above).
      Proposal.find(query)
        .select("userId status isDraft isArchived lifecycle.stage createdAt updatedAt event.eventName event.startDate event.endDate")
        .sort({ updatedAt: -1, _id: -1 }).skip(filter.skip).limit(filter.limit).lean<Record<string, unknown>[]>(),
      // tenant-scoped: query always carries the granting organization's id (built above).
      Proposal.countDocuments(query),
    ]);
    const people = await owners(organizationId, docs.flatMap((doc) => (doc.userId ? [String(doc.userId)] : [])));
    return {
      total,
      rfps: docs.map((doc) => {
        const event = (doc.event ?? {}) as Record<string, unknown>;
        return {
          id: String(doc._id),
          eventName: eventName(doc),
          status: String(doc.status ?? "unsubmitted"),
          stage: text(((doc.lifecycle ?? {}) as Record<string, unknown>).stage),
          isDraft: doc.isDraft === true,
          isArchived: doc.isArchived === true,
          startDate: text(event.startDate),
          endDate: text(event.endDate),
          createdAt: iso(doc.createdAt),
          updatedAt: iso(doc.updatedAt),
          owner: doc.userId ? people.get(String(doc.userId)) ?? null : null,
        };
      }),
    };
  },

  async find(organizationId, proposalId) {
    const doc = await Proposal.findOne({ _id: oid(proposalId), organizationId: oid(organizationId) }).lean<Record<string, unknown>>();
    if (!doc) return null;
    const { _id, ...rest } = doc;
    for (const field of HIDDEN_FIELDS) delete rest[field];
    const ownerId = doc.userId ? String(doc.userId) : null;
    return {
      rfp: { ...rest, id: String(_id), userId: ownerId },
      owner: ownerId ? (await owners(organizationId, [ownerId])).get(ownerId) ?? null : null,
    };
  },

  async vendorResponses(organizationId, proposalId) {
    const docs = await VendorResponse.find({ organizationId: oid(organizationId), proposalId: oid(proposalId) })
      .select("vendorName submittedBy email message documents currentVersionNumber createdAt updatedAt")
      .sort({ createdAt: -1 }).limit(200).lean<Record<string, unknown>[]>();
    return docs.map((doc) => ({
      id: String(doc._id),
      vendorName: text(doc.vendorName),
      submittedBy: text(doc.submittedBy),
      email: text(doc.email),
      message: text(doc.message),
      documentCount: Array.isArray(doc.documents) ? doc.documents.length : 0,
      currentVersionNumber: Number(doc.currentVersionNumber ?? 0),
      createdAt: iso(doc.createdAt),
      updatedAt: iso(doc.updatedAt),
    }));
  },
};

export const mongoSupportTicketLookup: SupportTicketLookup = {
  async find(agentOrganizationId, ticketId) {
    const ticket = await mongoSupportDeskRepository.findTicket(agentOrganizationId, ticketId);
    return ticket ? { id: ticket.id, organizationId: ticket.organizationId, requesterUserId: ticket.requesterUserId } : null;
  },
};
