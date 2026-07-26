import type { EmailTrackingRepository } from "../domain/ports/emailTrackingRepository";

const base = (value: string) => value.replace(/\/+$/, "");
const accessGrantFrom = (value?: string) => {
  if (!value?.match(/^https?:\/\//i)) return "";
  try {
    const token = new URL(value).searchParams.get("accessGrant") ?? "";
    return token.length <= 256 ? token : "";
  } catch { return ""; }
};

export const createTrackEmailOpen = (dependencies: {
  repository: EmailTrackingRepository;
  now?: () => Date;
}) => (trackingId: string) =>
  dependencies.repository.markOpenedOnce({
    trackingId,
    occurredAt: (dependencies.now ?? (() => new Date()))(),
  });

export const createTrackProposalClick = (dependencies: {
  repository: EmailTrackingRepository;
  frontendBaseUrl: string;
  now?: () => Date;
}) => async (input: { trackingId: string; fallbackRedirect?: string }) => {
  const tracked = await dependencies.repository.markProposalClickedOnce({
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

export const createTrackVendorResponseClick = (dependencies: {
  repository: EmailTrackingRepository;
  frontendBaseUrl: string;
  now?: () => Date;
}) => async (input: { trackingId: string; fallbackRedirect?: string }) => {
  const tracked = await dependencies.repository.markVendorResponseClickedOnce({
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
