import mongoose from "mongoose";
import Organization from "../../../../../modal/organizationModel";
import OrganizationDomain from "../../../../../modal/organizationDomainModel";
import type { DomainRecord, DomainRepository } from "../../application/manageDomains";

type Row = {
  _id: unknown; organizationId: unknown; domain: string; status: DomainRecord["status"]; verificationToken: string;
  method?: DomainRecord["method"]; verifiedByUserId?: unknown; verifiedAt?: Date | null; lastCheckedAt?: Date | null;
  lastCheckOutcome?: string | null; nextCheckAt: Date; createdAt: Date;
};

const toRecord = (row: Row): DomainRecord => ({
  id: String(row._id),
  organizationId: String(row.organizationId),
  domain: row.domain,
  status: row.status,
  verificationToken: row.verificationToken,
  method: row.method ?? null,
  verifiedByUserId: row.verifiedByUserId ? String(row.verifiedByUserId) : null,
  verifiedAt: row.verifiedAt ?? null,
  lastCheckedAt: row.lastCheckedAt ?? null,
  lastCheckOutcome: row.lastCheckOutcome ?? null,
  nextCheckAt: row.nextCheckAt,
  createdAt: row.createdAt,
});

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

// Organization.verifiedDomains mirrors the verified rows for the signup lookup (ORG-306).
const mirror = {
  add: (organizationId: unknown, domain: string) => Organization.updateOne({ _id: organizationId }, { $addToSet: { verifiedDomains: domain } }),
  remove: (organizationId: unknown, domain: string) => Organization.updateOne({ _id: organizationId }, { $pull: { verifiedDomains: domain } }),
};

export const mongoDomainRepository: DomainRepository = {
  async list(organizationId) {
    const rows = await OrganizationDomain.find({ organizationId }).sort({ domain: 1 }).lean<Row[]>();
    return rows.map(toRecord);
  },
  async findById(organizationId, id) {
    if (!mongoose.isValidObjectId(id)) return null;
    const row = await OrganizationDomain.findOne({ _id: id, organizationId }).lean<Row | null>();
    return row ? toRecord(row) : null;
  },
  countForOrganization(organizationId) {
    return OrganizationDomain.countDocuments({ organizationId });
  },
  async create(input) {
    try {
      const row = await OrganizationDomain.create({ ...input, status: "pending" });
      return toRecord(row.toObject() as Row);
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },
  async markVerified(input) {
    try {
      const row = await OrganizationDomain.findOneAndUpdate(
        { _id: input.id },
        {
          $set: {
            status: "verified", method: input.method, verifiedByUserId: input.verifiedByUserId,
            verifiedAt: input.now, lastCheckedAt: input.now, nextCheckAt: input.nextCheckAt, lastCheckOutcome: input.outcome,
          },
        },
        { new: true },
      ).lean<Row | null>();
      if (row) await mirror.add(row.organizationId, row.domain);
      return "verified";
    } catch (error) {
      // The partial unique index: another organization verified this domain first.
      if (isDuplicateKey(error)) return "claimed";
      throw error;
    }
  },
  async markUnverified(input) {
    const row = await OrganizationDomain.findOneAndUpdate(
      { _id: input.id },
      { $set: { status: "unverified", lastCheckedAt: input.now, nextCheckAt: input.nextCheckAt, lastCheckOutcome: input.outcome } },
      { new: true },
    ).lean<Row | null>();
    if (row) await mirror.remove(row.organizationId, row.domain);
  },
  async recordCheck(input) {
    await OrganizationDomain.updateOne(
      { _id: input.id },
      { $set: { lastCheckedAt: input.now, nextCheckAt: input.nextCheckAt, lastCheckOutcome: input.outcome } },
    );
  },
  async remove(organizationId, id) {
    if (!mongoose.isValidObjectId(id)) return null;
    const row = await OrganizationDomain.findOneAndDelete({ _id: id, organizationId }).lean<Row | null>();
    if (!row) return null;
    if (row.status === "verified") await mirror.remove(row.organizationId, row.domain);
    return toRecord(row);
  },
  async due(now, limit) {
    // scope-exempt: the background re-check runs across every organization.
    const rows = await OrganizationDomain.find({ nextCheckAt: { $lte: now } }).sort({ nextCheckAt: 1 }).limit(limit).lean<Row[]>();
    return rows.map(toRecord);
  },
  async claimDue(input) {
    if (!mongoose.isValidObjectId(input.id)) return false;
    // scope-exempt: the background re-check; the id comes from due() above.
    const result = await OrganizationDomain.updateOne(
      { _id: input.id, nextCheckAt: { $lte: input.now } },
      { $set: { nextCheckAt: input.leaseUntil } },
    );
    return result.modifiedCount === 1;
  },
};
