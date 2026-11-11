import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import type { SecurityAuditWriter } from "../src/modules/auth/domain/ports/sessionPorts";
import { mongoSecurityAuditWriter } from "../src/modules/auth/infrastructure/audit/mongoSecurityAuditWriter";
import { LaunchMetricsError, launchMetricsReport, parseWindowDays, type LaunchMetricsSource } from "../src/modules/launchMetrics/domain";
import { mongoLaunchMetricsSource } from "../src/modules/launchMetrics/mongoLaunchMetricsSource";
import { isSupportAgent } from "../src/modules/supportAccess/domain";

// ORG-505: the launch metrics are aggregates over every customer organization, so only DXG staff
// on an `admins` account may read them. The route's role check alone would also pass a customer
// member who still holds a legacy staff role; the stored account type is what decides. Each read
// is recorded in the staff organization's audit trail.
export const createLaunchMetricsController = (dependencies?: { source?: LaunchMetricsSource; audit?: SecurityAuditWriter; clock?: () => Date }) => {
  const source = dependencies?.source ?? mongoLaunchMetricsSource;
  const audit = dependencies?.audit ?? mongoSecurityAuditWriter;
  const clock = dependencies?.clock ?? (() => new Date());
  return {
    getLaunchMetrics: async (req: AuthRequest, res: Response): Promise<void> => {
      try {
        const user = req.user;
        if (!user?.userId || !user.organizationId) throw new LaunchMetricsError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
        if (!isSupportAgent({ role: user.role, accountType: user.accountType })) {
          throw new LaunchMetricsError("LAUNCH_METRICS_FORBIDDEN", "Only RFPilot staff can read launch metrics.", 403);
        }
        const days = parseWindowDays(req.query.days);
        await audit.append({
          organizationId: user.organizationId,
          actorUserId: user.userId,
          action: "platform.launch_metrics.read",
          targetType: "platform",
          decision: "allowed",
          reason: "launch_metrics",
          correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
          metadata: { days, agentAccountType: "admin" },
        });
        res.status(200).json({ success: true, data: await launchMetricsReport(source, { days, now: clock() }) });
      } catch (error) {
        if (error instanceof LaunchMetricsError) {
          res.status(error.status).json({ success: false, code: error.code, message: error.message });
          return;
        }
        console.error("Launch metrics error:", error instanceof Error ? error.message : error);
        res.status(500).json({ success: false, code: "LAUNCH_METRICS_INTERNAL_ERROR", message: "The launch metrics could not be loaded." });
      }
    },
  };
};

export const launchMetricsController = createLaunchMetricsController();
