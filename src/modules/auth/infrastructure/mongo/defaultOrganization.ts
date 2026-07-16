import Organization from "../../../../../modal/organizationModel";

export const requireDefaultOrganizationId = async (): Promise<string> => {
  const slug = process.env.DEFAULT_ORGANIZATION_SLUG || "dxg";
  const organization = await Organization.findOne({ slug, status: "active" }).select("_id").lean();
  if (!organization) throw new Error(`Active default organization '${slug}' was not found`);
  return String(organization._id);
};
