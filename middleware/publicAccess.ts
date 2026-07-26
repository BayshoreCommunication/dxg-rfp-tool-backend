import { NextFunction, Request, Response } from "express";
import type { PublicGrantPurpose } from "../src/modules/publicAccess/domain/publicGrant";
import { publicAccess } from "../src/modules/publicAccess/composition";
import { AuthRequest } from "./auth";

export const requirePublicGrant = (purpose: PublicGrantPurpose | readonly PublicGrantPurpose[]) => async (req: Request, res: Response, next: NextFunction) => {
  if ((req as AuthRequest).user) return next();
  // Fail closed: enforcement is the default. Disabling requires an explicit
  // opt-out, and never in production.
  if (process.env.PUBLIC_GRANTS_ENFORCED === "false" && process.env.NODE_ENV !== "production") return next();
  const token = typeof req.query.accessGrant === "string" ? req.query.accessGrant
    : typeof req.body?.accessGrant === "string" ? req.body.accessGrant
    : typeof req.headers["x-rfpilot-access-grant"] === "string" ? req.headers["x-rfpilot-access-grant"] : "";
  const resourceId = req.params.id || req.body?.proposalId || req.query.proposalId;
  if (!token || typeof resourceId !== "string") {
    res.status(401).json({ success: false, message: "A valid access grant is required" }); return;
  }
  const purposes = Array.isArray(purpose) ? purpose : [purpose];
  let grant = null;
  for (const candidate of purposes) {
    grant = await publicAccess.validateAndConsume({ token, purpose: candidate, resourceId });
    if (grant) break;
  }
  if (!grant) { res.status(403).json({ success: false, message: "Access grant is invalid, expired, revoked, or exhausted" }); return; }
  next();
};
