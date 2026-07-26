import crypto from "node:crypto";
import type { PublicGrantPurpose } from "../domain/publicGrant";

export const hashPublicGrant = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

export type PublicGrantRecord = {
  organizationId: string; resourceId: string; purpose: PublicGrantPurpose;
  expiresAt: Date; maxUses?: number | null; useCount: number; revokedAt?: Date | null;
};
export interface PublicAccessRepository {
  resourceOwned(resourceId: string, organizationId: string, userId: string): Promise<boolean>;
  create(input: PublicGrantRecord & { tokenHash: string; createdByUserId: string; recipientHash?: string | null }): Promise<{ id: string }>;
  consume(tokenHash: string, purpose: PublicGrantPurpose, resourceId: string, now: Date): Promise<PublicGrantRecord | null>;
  revoke(id: string, organizationId: string, reason: string): Promise<boolean>;
}

export const createPublicAccessManager = (repository: PublicAccessRepository) => ({
  async issue(input: { organizationId: string; resourceId: string; purpose: PublicGrantPurpose; createdByUserId: string; expiresInHours?: number; maxUses?: number; recipient?: string }) {
    if (!await repository.resourceOwned(input.resourceId, input.organizationId, input.createdByUserId)) {
      throw new Error("Proposal not found for this organization");
    }
    const token = newToken();
    const hours = Math.min(Math.max(input.expiresInHours ?? 168, 1), 720);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const recipientHash = input.recipient
      ? crypto.createHash("sha256").update(input.recipient.toLowerCase().trim()).digest("hex") : null;
    const record = await repository.create({ ...input, tokenHash: hashPublicGrant(token), recipientHash, expiresAt, useCount: 0, maxUses: input.maxUses ?? null });
    return { id: record.id, token, expiresAt, purpose: input.purpose, resourceId: input.resourceId };
  },
  validateAndConsume(input: { token: string; purpose: PublicGrantPurpose; resourceId: string }) {
    return repository.consume(hashPublicGrant(input.token), input.purpose, input.resourceId, new Date());
  },
  revoke: repository.revoke,
});
