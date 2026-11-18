import SecurityAuditEvent from "../../../../../modal/securityAuditEventModel";
import type { SecurityAuditWriter } from "../../domain/ports/sessionPorts";

const forbiddenMetadataKey = /authorization|token|password|otp|secret|cookie|content/i;

// Shared with writers that insert an event inside their own transaction.
export const safeAuditMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> =>
  Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => !forbiddenMetadataKey.test(key)));

export const mongoSecurityAuditWriter: SecurityAuditWriter = {
  async append(input) {
    const metadata = safeAuditMetadata(input.metadata);
    await SecurityAuditEvent.create({
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      decision: input.decision,
      reason: input.reason,
      correlationId: input.correlationId,
      metadata,
    });
  },
};
