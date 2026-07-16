import type { VendorResponseReadRepository } from "../domain/ports/vendorResponseReadRepository";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const createListOwnedVendorResponses = (
  repository: VendorResponseReadRepository,
) => async (input: {
  ownerUserId: string;
  query: {
    page?: string;
    limit?: string;
    unreadOnly?: string;
    proposalId?: string;
    campaignId?: string;
  };
}) => {
  const page = positiveInteger(input.query.page, 1);
  const limit = Math.min(100, positiveInteger(input.query.limit, 20));
  const result = await repository.listOwned({
    ownerUserId: input.ownerUserId,
    unreadOnly: input.query.unreadOnly === "true",
    proposalId: input.query.proposalId,
    campaignId: input.query.campaignId,
    page,
    limit,
  });
  return {
    responses: result.responses,
    pagination: {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    },
    unreadCount: result.unreadCount,
  };
};

export const createGetOwnedVendorResponse = (
  repository: VendorResponseReadRepository,
) => async (input: { responseId: string; ownerUserId: string }) => {
  const response = await repository.markOwnedRead(input);
  return response
    ? { kind: "found" as const, response }
    : { kind: "not_found" as const };
};
