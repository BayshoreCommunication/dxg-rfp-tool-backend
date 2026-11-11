import mongoose from "mongoose";
import OrganizationVendor from "../../../../modal/organizationVendorModel";
import type { OrganizationVendorRecord, OrganizationVendorRepository, VendorContact } from "../domain";

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collation = { locale: "en", strength: 2 } as const;

type VendorDocument = {
  _id: unknown;
  company: string;
  category?: string;
  contacts?: Array<{ name?: string; email: string }>;
  addedBy?: unknown;
  archived?: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const toRecord = (vendor: VendorDocument): OrganizationVendorRecord => ({
  id: String(vendor._id),
  company: vendor.company,
  category: vendor.category ?? "",
  contacts: (vendor.contacts ?? []).map((contact): VendorContact => ({ name: contact.name ?? "", email: contact.email })),
  addedBy: vendor.addedBy ? String(vendor.addedBy) : null,
  archived: vendor.archived === true,
  archivedAt: vendor.archivedAt ?? null,
  createdAt: vendor.createdAt,
  updatedAt: vendor.updatedAt,
});

export const mongoOrganizationVendorRepository: OrganizationVendorRepository = {
  async list(organizationId, query) {
    const conditions: Record<string, unknown> = {};
    if (query.status !== "all") conditions.archived = query.status === "archived";
    if (query.category) conditions.category = { $regex: `^${escapeRegex(query.category)}$`, $options: "i" };
    if (query.search) {
      const contains = { $regex: escapeRegex(query.search), $options: "i" };
      conditions.$or = [{ company: contains }, { category: contains }];
    }
    const [items, total] = await Promise.all([
      OrganizationVendor.find({ organizationId, ...conditions })
        .sort({ company: 1, _id: 1 })
        .collation(collation)
        .skip(query.offset)
        .limit(query.limit)
        .lean<VendorDocument[]>(),
      OrganizationVendor.countDocuments({ organizationId, ...conditions }),
    ]);
    return { items: items.map(toRecord), total };
  },

  async categories(organizationId) {
    const values = await OrganizationVendor.distinct("category", { organizationId, archived: false });
    const byKey = new Map<string, string>();
    for (const value of values) {
      if (typeof value === "string" && value && !byKey.has(value.toLowerCase())) byKey.set(value.toLowerCase(), value);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  },

  async findById(organizationId, vendorId) {
    const vendor = await OrganizationVendor.findOne({ _id: vendorId, organizationId }).lean<VendorDocument | null>();
    return vendor ? toRecord(vendor) : null;
  },

  async create({ organizationId, company, category, contacts, addedBy }) {
    try {
      return toRecord((await OrganizationVendor.create({ organizationId, company, category, contacts, addedBy })).toObject());
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },

  async update({ organizationId, vendorId, changes }) {
    try {
      const vendor = await OrganizationVendor.findOneAndUpdate(
        { _id: vendorId, organizationId, archived: false },
        { $set: changes },
        { new: true, runValidators: true },
      ).lean<VendorDocument | null>();
      return vendor ? toRecord(vendor) : null;
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },

  async setArchived({ organizationId, vendorId, archived, at }) {
    try {
      const vendor = await OrganizationVendor.findOneAndUpdate(
        { _id: vendorId, organizationId, archived: !archived },
        { $set: { archived, archivedAt: archived ? at : null } },
        { new: true, runValidators: true },
      ).lean<VendorDocument | null>();
      return vendor ? toRecord(vendor) : null;
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },
};

export const isValidVendorId = (value: string) => mongoose.isValidObjectId(value) && /^[0-9a-f]{24}$/i.test(value);
