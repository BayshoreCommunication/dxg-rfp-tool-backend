import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  applicationUserResponse,
  bffRefreshResponse,
  correlationId,
  createSession,
  rejectInvalidBffCredential,
} from "./authController";
import { authenticateWithCredentials, getAuthenticatedUserAccount } from "../src/modules/auth/composition";
import { TwoFactorNotConfiguredError, accountIsSsoLinked, twoFactor } from "../src/modules/twoFactor/composition";
import { reauthenticationForDisable } from "../src/modules/twoFactor/domain/secondFactorPolicy";

/* ORG-303 TOTP two-factor. Pre-session endpoints take the challenge token from
   sign-in; the rest need a normal session. Codes never appear in logs or audit
   metadata. */

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) => {
  res.status(status).json({ success: false, code, message, ...extra });
};

const handleError = (res: Response, error: unknown, context: string) => {
  if (error instanceof TwoFactorNotConfiguredError) {
    fail(res, 503, "TWO_FACTOR_NOT_CONFIGURED", "Two-factor authentication is not available right now");
    return;
  }
  console.error(`Two-factor ${context} error:`, error instanceof Error ? error.name : "unknown");
  fail(res, 500, "TWO_FACTOR_ERROR", "Two-factor request failed");
};

const respondToVerifyFailure = (res: Response, result: { kind: string; retryAfterSeconds?: number }) => {
  if (result.kind === "locked") {
    res.setHeader("Retry-After", String(result.retryAfterSeconds ?? 900));
    fail(res, 429, "TWO_FACTOR_LOCKED", "Too many incorrect codes. Try again later.");
    return;
  }
  if (result.kind === "not_enrolled") {
    fail(res, 409, "TWO_FACTOR_NOT_ENABLED", "Two-factor authentication is not enabled");
    return;
  }
  if (result.kind === "required_by_organization") {
    fail(res, 403, "TWO_FACTOR_REQUIRED_BY_ORGANIZATION", "Your organization requires two-factor authentication");
    return;
  }
  fail(res, 401, "TWO_FACTOR_INVALID_CODE", "That code isn't valid");
};

// Issues the session a password sign-in would have, once the second factor is satisfied.
const respondWithSession = async (req: Request, res: Response, userId: string, extra: Record<string, unknown>) => {
  const user = await getAuthenticatedUserAccount(userId);
  if (!user?.organizationId) {
    fail(res, 403, "MEMBERSHIP_INACTIVE", "Active organization membership required");
    return;
  }
  let session;
  try {
    session = await createSession(req, res, user);
  } catch (error) {
    if (error instanceof Error && /membership/i.test(error.message)) {
      fail(res, 403, "MEMBERSHIP_INACTIVE", "Active organization membership required");
      return;
    }
    throw error;
  }
  res.status(200).json({
    success: true,
    message: "Login successful",
    user: applicationUserResponse(user),
    accessToken: session.accessToken,
    tokenExpiresAt: session.expiresAt,
    tokenExpiresIn: session.expiresIn,
    sessionId: session.sessionId,
    ...extra,
    ...bffRefreshResponse(req, session),
  });
};

/* POST /api/auth/2fa/challenge { challengeToken, code | recoveryCode } */
export const completeTwoFactorChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidBffCredential(req, res)) return;
    const result = await twoFactor.completeChallenge({
      challengeToken: req.body?.challengeToken,
      code: req.body?.code,
      recoveryCode: req.body?.recoveryCode,
      correlationId: correlationId(req),
    });
    if (result.kind === "invalid_challenge") {
      fail(res, 401, "TWO_FACTOR_CHALLENGE_INVALID", "This sign-in attempt has expired. Please sign in again.");
      return;
    }
    if (result.kind !== "verified") {
      respondToVerifyFailure(res, result);
      return;
    }
    await respondWithSession(req, res, result.userId, result.usedRecoveryCode
      ? { recoveryCodesRemaining: result.recoveryCodesRemaining }
      : {});
  } catch (error) {
    handleError(res, error, "challenge");
  }
};

const accountName = async (userId: string) => (await getAuthenticatedUserAccount(userId))?.email ?? userId;

/* POST /api/auth/2fa/enrolment/start { challengeToken }: org-mandatory enrolment during sign-in */
export const startChallengeEnrolment = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await twoFactor.startChallengeEnrolment({ challengeToken: req.body?.challengeToken, accountName });
    if (result.kind === "invalid_challenge") {
      fail(res, 401, "TWO_FACTOR_CHALLENGE_INVALID", "This sign-in attempt has expired. Please sign in again.");
      return;
    }
    if (result.kind === "already_enabled") {
      fail(res, 409, "TWO_FACTOR_ALREADY_ENABLED", "Two-factor authentication is already enabled");
      return;
    }
    res.status(200).json({ success: true, otpauthUri: result.otpauthUri, secret: result.secret });
  } catch (error) {
    handleError(res, error, "enrolment start");
  }
};

/* POST /api/auth/2fa/enrolment/confirm { challengeToken, code } → recovery codes and a session */
export const confirmChallengeEnrolment = async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidBffCredential(req, res)) return;
    const result = await twoFactor.confirmChallengeEnrolment({
      challengeToken: req.body?.challengeToken,
      code: req.body?.code,
      correlationId: correlationId(req),
    });
    if (result.kind === "invalid_challenge") {
      fail(res, 401, "TWO_FACTOR_CHALLENGE_INVALID", "This sign-in attempt has expired. Please sign in again.");
      return;
    }
    if (result.kind === "not_started") {
      fail(res, 409, "TWO_FACTOR_ENROLMENT_NOT_STARTED", "Start two-factor setup first");
      return;
    }
    if (result.kind === "already_enabled") {
      fail(res, 409, "TWO_FACTOR_ALREADY_ENABLED", "Two-factor authentication is already enabled");
      return;
    }
    if (result.kind !== "enabled") {
      respondToVerifyFailure(res, result);
      return;
    }
    await respondWithSession(req, res, result.userId, { recoveryCodes: result.recoveryCodes });
  } catch (error) {
    handleError(res, error, "enrolment confirm");
  }
};

/* GET /api/auth/2fa/status */
export const getTwoFactorStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const status = await twoFactor.status({ userId: req.user!.userId, organizationId: req.user!.organizationId! });
    res.status(200).json({ success: true, ...status });
  } catch (error) {
    handleError(res, error, "status");
  }
};

/* POST /api/auth/2fa/enrol/start: a signed-in member turns 2FA on */
export const startEnrolment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await twoFactor.startEnrolment({
      userId: req.user!.userId,
      organizationId: req.user!.organizationId!,
      accountName: req.user!.email || req.user!.userId,
    });
    if (result.kind === "already_enabled") {
      fail(res, 409, "TWO_FACTOR_ALREADY_ENABLED", "Two-factor authentication is already enabled");
      return;
    }
    res.status(200).json({ success: true, otpauthUri: result.otpauthUri, secret: result.secret });
  } catch (error) {
    handleError(res, error, "enrolment start");
  }
};

/* POST /api/auth/2fa/enrol/confirm { code } */
export const confirmEnrolment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await twoFactor.confirmEnrolment({
      userId: req.user!.userId,
      organizationId: req.user!.organizationId!,
      code: req.body?.code,
      correlationId: correlationId(req),
    });
    if (result.kind === "not_started") {
      fail(res, 409, "TWO_FACTOR_ENROLMENT_NOT_STARTED", "Start two-factor setup first");
      return;
    }
    if (result.kind === "already_enabled") {
      fail(res, 409, "TWO_FACTOR_ALREADY_ENABLED", "Two-factor authentication is already enabled");
      return;
    }
    if (result.kind !== "enabled") {
      respondToVerifyFailure(res, result);
      return;
    }
    res.status(200).json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (error) {
    handleError(res, error, "enrolment confirm");
  }
};

// Re-authentication: the account password, checked the same way sign-in checks it.
const passwordMatches = async (req: AuthRequest) => {
  const result = await authenticateWithCredentials({ email: req.user!.email, password: req.body?.password }, "customer");
  return result.kind === "authenticated" && result.user.id === req.user!.userId;
};

/* POST /api/auth/2fa/disable { password?, code | recoveryCode }
   password is optional only for an SSO-linked account; the code is always required. */
export const disableTwoFactor = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const passwordSupplied = typeof req.body?.password === "string" && req.body.password.length > 0;
    const reauthentication = reauthenticationForDisable({
      passwordSupplied,
      passwordMatches: passwordSupplied && await passwordMatches(req),
      ssoLinked: !passwordSupplied && await accountIsSsoLinked(req.user!.userId),
    });
    if (reauthentication === "refused") {
      fail(res, 401, "REAUTHENTICATION_FAILED", "Password is incorrect");
      return;
    }
    const result = await twoFactor.disable({
      userId: req.user!.userId,
      organizationId: req.user!.organizationId!,
      code: req.body?.code,
      recoveryCode: req.body?.recoveryCode,
      correlationId: correlationId(req),
      reauthentication,
    });
    if (result.kind !== "disabled") {
      respondToVerifyFailure(res, result);
      return;
    }
    res.status(200).json({ success: true, message: "Two-factor authentication disabled" });
  } catch (error) {
    handleError(res, error, "disable");
  }
};

/* POST /api/auth/2fa/recovery-codes { code | recoveryCode } → ten new codes, old ones void */
export const regenerateRecoveryCodes = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await twoFactor.regenerateRecoveryCodes({
      userId: req.user!.userId,
      organizationId: req.user!.organizationId!,
      code: req.body?.code,
      recoveryCode: req.body?.recoveryCode,
      correlationId: correlationId(req),
    });
    if (result.kind !== "regenerated") {
      respondToVerifyFailure(res, result);
      return;
    }
    res.status(200).json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (error) {
    handleError(res, error, "recovery codes");
  }
};
