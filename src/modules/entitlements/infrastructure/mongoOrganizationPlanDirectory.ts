import mongoose from "mongoose";
import Admin from "../../../../modal/adminModel";
import Organization from "../../../../modal/organizationModel";
import SecurityAuditEvent from "../../../../modal/securityAuditEventModel";
import {
  PLAN_AUDIT,
  type OrganizationPlanDirectory,
  type OrganizationPlanRecord,
  type PlanChangeRecord,
} from "../application/manageOrganizationPlans";

/* ORG-603. These reads and the plan write span organizations by design: only RFPilot staff reach
   them (routes/adminOrganizationPlansRoute.ts), and every query names the organization id it
   acts on or lists customer organizations for the staff directory. Nothing here reads the
   caller's tenant context, and nothing reads an organization's RFPs or members. */

const FIELDS = "name slug status kind plan proposalsCreated createdAt";
const CUSTOMER = { kind: { $ne: "legacy_holding" } };

const oid = (value: string) => new mongoose.Types.ObjectId(value);
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const record = (doc: Record<string, unknown>): OrganizationPlanRecord => ({
  id: String(doc._id),
  name: String(doc.name ?? ""),
  slug: String(doc.slug ?? ""),
  status: String(doc.status ?? "active"),
  kind: String(doc.kind ?? "customer"),
  plan: text(doc.plan),
  proposalsCreated: typeof doc.proposalsCreated === "number" ? doc.proposalsCreated : null,
  createdAt: doc.createdAt instanceof Date ? doc.createdAt : null,
});

export const isValidOrganizationId = (value: string) => /^[a-f0-9]{24}$/i.test(value);

export const mongoOrganizationPlanDirectory: OrganizationPlanDirectory = {
  async list({ search, skip, limit }) {
    const filter: Record<string, unknown> = { ...CUSTOMER };
    if (search) {
      const pattern = { $regex: escapeRegex(search), $options: "i" };
      filter.$or = [{ name: pattern }, { slug: pattern }, ...(isValidOrganizationId(search) ? [{ _id: oid(search) }] : [])];
    }
    const [docs, total] = await Promise.all([
      Organization.find(filter).select(FIELDS).sort({ name: 1, _id: 1 }).collation({ locale: "en", strength: 2 })
        .skip(skip).limit(limit).lean<Record<string, unknown>[]>(),
      Organization.countDocuments(filter),
    ]);
    return { organizations: docs.map(record), total };
  },

  async find(organizationId) {
    const doc = await Organization.findOne({ _id: oid(organizationId) }).select(FIELDS).lean<Record<string, unknown>>();
    return doc ? record(doc) : null;
  },

  async changePlan({ organizationId, expectedPlan, plan, audit }) {
    const session = await mongoose.startSession();
    let updated: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(async () => {
        // `plan: null` also matches a row with no plan field (written before plans existed).
        updated = await Organization.findOneAndUpdate(
          { _id: oid(organizationId), ...CUSTOMER, plan: expectedPlan },
          { $set: { plan } },
          { session, new: true, runValidators: true },
        ).select(FIELDS).lean<Record<string, unknown>>();
        if (!updated) return;
        await SecurityAuditEvent.create([{
          organizationId: oid(organizationId),
          actorUserId: oid(audit.actorUserId),
          action: audit.action,
          targetType: "organization",
          targetId: organizationId,
          decision: "allowed",
          reason: audit.reason,
          correlationId: audit.correlationId,
          metadata: audit.metadata,
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    return updated ? record(updated) : null;
  },

  async history(organizationId, limit) {
    const docs = await SecurityAuditEvent.find({ organizationId: oid(organizationId), action: PLAN_AUDIT.changed })
      .sort({ createdAt: -1, _id: -1 }).limit(limit).lean<Record<string, unknown>[]>();
    return docs.map((doc): PlanChangeRecord => {
      const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
      return {
        at: doc.createdAt as Date,
        actorId: doc.actorUserId ? String(doc.actorUserId) : null,
        fromPlan: text(metadata.fromPlan),
        toPlan: text(metadata.toPlan),
        note: text(metadata.note),
      };
    });
  },

  async staffNames(adminIds) {
    const ids = adminIds.filter(isValidOrganizationId);
    if (ids.length === 0) return new Map();
    const admins = await Admin.find({ _id: { $in: ids.map(oid) } }).select("name").lean();
    return new Map(admins.map((admin) => [String(admin._id), admin.name]));
  },
};
