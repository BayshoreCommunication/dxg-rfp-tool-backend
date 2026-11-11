import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { AuditLogError, type AuditLogActor } from "../src/modules/auditLog/domain";
import type { AuditLog } from "../src/modules/auditLog/application/readAuditLog";
import { auditLog } from "../src/modules/auditLog/composition";

// The organization is always the signed-in member's own; nothing in the query can widen it.
const actorFrom = (req: AuthRequest): AuditLogActor => {
  const user = req.user;
  if (!user?.userId || !user.organizationId) throw new AuditLogError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { userId: user.userId, organizationId: user.organizationId, roles: user.roles ?? [] };
};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof AuditLogError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  console.error("Audit log error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "AUDIT_LOG_INTERNAL_ERROR", message: "The audit log request could not be completed." });
};

export const createAuditLogController = (log: AuditLog = auditLog) => ({
  filters: (req: AuthRequest, res: Response) => {
    try {
      res.status(200).json({ success: true, data: log.filters(actorFrom(req)) });
    } catch (error) {
      fail(res, error);
    }
  },
  list: async (req: AuthRequest, res: Response) => {
    try {
      res.status(200).json({ success: true, data: await log.list(actorFrom(req), req.query as Record<string, unknown>) });
    } catch (error) {
      fail(res, error);
    }
  },
  exportCsv: async (req: AuthRequest, res: Response) => {
    try {
      const result = await log.exportCsv(actorFrom(req), req.query as Record<string, unknown>);
      res.status(200)
        .setHeader("Content-Type", "text/csv; charset=utf-8")
        .setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
        .setHeader("Cache-Control", "no-store")
        .setHeader("X-Audit-Export-Rows", String(result.rows))
        .setHeader("X-Audit-Export-Truncated", String(result.truncated))
        .send(result.csv);
    } catch (error) {
      fail(res, error);
    }
  },
});

export const auditLogController = createAuditLogController();
