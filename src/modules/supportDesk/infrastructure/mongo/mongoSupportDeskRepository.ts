import mongoose from "mongoose";
import SupportTicket, { SupportTicketCounter } from "../../../../../modal/supportTicketModel";
import SupportMessage from "../../../../../modal/supportMessageModel";
import SupportCannedReply from "../../../../../modal/supportCannedReplyModel";
import SupportAttachment from "../../../../../modal/supportAttachmentModel";
import User from "../../../../../modal/userModel";
import Admin from "../../../../../modal/adminModel";
import type {
  SupportCannedReplyRecord,
  SupportDeskRepository,
} from "../../domain/ports/supportDeskPorts";
import type {
  SupportAttachment as SupportAttachmentRecord,
  SupportDeskMetrics,
  SupportMessageRecord,
  SupportTicketRecord,
  SupportUserSummary,
} from "../../domain";

const oid = (value: string) => new mongoose.Types.ObjectId(value);
const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ticketRecord = (doc: Record<string, unknown>): SupportTicketRecord => ({
  id: String(doc._id),
  ticketNumber: Number(doc.ticketNumber),
  organizationId: String(doc.organizationId),
  requesterUserId: String(doc.requesterUserId),
  assigneeUserId: doc.assigneeUserId ? String(doc.assigneeUserId) : null,
  subject: text(doc.subject),
  category: doc.category as SupportTicketRecord["category"],
  priority: doc.priority as SupportTicketRecord["priority"],
  status: doc.status as SupportTicketRecord["status"],
  messageCount: Number(doc.messageCount ?? 0),
  unreadForRequester: Number(doc.unreadForRequester ?? 0),
  unreadForAgents: Number(doc.unreadForAgents ?? 0),
  lastMessageAt: iso(doc.lastMessageAt) ?? iso(doc.createdAt) ?? new Date(0).toISOString(),
  lastCustomerMessageAt: iso(doc.lastCustomerMessageAt),
  lastAgentMessageAt: iso(doc.lastAgentMessageAt),
  firstAgentResponseAt: iso(doc.firstAgentResponseAt),
  resolvedAt: iso(doc.resolvedAt),
  closedAt: iso(doc.closedAt),
  createdAt: iso(doc.createdAt) ?? new Date(0).toISOString(),
  updatedAt: iso(doc.updatedAt) ?? new Date(0).toISOString(),
});

const messageRecord = (doc: Record<string, unknown>): SupportMessageRecord => ({
  id: String(doc._id),
  ticketId: String(doc.ticketId),
  authorUserId: doc.authorUserId ? String(doc.authorUserId) : null,
  authorRole: doc.authorRole as SupportMessageRecord["authorRole"],
  kind: doc.kind as SupportMessageRecord["kind"],
  body: text(doc.body),
  attachments: Array.isArray(doc.attachments)
    ? (doc.attachments as Record<string, unknown>[]).map((item) => ({
        id: text(item.id),
        fileName: text(item.fileName),
        mimeType: text(item.mimeType),
        sizeBytes: Number(item.sizeBytes ?? 0),
        objectKey: text(item.objectKey),
      }))
    : [],
  createdAt: iso(doc.createdAt) ?? new Date(0).toISOString(),
});

const cannedRecord = (doc: Record<string, unknown>): SupportCannedReplyRecord => ({
  id: String(doc._id),
  title: text(doc.title),
  body: text(doc.body),
  createdByUserId: String(doc.createdByUserId),
  createdAt: iso(doc.createdAt) ?? new Date(0).toISOString(),
  updatedAt: iso(doc.updatedAt) ?? new Date(0).toISOString(),
});

const userSummary = (doc: Record<string, unknown>): SupportUserSummary => ({
  id: String(doc._id),
  name: text(doc.name) || text(doc.email) || "Unknown user",
  email: text(doc.email),
  company: text(doc.company) || null,
  role: text(doc.role),
});

const ADMIN_ROLES = ["admin", "super_admin", "superadmin"];

const toDate = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

export const mongoSupportDeskRepository: SupportDeskRepository = {
  async createTicket(input) {
    const counter = await SupportTicketCounter.findOneAndUpdate(
      { organizationId: oid(input.organizationId) },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    const created = await SupportTicket.create({
      organizationId: oid(input.organizationId),
      ticketNumber: Number(counter?.seq ?? 1),
      requesterUserId: oid(input.requesterUserId),
      subject: input.subject,
      category: input.category,
      priority: input.priority,
      status: "open",
      lastMessageAt: input.now,
      lastCustomerMessageAt: input.now,
    });
    return ticketRecord(created.toObject() as unknown as Record<string, unknown>);
  },

  async findTicket(organizationId, ticketId) {
    const doc = await SupportTicket.findOne({ _id: oid(ticketId), organizationId: oid(organizationId) }).lean();
    return doc ? ticketRecord(doc as Record<string, unknown>) : null;
  },

  async listTickets(organizationId, filters) {
    const query: Record<string, unknown> = { organizationId: oid(organizationId) };
    if (filters.requesterUserId) query.requesterUserId = oid(filters.requesterUserId);
    if (filters.status === "active") query.status = { $in: ["open", "waiting_on_customer"] };
    else if (filters.status) query.status = filters.status;
    if (filters.assignee === "unassigned") query.assigneeUserId = null;
    else if (filters.assignee && filters.assignee !== "me") query.assigneeUserId = oid(filters.assignee);
    if (filters.priority) query.priority = filters.priority;
    if (filters.category) query.category = filters.category;
    if (filters.search) {
      const regex = new RegExp(escapeRegex(filters.search), "i");
      const numeric = Number.parseInt(filters.search.replace(/^#/, ""), 10);
      const matchingUsers = await User.find({
        organizationId: oid(organizationId),
        $or: [{ name: regex }, { email: regex }],
      })
        .select("_id")
        .limit(50)
        .lean();
      query.$or = [
        { subject: regex },
        ...(Number.isInteger(numeric) ? [{ ticketNumber: numeric }] : []),
        ...(matchingUsers.length
          ? [{ requesterUserId: { $in: matchingUsers.map((user) => user._id) } }]
          : []),
      ];
    }
    const [docs, total] = await Promise.all([
      SupportTicket.find(query)
        .sort({ lastMessageAt: -1, _id: -1 })
        .skip((filters.page - 1) * filters.perPage)
        .limit(filters.perPage)
        .lean(),
      SupportTicket.countDocuments(query),
    ]);
    return { tickets: docs.map((doc) => ticketRecord(doc as Record<string, unknown>)), total };
  },

  async updateTicket(organizationId, ticketId, patch) {
    const { messageCountDelta, ...rest } = patch;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (
        key === "lastMessageAt" ||
        key === "lastCustomerMessageAt" ||
        key === "lastAgentMessageAt" ||
        key === "firstAgentResponseAt" ||
        key === "resolvedAt" ||
        key === "closedAt"
      ) {
        set[key] = toDate(value as string | null);
      } else if (key === "assigneeUserId") {
        set[key] = value ? oid(String(value)) : null;
      } else {
        set[key] = value;
      }
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length) update.$set = set;
    if (messageCountDelta) update.$inc = { messageCount: messageCountDelta };
    if (!Object.keys(update).length) return this.findTicket(organizationId, ticketId);
    const doc = await SupportTicket.findOneAndUpdate(
      { _id: oid(ticketId), organizationId: oid(organizationId) },
      update,
      { new: true },
    ).lean();
    return doc ? ticketRecord(doc as Record<string, unknown>) : null;
  },

  async countRequesterUnread(organizationId, requesterUserId) {
    return SupportTicket.countDocuments({
      organizationId: oid(organizationId),
      requesterUserId: oid(requesterUserId),
      unreadForRequester: { $gt: 0 },
    });
  },

  async appendMessage(input) {
    const created = await SupportMessage.create({
      organizationId: oid(input.organizationId),
      ticketId: oid(input.ticketId),
      authorUserId: input.authorUserId ? oid(input.authorUserId) : null,
      authorRole: input.authorRole,
      kind: input.kind,
      body: input.body,
      attachments: input.attachments,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return messageRecord(created.toObject() as unknown as Record<string, unknown>);
  },

  async listMessages(organizationId, ticketId, options) {
    const query: Record<string, unknown> = {
      organizationId: oid(organizationId),
      ticketId: oid(ticketId),
    };
    if (!options.includeInternal) query.kind = { $ne: "internal_note" };
    const docs = await SupportMessage.find(query).sort({ createdAt: 1, _id: 1 }).limit(500).lean();
    return docs.map((doc) => messageRecord(doc as Record<string, unknown>));
  },

  async metrics(organizationId) {
    const organization = oid(organizationId);
    const [statusRows, unassigned, unreadRow, firstResponse, resolution, perAgentRows] = await Promise.all([
      SupportTicket.aggregate<{ _id: string; count: number }>([
        { $match: { organizationId: organization } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      SupportTicket.countDocuments({
        organizationId: organization,
        assigneeUserId: null,
        status: { $in: ["open", "waiting_on_customer"] },
      }),
      SupportTicket.aggregate<{ total: number }>([
        // Only active tickets count as "unread": a closed ticket's leftover
        // counter must not contradict an inbox that shows nothing open.
        {
          $match: {
            organizationId: organization,
            unreadForAgents: { $gt: 0 },
            status: { $in: ["open", "waiting_on_customer"] },
          },
        },
        { $group: { _id: null, total: { $sum: "$unreadForAgents" } } },
      ]),
      SupportTicket.aggregate<{ average: number }>([
        { $match: { organizationId: organization, firstAgentResponseAt: { $ne: null } } },
        {
          $group: {
            _id: null,
            average: { $avg: { $subtract: ["$firstAgentResponseAt", "$createdAt"] } },
          },
        },
      ]),
      SupportTicket.aggregate<{ average: number }>([
        { $match: { organizationId: organization, resolvedAt: { $ne: null } } },
        { $group: { _id: null, average: { $avg: { $subtract: ["$resolvedAt", "$createdAt"] } } } },
      ]),
      SupportTicket.aggregate<{ _id: unknown; count: number }>([
        {
          $match: {
            organizationId: organization,
            assigneeUserId: { $ne: null },
            status: { $in: ["open", "waiting_on_customer"] },
          },
        },
        { $group: { _id: "$assigneeUserId", count: { $sum: 1 } } },
      ]),
    ]);
    const byStatus = new Map(statusRows.map((row) => [row._id, row.count]));
    const metrics: SupportDeskMetrics = {
      open: byStatus.get("open") ?? 0,
      waitingOnCustomer: byStatus.get("waiting_on_customer") ?? 0,
      resolved: byStatus.get("resolved") ?? 0,
      closed: byStatus.get("closed") ?? 0,
      unassigned,
      unreadForAgents: unreadRow[0]?.total ?? 0,
      averageFirstResponseMs: Number.isFinite(firstResponse[0]?.average)
        ? Math.round(firstResponse[0].average)
        : null,
      averageResolutionMs: Number.isFinite(resolution[0]?.average) ? Math.round(resolution[0].average) : null,
      perAgent: perAgentRows.map((row) => ({ agentUserId: String(row._id), openTickets: row.count })),
    };
    return metrics;
  },

  async listAgents(organizationId) {
    const docs = await Admin.find({
      organizationId: oid(organizationId),
      role: { $in: ADMIN_ROLES },
      isBlocked: { $ne: true },
    })
      .select("name email company role")
      .sort({ name: 1 })
      .lean();
    return docs.map((doc) => userSummary(doc as Record<string, unknown>));
  },

  async findUserSummaries(organizationId, userIds) {
    if (!userIds.length) return new Map();
    // Requesters are planners (`users`); agents and authors of agent replies
    // are administrators (`admins`). Ids are unique across both collections.
    const filter = { organizationId: oid(organizationId), _id: { $in: userIds.map(oid) } };
    const [planners, admins] = await Promise.all([
      User.find(filter).select("name email company role").lean(),
      Admin.find(filter).select("name email role").lean(),
    ]);
    return new Map(
      [...planners, ...admins].map((doc) => [String(doc._id), userSummary(doc as Record<string, unknown>)]),
    );
  },

  async listCannedReplies(organizationId) {
    const docs = await SupportCannedReply.find({ organizationId: oid(organizationId) })
      .sort({ title: 1 })
      .limit(200)
      .lean();
    return docs.map((doc) => cannedRecord(doc as Record<string, unknown>));
  },

  async createCannedReply(input) {
    const created = await SupportCannedReply.create({
      organizationId: oid(input.organizationId),
      title: input.title,
      body: input.body,
      createdByUserId: oid(input.createdByUserId),
    });
    return cannedRecord(created.toObject() as unknown as Record<string, unknown>);
  },

  async updateCannedReply(organizationId, id, patch) {
    const doc = await SupportCannedReply.findOneAndUpdate(
      { _id: oid(id), organizationId: oid(organizationId) },
      { $set: patch },
      { new: true },
    ).lean();
    return doc ? cannedRecord(doc as Record<string, unknown>) : null;
  },

  async deleteCannedReply(organizationId, id) {
    const result = await SupportCannedReply.deleteOne({ _id: oid(id), organizationId: oid(organizationId) });
    return result.deletedCount > 0;
  },

  async createPendingAttachment(input) {
    await SupportAttachment.create({
      organizationId: oid(input.organizationId),
      uploaderUserId: oid(input.uploaderUserId),
      attachmentId: input.attachment.id,
      fileName: input.attachment.fileName,
      mimeType: input.attachment.mimeType,
      sizeBytes: input.attachment.sizeBytes,
      objectKey: input.attachment.objectKey,
      status: "pending",
      createdAt: input.now,
      updatedAt: input.now,
    });
  },

  async claimPendingAttachments(input) {
    if (!input.ids.length) return [];
    const docs = await SupportAttachment.find({
      organizationId: oid(input.organizationId),
      uploaderUserId: oid(input.uploaderUserId),
      attachmentId: { $in: [...input.ids] },
      status: "pending",
    }).lean();
    const byId = new Map(docs.map((doc) => [doc.attachmentId, doc]));
    const ordered: SupportAttachmentRecord[] = [];
    for (const id of input.ids) {
      const doc = byId.get(id);
      if (!doc) return null;
      ordered.push({
        id: doc.attachmentId,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        objectKey: doc.objectKey,
      });
    }
    return ordered;
  },

  async markAttachmentsUsed(input) {
    await SupportAttachment.updateMany(
      { organizationId: oid(input.organizationId), attachmentId: { $in: [...input.ids] }, status: "pending" },
      { $set: { status: "attached", ticketId: oid(input.ticketId), messageId: oid(input.messageId) } },
    );
  },

  async findTicketAttachment(organizationId, ticketId, attachmentId) {
    const doc = await SupportMessage.findOne({
      organizationId: oid(organizationId),
      ticketId: oid(ticketId),
      "attachments.id": attachmentId,
    }).lean();
    if (!doc) return null;
    const record = messageRecord(doc as Record<string, unknown>);
    const attachment = record.attachments.find((item) => item.id === attachmentId);
    return attachment ? { attachment, messageKind: record.kind } : null;
  },
};
