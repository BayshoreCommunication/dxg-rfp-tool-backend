import Organization from "../../../../modal/organizationModel";
import type { OrganizationProfileDirectory } from "../application/manageOrganizationProfile";

export const mongoOrganizationProfileDirectory: OrganizationProfileDirectory = {
  async find(organizationId) {
    const organization = await Organization.findById(organizationId)
      .select("name needsName")
      .lean<{ name: string; needsName?: boolean } | null>();
    return organization ? { name: organization.name, needsName: organization.needsName === true } : null;
  },
  async rename(organizationId, name) {
    await Organization.updateOne({ _id: organizationId }, { $set: { name, needsName: false } });
  },
};
