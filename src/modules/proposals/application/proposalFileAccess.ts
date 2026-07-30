/**
 * Reading back a privately stored proposal file.
 *
 * Support documents and AV quotes are the planner's own commercial material —
 * floor plans, prior proposals, budget sheets. They were uploaded with a
 * public-read ACL, so anyone holding (or guessing) the object URL could read
 * them with no authentication at all. New uploads are private; this is how an
 * authorized caller gets at them again.
 *
 * Authorization comes from the object key itself. Keys are minted server-side
 * as `<folder>/<PRIVATE_SEGMENT>/<ownerUserId>/<file>` from the authenticated
 * uploader's id, so requiring that segment to equal the requester's id is a
 * complete ownership check that needs no database lookup. Without it the
 * endpoint would presign any object in the bucket for any signed-in user.
 */

export const PROPOSAL_FILE_PRIVATE_SEGMENT = "proposal-files-private";

/** 15 minutes: long enough to open a large PDF, short enough that a leaked
 * link is not a standing grant. Matches the vendor-response signer. */
export const PROPOSAL_FILE_PRESIGN_SECONDS = 15 * 60;

export class ProposalFileAccessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 403,
  ) {
    super(message);
  }
}

export const ownerUserIdFromObjectKey = (objectKey: string): string | null => {
  const segments = objectKey.split("/");
  const index = segments.indexOf(PROPOSAL_FILE_PRIVATE_SEGMENT);
  if (index === -1) return null;
  return segments[index + 1] || null;
};

export const createPresignProposalFile = (dependencies: {
  objectKeyFromUrl: (url: string) => string | null;
  presign: (objectKey: string, expiresSeconds: number) => Promise<string>;
}) => async (input: { requesterUserId: string; url: string }): Promise<{ url: string }> => {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw new ProposalFileAccessError("PROPOSAL_FILE_URL_REQUIRED", "A file URL is required.", 400);

  // Objects uploaded before the private-storage change stay world-readable and
  // are returned unchanged; presigning them would imply a protection they do
  // not have. They are listed in the migration note in docs/SECURITY.md.
  if (!url.includes(`/${PROPOSAL_FILE_PRIVATE_SEGMENT}/`)) return { url };

  const objectKey = dependencies.objectKeyFromUrl(url);
  if (!objectKey) throw new ProposalFileAccessError("PROPOSAL_FILE_URL_INVALID", "That file URL is not recognized.", 400);

  const owner = ownerUserIdFromObjectKey(objectKey);
  if (!owner || owner !== input.requesterUserId) {
    throw new ProposalFileAccessError("PROPOSAL_FILE_FORBIDDEN", "That file does not belong to you.");
  }

  return { url: await dependencies.presign(objectKey, PROPOSAL_FILE_PRESIGN_SECONDS) };
};
