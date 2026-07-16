import type { EmailTrackingRepository } from "../domain/ports/emailTrackingRepository";

const base = (value: string) => value.replace(/\/+$/, "");

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
    return `${base(dependencies.frontendBaseUrl)}/proposal-view/${tracked.proposalSlug}?source=email`;
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
    return tracked.recipientEmail
      ? `${url}&email=${encodeURIComponent(
          tracked.recipientEmail,
        )}&tid=${encodeURIComponent(input.trackingId)}`
      : url;
  }
  return input.fallbackRedirect?.match(/^https?:\/\//i)
    ? input.fallbackRedirect
    : base(dependencies.frontendBaseUrl);
};
