import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorizeAction, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { auditLogController as controller } from "../controller/auditLogController";

// ORG-407, mounted at /api/v1: an Owner or Admin reads their own organization's audit log.
// Read-only: audit events are append-only and nothing here writes them.
const router = Router();
const read = [authenticate, authorizeAction("audit:read")];
const exportLimit = securityRateLimit({
  name: "audit-log-export",
  limit: 20,
  windowMs: 15 * 60_000,
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

router.get("/organization/audit-events", ...read, controller.list);
router.get("/organization/audit-events/filters", ...read, controller.filters);
router.get("/organization/audit-events/export", ...read, exportLimit, controller.exportCsv);

export default router;
