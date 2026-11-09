import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { requestActorFor } from "../src/modules/identity/application/proposalAccess";
import { RfpDashboardError } from "../src/modules/rfpDashboard/domain";
import { rfpDashboard } from "../src/modules/rfpDashboard/composition";
import type { RfpDashboard } from "../src/modules/rfpDashboard/application";
import { safeLog } from "../src/shared/observability/safeTelemetry";

const fail = (res: Response, error: unknown, operation: string) => {
  if (error instanceof RfpDashboardError) {
    res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return;
  }
  safeLog("error", "rfp_dashboard_request_failed", { operation, errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN", outcome: "failure" });
  res.status(500).json({ success: false, code: "DASHBOARD_INTERNAL_ERROR", message: "The dashboard could not be loaded." });
};

// ORG-401: GET /api/v1/rfps and /api/v1/rfps/summary. Both read only what the access policy lets
// the signed-in member see.
export const createRfpDashboardController = (dashboard: RfpDashboard = rfpDashboard) => {
  const handle = (operation: "list" | "summary") => async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, message: "Authentication required" });
        return;
      }
      const query = req.query as Record<string, unknown>;
      const actor = requestActorFor(userId);
      res.json({ success: true, data: operation === "list" ? await dashboard.list(actor, query) : await dashboard.summary(actor, query) });
    } catch (error) {
      fail(res, error, operation);
    }
  };
  return { list: handle("list"), summary: handle("summary") };
};

export const rfpDashboardController = createRfpDashboardController();
