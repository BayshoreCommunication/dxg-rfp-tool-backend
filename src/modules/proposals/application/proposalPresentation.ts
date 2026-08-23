import { activeProposalWorkflowContent } from "../domain/workflowSections";

export type LegacyProposalSettings = {
  branding?: {
    brandName?: string;
    linkPrefix?: string;
    defaultFont?: string;
    signatureColor?: string;
    logoFile?: string | null;
  };
  proposals?: {
    proposalLanguage?: string;
    defaultCurrency?: string;
    expiryDate?: string;
    priceSeparator?: string;
    dateFormat?: string;
    decimalPrecision?: string;
    contacts?: {
      email?: { enabled?: boolean; value?: string };
      call?: { enabled?: boolean; value?: string };
    };
    downloadPreview?: string;
    teammateEmail?: string;
  };
  signatures?: {
    signatureType?: string;
    signatureImageUrl?: string;
    signatureText?: string;
    signatureStyle?: string;
  };
};

export type LegacyProposalRecord = object & {
  createdAt?: Date | string;
  isActive?: boolean;
};

export const buildProposalSettingSnapshot = (
  settings: LegacyProposalSettings | null,
) => ({
  branding: {
    brandName: settings?.branding?.brandName ?? "",
    linkPrefix: settings?.branding?.linkPrefix ?? "",
    defaultFont: settings?.branding?.defaultFont ?? "",
    signatureColor: settings?.branding?.signatureColor ?? "",
    logoFile: settings?.branding?.logoFile ?? null,
  },
  proposals: {
    proposalLanguage: settings?.proposals?.proposalLanguage ?? "",
    defaultCurrency: settings?.proposals?.defaultCurrency ?? "",
    expiryDate: settings?.proposals?.expiryDate ?? "",
    priceSeparator: settings?.proposals?.priceSeparator ?? "",
    dateFormat: settings?.proposals?.dateFormat ?? "",
    decimalPrecision: settings?.proposals?.decimalPrecision ?? "",
    contacts: {
      email: {
        enabled: settings?.proposals?.contacts?.email?.enabled ?? false,
        value: settings?.proposals?.contacts?.email?.value ?? "",
      },
      call: {
        enabled: settings?.proposals?.contacts?.call?.enabled ?? false,
        value: settings?.proposals?.contacts?.call?.value ?? "",
      },
    },
    downloadPreview: settings?.proposals?.downloadPreview ?? "",
    teammateEmail: settings?.proposals?.teammateEmail ?? "",
  },
  signatures: {
    signatureType: settings?.signatures?.signatureType ?? "",
    signatureImageUrl: settings?.signatures?.signatureImageUrl ?? "",
    signatureText: settings?.signatures?.signatureText ?? "",
    signatureStyle: settings?.signatures?.signatureStyle ?? "",
  },
});

export const withLiveSettings = <T extends LegacyProposalRecord>(
  proposal: T,
  settings: LegacyProposalSettings | null,
): T & { proposalSetting: ReturnType<typeof buildProposalSettingSnapshot> } => ({
  ...activeProposalWorkflowContent(
    proposal as T & Record<string, unknown>,
  ),
  proposalSetting: buildProposalSettingSnapshot(settings),
});

export const parseExpiryDays = (expirySetting?: string): number | null => {
  if (!expirySetting) return null;
  const match = expirySetting.match(/(\d+)/);
  if (!match) return null;
  const days = Number.parseInt(match[1], 10);
  return Number.isFinite(days) && days > 0 ? days : null;
};

export const applyDerivedExpiryState = <T extends LegacyProposalRecord>(
  proposal: T,
  expirySetting?: string,
  now = Date.now(),
): T | (T & { isActive: false; isOpen: false; status: "unsubmitted" }) => {
  if (proposal.isActive === false) return proposal;
  const days = parseExpiryDays(expirySetting);
  if (!days || !proposal.createdAt) return proposal;
  const createdAt = new Date(proposal.createdAt);
  if (Number.isNaN(createdAt.getTime())) return proposal;
  const expiresAt = createdAt.getTime() + days * 24 * 60 * 60 * 1000;
  if (now <= expiresAt) return proposal;
  return { ...proposal, isActive: false, isOpen: false, status: "unsubmitted" };
};
