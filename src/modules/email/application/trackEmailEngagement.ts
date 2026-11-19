import type { EmailTrackingRepository } from "../domain/ports/emailTrackingRepository";

const base = (value: string) => value.replace(/\/+$/, "");
const accessGrantFrom = (value?: string) => {
  if (!value?.match(/^https?:\/\//i)) return "";
  try {
    const token = new URL(value).searchParams.get("accessGrant") ?? "";
    return token.length <= 256 ? token : "";
  } catch { return ""; }
};

/* The organization block (organizationBlock): an open or a click on an email of an organization
   that RFPilot staff blocked records nothing, and answers exactly as an unknown tracking id does
   (the pixel is still served, a click falls back to its redirect). `organizationBlocked` not
   given: nothing is blocked. */
type BlockAware = { organizationBlocked?: (organizationId: string) => Promise<boolean> };
const senderBlocked = async (dependencies: BlockAware & { repository: EmailTrackingRepository }, trackingId: string): Promise<boolean> => {
  if (!dependencies.organizationBlocked || !dependencies.repository.organizationOf) return false;
  const organizationId = await dependencies.repository.organizationOf(trackingId);
  return organizationId ? dependencies.organizationBlocked(organizationId) : false;
};

export const createTrackEmailOpen = (dependencies: BlockAware & {
  repository: EmailTrackingRepository;
  now?: () => Date;
}) => async (trackingId: string) => {
  if (await senderBlocked(dependencies, trackingId)) return;
  await dependencies.repository.markOpenedOnce({
    trackingId,
    occurredAt: (dependencies.now ?? (() => new Date()))(),
  });
};

export const createTrackProposalClick = (dependencies: BlockAware & {
  repository: EmailTrackingRepository;
  frontendBaseUrl: string;
  now?: () => Date;
}) => async (input: { trackingId: string; fallbackRedirect?: string }) => {
  const tracked = (await senderBlocked(dependencies, input.trackingId)) ? null : await dependencies.repository.markProposalClickedOnce({
    trackingId: input.trackingId,
    occurredAt: (dependencies.now ?? (() => new Date()))(),
  });
  if (tracked) {
    const grant = accessGrantFrom(input.fallbackRedirect);
    return `${base(dependencies.frontendBaseUrl)}/proposal-view/${tracked.proposalSlug}?source=email${grant ? `&accessGrant=${encodeURIComponent(grant)}` : ""}`;
  }
  return input.fallbackRedirect?.match(/^https?:\/\//i)
    ? input.fallbackRedirect
    : base(dependencies.frontendBaseUrl);
};

export const createTrackVendorResponseClick = (dependencies: BlockAware & {
  repository: EmailTrackingRepository;
  frontendBaseUrl: string;
  now?: () => Date;
}) => async (input: { trackingId: string; fallbackRedirect?: string }) => {
  const tracked = (await senderBlocked(dependencies, input.trackingId)) ? null : await dependencies.repository.markVendorResponseClickedOnce({
    trackingId: input.trackingId,
    occurredAt: (dependencies.now ?? (() => new Date()))(),
  });
  if (tracked) {
    const url = `${base(dependencies.frontendBaseUrl)}/vendor-response/${tracked.proposalSlug}?source=email`;
    const grant = accessGrantFrom(input.fallbackRedirect);
    return `${url}&tid=${encodeURIComponent(input.trackingId)}${grant ? `&accessGrant=${encodeURIComponent(grant)}` : ""}`;
  }
  return input.fallbackRedirect?.match(/^https?:\/\//i)
    ? input.fallbackRedirect
    : base(dependencies.frontendBaseUrl);
};
