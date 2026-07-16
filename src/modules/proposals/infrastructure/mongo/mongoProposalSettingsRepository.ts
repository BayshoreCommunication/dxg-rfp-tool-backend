import Settings from "../../../../../modal/settingsModel";
import type { ProposalSettingsRepository } from "../../domain/ports/proposalSettingsRepository";
import type { LegacyProposalSettings } from "../../application/proposalPresentation";

export const SETTINGS_SELECT = [
  "branding.brandName",
  "branding.linkPrefix",
  "branding.defaultFont",
  "branding.signatureColor",
  "branding.logoFile",
  "proposals.proposalLanguage",
  "proposals.defaultCurrency",
  "proposals.expiryDate",
  "proposals.priceSeparator",
  "proposals.dateFormat",
  "proposals.decimalPrecision",
  "proposals.contacts.email.enabled",
  "proposals.contacts.email.value",
  "proposals.contacts.call.enabled",
  "proposals.contacts.call.value",
  "proposals.downloadPreview",
  "proposals.teammateEmail",
  "signatures.signatureType",
  "signatures.signatureImageUrl",
  "signatures.signatureText",
  "signatures.signatureStyle",
].join(" ");

export const mongoProposalSettingsRepository: ProposalSettingsRepository = {
  async findByUserId(userId, options) {
    let settings = await Settings.findOne({ userId })
      .select(SETTINGS_SELECT)
      .lean<LegacyProposalSettings>();
    if (!settings && options?.createIfMissing) {
      const created = await Settings.create({ userId });
      settings = created.toObject() as unknown as LegacyProposalSettings;
    }
    return settings;
  },
};
