import mongoose from "mongoose";
import SecurityAuditEvent from "../../../../modal/securityAuditEventModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import User from "../../../../modal/userModel";
import type { AuditEventReader } from "../domain";

const isValidId = (value: string) => /^[0-9a-f]{24}$/i.test(value);
const oid = (value: string) => new mongoose.Types.ObjectId(value);

export const mongoAuditEventReader: AuditEventReader = {
  isValidId,

  async list(organizationId, filter, limit) {
    // Served by { organizationId, action, createdAt } / { organizationId, createdAt } (ORG-404).
    const query: Record<string, unknown> = { organizationId: oid(organizationId), action: { $in: [...filter.actions] } };
    if (filter.actorUserId) query.actorUserId = oid(filter.actorUserId);
    const createdAt: Record<string, Date> = {};
    if (filter.from) createdAt.$gte = filter.from;
    if (filter.to) createdAt.$lt = filter.to;
    if (Object.keys(createdAt).length > 0) query.createdAt = createdAt;
    if (filter.before) {
      query.$or = [
        { createdAt: { $lt: filter.before.createdAt } },
        { createdAt: filter.before.createdAt, _id: { $lt: oid(filter.before.id) } },
      ];
    }
    const docs = await SecurityAuditEvent.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
    return docs.map((doc) => ({
      id: String(doc._id),
      action: doc.action,
      actorUserId: doc.actorUserId ? String(doc.actorUserId) : null,
      targetType: doc.targetType,
      targetId: doc.targetId ?? null,
      decision: doc.decision,
      reason: doc.reason,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
    }));
  },

  async memberNames(organizationId, userIds) {
    const ids = [...new Set(userIds)].filter(isValidId).map(oid);
    if (ids.length === 0) return new Map();
    // Membership in this organization decides whose name may be shown; `admins` is never read.
    const memberships = await OrganizationMembership.find({ organizationId: oid(organizationId), userId: { $in: ids } }).select("userId").lean();
    if (memberships.length === 0) return new Map();
    const users = await User.find({ _id: { $in: memberships.map((row) => row.userId) } }).select("name email").lean();
    return new Map(users.map((user) => [String(user._id), { name: String(user.name ?? ""), email: String(user.email ?? "") }]));
  },
};
