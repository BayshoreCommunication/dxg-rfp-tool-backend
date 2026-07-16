import SecurityAuditEvent from "../../../../../modal/securityAuditEventModel";
import type { SecurityAuditWriter } from "../../domain/ports/sessionPorts";

const forbiddenMetadataKey = /authorization|token|password|otp|secret|cookie|content/i;

export const mongoSecurityAuditWriter: SecurityAuditWriter = {
  async append(input) {
    const metadata = Object.fromEntries(
      Object.entries(input.metadata ?? {}).filter(([key]) => !forbiddenMetadataKey.test(key)),
    );
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
