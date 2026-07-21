import type {
  VendorDocumentUrlSigner,
  VendorResponseReadRepository,
} from "../domain/ports/vendorResponseReadRepository";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// New vendor documents are stored privately, so owner-facing reads swap the
// stored URL for a short-lived presigned GET URL. Legacy (public) URLs and
// responses without documents pass through unchanged.
const withSignedDocumentUrls = async (
  response: Record<string, unknown>,
  signer?: VendorDocumentUrlSigner,
): Promise<Record<string, unknown>> => {
  const documents = response.documents;
  if (!signer || !Array.isArray(documents) || documents.length === 0) {
    return response;
  }
  const signed = await Promise.all(
    documents.map(async (document) => {
      if (!document || typeof document !== "object") return document;
      const record = document as Record<string, unknown>;
      if (typeof record.url !== "string" || !record.url) return document;
      return { ...record, url: await signer.presignDocumentUrl(record.url) };
    }),
  );
  return { ...response, documents: signed };
};

export const createListOwnedVendorResponses = (
  repository: VendorResponseReadRepository,
  documentUrlSigner?: VendorDocumentUrlSigner,
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
  const responses = await Promise.all(
    result.responses.map((response) =>
      withSignedDocumentUrls(response, documentUrlSigner),
    ),
  );
  return {
    responses,
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
  documentUrlSigner?: VendorDocumentUrlSigner,
) => async (input: { responseId: string; ownerUserId: string }) => {
  const response = await repository.markOwnedRead(input);
  return response
    ? {
        kind: "found" as const,
        response: await withSignedDocumentUrls(response, documentUrlSigner),
      }
    : { kind: "not_found" as const };
};
