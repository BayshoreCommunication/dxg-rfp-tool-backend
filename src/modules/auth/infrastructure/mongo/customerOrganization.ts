import crypto from "node:crypto";
import mongoose from "mongoose";
import Organization from "../../../../../modal/organizationModel";
import OrganizationMembership from "../../../../../modal/organizationMembershipModel";
import User from "../../../../../modal/userModel";

// Every new customer gets an organization of their own (ORG-106), so signup no longer joins the
// shared default organization. Signup UI with organization details arrives in ORG-301; until then
// the name comes from the company the person entered, or from their own name.
export const organizationNameFor = (input: { name: string; company?: string | null }): string => {
  const company = input.company?.trim();
  if (company) return company.slice(0, 200);
  const name = input.name.trim() || "My";
  return `${name}'s organization`.slice(0, 200);
};

// Readable and unique: the name in kebab case plus a random suffix, matching the slug pattern.
export const organizationSlugFor = (name: string): string => {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const suffix = crypto.randomBytes(4).toString("hex");
  return base ? `${base}-${suffix}` : `org-${suffix}`;
};

type CustomerFields = Record<string, unknown> & { name: string; email: string; company?: string | null };

// One transaction creates the organization, the user and the user's Owner membership, so a failed
// signup (a duplicate email, say) leaves no organization behind. Writes go through upserts on a
// fresh id, as before, so the user model's save hooks never re-hash the stored password hash.
export const createCustomerWithOrganization = async (fields: CustomerFields) => {
  const session = await mongoose.startSession();
  try {
    let user: Record<string, unknown> | null = null;
    await session.withTransaction(async () => {
      const organizationName = organizationNameFor(fields);
      const [organization] = await Organization.create(
        [{ name: organizationName, slug: organizationSlugFor(organizationName), kind: "customer", status: "active" }],
        { session },
      );
      user = await User.findOneAndUpdate(
        { _id: new mongoose.Types.ObjectId() },
        { $setOnInsert: { ...fields, organizationId: organization._id, role: "customer", isBlocked: false } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true, session },
      ).select("-password").lean();
      if (!user) throw new Error("Customer account was not created");
      await OrganizationMembership.create(
        [{ organizationId: organization._id, userId: user._id, roles: ["owner"], status: "active", activatedAt: new Date() }],
        { session },
      );
    });
    if (!user) throw new Error("Customer account was not created");
    return user as unknown as { _id: unknown; organizationId: unknown; name: string; email: string } & Record<string, unknown>;
  } finally {
    await session.endSession();
  }
};
