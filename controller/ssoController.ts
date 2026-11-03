import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserAccount } from "../src/modules/auth/composition";
import { dashboardUrl, federatedSignIn, manageSsoConnection } from "../src/modules/sso/composition";
import {
  applicationUserResponse,
  bffRefreshResponse,
  correlationId,
  createSession,
  isAuthorizedBff,
  respondWithSecondFactorStep,
} from "./authController";

/* Microsoft and company-OIDC sign-in (mounted at /api/auth/sso) and the Owner/Admin
   connection settings (mounted at /api/organization/sso). */

const safeCode = (code: string) => (/^[A-Z_]{3,60}$/.test(code) ? code : "SSO_ERROR");

/* Errors go back to the page the person started from: the invite page for an invitation,
   otherwise sign-in. Only a short error code travels in the URL. */
const errorRedirect = (code: string, inviteToken: string | null) =>
  inviteToken
    ? `${dashboardUrl()}/invite/${encodeURIComponent(inviteToken)}?error=${safeCode(code)}`
    : `${dashboardUrl()}/sign-in?error=${safeCode(code)}`;

/* GET /api/auth/sso/start?kind=microsoft|company&email=&invite=&bind= */
export const startSso = async (req: Request, res: Response): Promise<void> => {
  const invite = typeof req.query.invite === "string" && req.query.invite ? req.query.invite : null;
  try {
    const result = await federatedSignIn.start({
      kind: req.query.kind, email: req.query.email, invite: invite ?? undefined, bind: req.query.bind,
    });
    res.setHeader("Cache-Control", "no-store");
    if (result.kind === "redirect") {
      res.redirect(302, result.url);
      return;
    }
    res.redirect(302, errorRedirect(result.code, invite && /^[A-Za-z0-9_-]{16,200}$/.test(invite) ? invite : null));
  } catch (error) {
    console.error("SSO start error:", error instanceof Error ? error.name : "unknown");
    res.redirect(302, errorRedirect("SSO_ERROR", null));
  }
};

/* GET /api/auth/sso/callback?code=&state=  (the redirect URI registered with every IdP) */
export const ssoCallback = async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const result = await federatedSignIn.callback(
      { code: req.query.code, state: req.query.state, error: req.query.error },
      correlationId(req),
    );
    if (result.kind === "handoff") {
      res.redirect(302, `${dashboardUrl()}/sso/complete?handoff=${encodeURIComponent(result.handoff)}`);
      return;
    }
    res.redirect(302, errorRedirect(result.code, result.inviteToken));
  } catch (error) {
    console.error("SSO callback error:", error instanceof Error ? error.name : "unknown");
    res.redirect(302, errorRedirect("SSO_ERROR", null));
  }
};

/* POST /api/auth/sso/exchange { handoff, bind }  (dashboard server only) */
export const exchangeSsoHandoff = async (req: Request, res: Response): Promise<void> => {
  if (!isAuthorizedBff(req)) {
    res.status(403).json({ success: false, code: "BFF_AUTHORIZATION_INVALID", message: "BFF authorization is invalid" });
    return;
  }
  try {
    const result = await federatedSignIn.exchange({ handoff: req.body?.handoff, bind: req.body?.bind });
    if (result.kind === "error") {
      res.status(401).json({ success: false, code: result.code, message: "This sign-in link has expired. Please sign in again." });
      return;
    }
    const { outcome } = result;
    const user = await getAuthenticatedUserAccount(outcome.userId);
    if (!user) {
      res.status(401).json({ success: false, code: "SSO_HANDOFF_INVALID", message: "This sign-in link has expired. Please sign in again." });
      return;
    }
    // Company SSO never gets our 2FA prompt; Microsoft follows the same rules as Google.
    if (await respondWithSecondFactorStep(req, res, { id: outcome.userId, organizationId: outcome.organizationId }, outcome.method)) return;
    const session = await createSession(req, res, { id: outcome.userId, organizationId: outcome.organizationId });
    res.status(200).json({
      success: true,
      message: "Signed in",
      isNewUser: outcome.isNewUser,
      ...(outcome.role ? { role: outcome.role } : {}),
      user: applicationUserResponse(user),
      accessToken: session.accessToken,
      tokenExpiresAt: session.expiresAt,
      tokenExpiresIn: session.expiresIn,
      sessionId: session.sessionId,
      ...bffRefreshResponse(req, session),
    });
  } catch (error) {
    console.error("SSO exchange error:", error instanceof Error ? error.name : "unknown");
    res.status(500).json({ success: false, code: "SSO_ERROR", message: "Sign-in failed. Please try again." });
  }
};

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, code, message });
const actorOf = (req: AuthRequest) => ({ organizationId: req.user!.organizationId!, userId: req.user!.userId });
const handle = (res: Response, error: unknown, context: string) => {
  console.error(`Organization SSO ${context} error:`, error instanceof Error ? error.name : "unknown");
  fail(res, 500, "SSO_SETTINGS_ERROR", "Request failed");
};

/* GET /api/organization/sso */
export const getSsoSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.status(200).json({ success: true, ...(await manageSsoConnection.read(actorOf(req))) });
  } catch (error) {
    handle(res, error, "read");
  }
};

/* PUT /api/organization/sso { issuer, clientId, clientSecret?, domains, version? } */
export const saveSsoConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await manageSsoConnection.save(actorOf(req), req.body ?? {}, correlationId(req));
    switch (result.kind) {
      case "validation":
        fail(res, 400, "VALIDATION_ERROR", result.message);
        return;
      case "domain_not_verified":
        res.status(422).json({
          success: false, code: "SSO_DOMAIN_NOT_VERIFIED", domains: result.domains,
          message: "Every domain must be verified by your organization (and not used by another organization's SSO).",
        });
        return;
      case "issuer_unreachable":
        fail(res, 422, "SSO_ISSUER_UNREACHABLE", "We couldn't read the OpenID configuration at that issuer URL. Check it and try again.");
        return;
      case "version_conflict":
        fail(res, 409, "VERSION_CONFLICT", "Someone else changed these settings. Reload and try again.");
        return;
      default:
        res.status(200).json({ success: true, connection: result.connection });
    }
  } catch (error) {
    handle(res, error, "save");
  }
};

/* POST /api/organization/sso/test */
export const testSsoConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await manageSsoConnection.test(actorOf(req), correlationId(req));
    if (result.kind === "not_found") {
      fail(res, 404, "SSO_CONNECTION_NOT_FOUND", "Set up the connection first.");
      return;
    }
    res.status(200).json({ success: true, ok: result.ok, issuer: result.issuer, authorizationEndpoint: result.authorizationEndpoint, problems: result.problems });
  } catch (error) {
    handle(res, error, "test");
  }
};

/* PUT /api/organization/sso/status { status: "active" | "draft" } */
export const setSsoStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await manageSsoConnection.setStatus(actorOf(req), req.body?.status, correlationId(req));
    if (result.kind === "validation") {
      fail(res, 400, "VALIDATION_ERROR", "status must be active or draft");
      return;
    }
    if (result.kind === "not_found") {
      fail(res, 404, "SSO_CONNECTION_NOT_FOUND", "Set up the connection first.");
      return;
    }
    res.status(200).json({ success: true, connection: result.connection });
  } catch (error) {
    handle(res, error, "status");
  }
};

/* PUT /api/organization/sso/require { requireSso } */
export const setRequireSso = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await manageSsoConnection.setRequireSso(actorOf(req), req.body?.requireSso, correlationId(req));
    if (result.kind === "validation") {
      fail(res, 400, "VALIDATION_ERROR", "requireSso must be true or false");
      return;
    }
    if (result.kind === "connection_not_active") {
      fail(res, 409, "SSO_CONNECTION_NOT_ACTIVE", "Turn on your SSO connection before requiring it.");
      return;
    }
    res.status(200).json({ success: true, requireSso: result.requireSso, signedOutMembers: result.signedOutMembers });
  } catch (error) {
    handle(res, error, "require");
  }
};

/* DELETE /api/organization/sso */
export const deleteSsoConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await manageSsoConnection.remove(actorOf(req), correlationId(req));
    if (result.kind === "not_found") {
      fail(res, 404, "SSO_CONNECTION_NOT_FOUND", "There is no SSO connection to remove.");
      return;
    }
    res.status(200).json({ success: true });
  } catch (error) {
    handle(res, error, "delete");
  }
};
