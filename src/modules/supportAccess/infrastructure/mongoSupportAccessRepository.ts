import mongoose from "mongoose";
import Organization from "../../../../modal/organizationModel";
import Proposal from "../../../../modal/proposalsModel";
import SupportAccessGrant from "../../../../modal/supportAccessGrantModel";
import User from "../../../../modal/userModel";
import VendorResponse from "../../../../modal/vendorResponseModel";
import { attachmentFilename, PRIVATE_UPLOAD_FIELDS } from "../../proposals/infrastructure/mongo/mongoPublicProposalAccessRepository";
import { mongoSupportDeskRepository } from "../../supportDesk/infrastructure/mongo/mongoSupportDeskRepository";
import {
  type GrantedRfpListItem,
  type GrantedRfpReader,
  type SupportAccessDirectory,
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

/* The proposal fields a staff reader is given: the content a planner wrote, its state and its
   dates. An allowlist, so a field added to the model later (or a stray one on an old document)
   is not returned until it is listed here. Not listed: `organizationId`, `__v`,
   `candidateApplicationIds` and `proposalSettings` (internal bookkeeping, as before). */
export const STAFF_PROPOSAL_FIELDS = [
  "userId", "teamId", "status", "isDraft", "isActive", "isFavorite", "isAccepted", "isOpen", "isArchived", "archivedAt",
  "isCopy", "viewsCount", "version", "lifecycle", "event", "venueSchedule", "roomByRoom", "production", "hybridVirtual",
  "contentCreative", "videoRecordingStep", "venue", "uploads", "budget", "contact", "createdAt", "updatedAt",
] as const;

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/* The bare filename of one stored file, or "" when there is none to show. A stored value may be
   a URL (possibly presigned), an object key, or a filename. The query string and fragment go
   first (a signature lives there), then everything up to the last path separator, then the
   numeric upload prefix (the shared helper). A result that still carries "/", "\", "?", "#" or
   a scheme is not a filename and is dropped. */
const staffUploadFilename = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const lastSegment = (text: string) => text.split(/[?#]/)[0].split(/[\\/]/).pop() ?? "";
  // Cut again after the helper decodes: an encoded "/", "?" or "#" must not come back.
  const name = lastSegment(attachmentFilename(lastSegment(value))).trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(name) ? "" : name;
};

const COVENDOR_FIELDS = ["companyName", "contactName", "contactEmail", "contactPhone", "status", "notes"] as const;
const strings = (value: unknown, fields: readonly string[]): Record<string, string> | null => {
  if (!plainObject(value)) return null;
  return Object.fromEntries(fields.flatMap((field) => (typeof value[field] === "string" ? [[field, value[field] as string]] : [])));
};

/* The keys of `uploads` that hold what a planner typed into the proposal form, not a stored
   file. Each is narrowed to the shape the form writes, so a file reference parked under one of
   these keys in some other shape does not ride through. Any key that is neither here nor in
   PRIVATE_UPLOAD_FIELDS is dropped. */
export const STAFF_UPLOAD_TYPED_FIELDS: Record<string, (value: unknown) => unknown> = {
  // A link the planner typed (form field "brand guide URL"); the public proposal page shows it as typed.
  brandGuideUrl: (value) => (typeof value === "string" ? value : undefined),
  // Up to five typed reference links, each `{ url, label }` (Vimeo, YouTube, Behance and so on).
  referenceUrls: (value) => (Array.isArray(value) ? value.flatMap((item) => { const link = strings(item, ["url", "label"]); return link ? [link] : []; }) : undefined),
  // The NDA answer ("YES"/"NO") and the NDA type the planner chose.
  ndaRequired: (value) => (typeof value === "string" || typeof value === "boolean" ? value : undefined),
  ndaType: (value) => (typeof value === "string" ? value : undefined),
  // Typed company and contact details of the five co-vendor kinds; text only.
  coVendors: (value) => {
    if (!plainObject(value)) return undefined;
    return Object.fromEntries(["inHouseVenueAv", "eventDecorator", "registrationTech", "agencyOfRecord", "photographer"].flatMap((kind) => {
      const entry = strings(value[kind], COVENDOR_FIELDS);
      return entry ? [[kind, entry]] : [];
    }));
  },
};

/* `uploads` as staff are given it: an allowlist. `uploads` is stored as Mixed with no shape check
   on write, so nothing is passed through as stored. The seven private file fields come back as
   arrays of bare filenames (a single string counts as one file); the typed fields above come
   back in their form shape; every other key, and an `uploads` that is not a plain object, is
   dropped. A staff answer never carries a link to, or the object key of, a customer's file. */
export const staffUploadsView = (uploads: unknown): Record<string, unknown> => {
  const view: Record<string, unknown> = {};
  if (!plainObject(uploads)) return view;
  for (const field of PRIVATE_UPLOAD_FIELDS) {
    const stored = uploads[field];
    if (stored === undefined || stored === null) continue;
    view[field] = (Array.isArray(stored) ? stored : [stored]).map(staffUploadFilename).filter(Boolean);
  }
  for (const [field, narrow] of Object.entries(STAFF_UPLOAD_TYPED_FIELDS)) {
    const value = narrow(uploads[field]);
    if (value !== undefined) view[field] = value;
  }
  return view;
};

/* The allowlisted fields of one stored proposal, as staff are given them. `uploads` goes
   through `staffUploadsView`, which is stricter than the public proposal view's redaction. */
export const staffProposalFields = (doc: Record<string, unknown>): Record<string, unknown> => {
  const rfp: Record<string, unknown> = {};
  for (const field of STAFF_PROPOSAL_FIELDS) if (doc[field] !== undefined) rfp[field] = doc[field];
  if (rfp.uploads !== undefined) rfp.uploads = staffUploadsView(rfp.uploads);
  return rfp;
};

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
    const doc = await Proposal.findOne({ _id: oid(proposalId), organizationId: oid(organizationId) })
      .select(STAFF_PROPOSAL_FIELDS.join(" ")).lean<Record<string, unknown>>();
    if (!doc) return null;
    const rfp = staffProposalFields(doc);
    const ownerId = doc.userId ? String(doc.userId) : null;
    return {
      rfp: { ...rfp, id: String(doc._id), userId: ownerId, teamId: doc.teamId ? String(doc.teamId) : null },
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
  async find(ticketId) {
    const ticket = await mongoSupportDeskRepository.findTicketInAnyOrganization(ticketId);
    return ticket ? { id: ticket.id, organizationId: ticket.organizationId, requesterUserId: ticket.requesterUserId } : null;
  },
};
