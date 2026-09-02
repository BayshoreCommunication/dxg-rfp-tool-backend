import crypto from "node:crypto";
import type { PublicGrantPurpose } from "../domain/publicGrant";

export const hashPublicGrant = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const normalizeRecipient = (recipient?: string) => recipient?.trim().toLowerCase() ?? "";
const hashRecipient = (recipient: string) => crypto.createHash("sha256").update(recipient).digest("hex");

export type PublicGrantRecord = {
  organizationId: string; resourceId: string; purpose: PublicGrantPurpose;
  expiresAt: Date; maxUses?: number | null; useCount: number; revokedAt?: Date | null;
};
export interface PublicAccessRepository {
  resourceOwned(resourceId: string, organizationId: string, userId: string): Promise<boolean>;
  create(input: PublicGrantRecord & { tokenHash: string; createdByUserId: string; recipientHash?: string | null }): Promise<{ id: string }>;
  consume(tokenHash: string, purpose: PublicGrantPurpose, resourceId: string, now: Date, recipientHash?: string | null): Promise<PublicGrantRecord | null>;
  revoke(id: string, organizationId: string, reason: string): Promise<boolean>;
}

export const createPublicAccessManager = (repository: PublicAccessRepository) => ({
  async issue(input: { organizationId: string; resourceId: string; purpose: PublicGrantPurpose; createdByUserId: string; expiresInHours?: number; maxUses?: number; recipient?: string }) {
    if (!await repository.resourceOwned(input.resourceId, input.organizationId, input.createdByUserId)) {
      throw new Error("Proposal not found for this organization");
    }
    const recipient = normalizeRecipient(input.recipient);
    if (input.purpose === "vendor:submit" && !recipient) {
      throw new Error("Recipient is required for vendor submission grants");
    }
    const token = newToken();
    const hours = Math.min(Math.max(input.expiresInHours ?? 168, 1), 720);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const recipientHash = recipient ? hashRecipient(recipient) : null;
    const record = await repository.create({ ...input, tokenHash: hashPublicGrant(token), recipientHash, expiresAt, useCount: 0, maxUses: input.maxUses ?? null });
    return { id: record.id, token, expiresAt, purpose: input.purpose, resourceId: input.resourceId };
  },
  validateAndConsume(input: {
    token: string;
    purpose: PublicGrantPurpose;
    resourceId: string;
    recipient?: string;
    allowRecipientlessVendorProposalRead?: boolean;
    allowAlternateVendorContact?: boolean;
  }) {
    const recipient = normalizeRecipient(input.recipient);
    if (
      input.purpose === "vendor:submit"
      && !recipient
      && !input.allowRecipientlessVendorProposalRead
      && !input.allowAlternateVendorContact
    ) return Promise.resolve(null);
    const recipientHash = input.purpose === "vendor:submit" && input.allowAlternateVendorContact
      ? null
      : recipient
        ? hashRecipient(recipient)
        : undefined;
    return repository.consume(
      hashPublicGrant(input.token),
      input.purpose,
      input.resourceId,
      new Date(),
      recipientHash,
    );
  },
  revoke: repository.revoke,
});
