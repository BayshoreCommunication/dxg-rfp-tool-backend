import Organization from "../../../../modal/organizationModel";
import type { OrganizationProfileDirectory, OrganizationProfileRecord } from "../application/manageOrganizationProfile";

const FIELDS = "name type industry country timeZone eventsPerYear plan onboardingStep";

export const mongoOrganizationProfileDirectory: OrganizationProfileDirectory = {
  async find(organizationId) {
    const organization = await Organization.findById(organizationId)
      .select(FIELDS)
      .lean<Partial<OrganizationProfileRecord> & { name: string } | null>();
    if (!organization) return null;
    return {
      name: organization.name,
      type: organization.type ?? null,
      industry: organization.industry ?? null,
      country: organization.country ?? null,
      timeZone: organization.timeZone ?? null,
      eventsPerYear: organization.eventsPerYear ?? null,
      plan: organization.plan ?? "free_trial",
      // Organizations created before onboarding have no step and never see the wizard.
      onboardingStep: organization.onboardingStep ?? "done",
    };
  },
  async update(organizationId, changes) {
    await Organization.updateOne({ _id: organizationId }, { $set: changes }, { runValidators: true });
  },
};
