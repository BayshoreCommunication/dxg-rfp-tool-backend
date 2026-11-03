import type { Request, Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  applicationUserResponse,
  bffRefreshResponse,
  correlationId,
  createSession,
  rejectInvalidBffCredential,
  respondWithSecondFactorStep,
} from "./authController";
import { getAuthenticatedUserAccount } from "../src/modules/auth/composition";
import { invitations } from "../src/modules/invitations/composition";
import type { AcceptOutcome, CreateOutcome, DailyLimitReached, InvitationService } from "../src/modules/invitations/application/manageInvitations";
import { TOKEN_REFUSAL_MESSAGES, isOrganizationAdmin, type InvitingActor, type TokenRefusal } from "../src/modules/invitations/domain/invitationRules";

const actorOf = (req: AuthRequest): InvitingActor | null => {
  const actor = req.rfpActor;
  if (!actor) return null;
  return { organizationId: String(actor.organizationId), userId: String(actor.userId), roles: actor.roles, managedTeamIds: actor.managedTeamIds.map(String) };
};

const mayInvite = (actor: InvitingActor) => isOrganizationAdmin(actor) || actor.roles.includes("team_manager");

const refuseToken = (res: Response, code: TokenRefusal) => {
  res.status(code === "INVITATION_INVALID" ? 404 : 410).json({ success: false, code, message: TOKEN_REFUSAL_MESSAGES[code] });
};

const fail = (res: Response) => (error: unknown) => {
  console.error("[Invitations] Request failed:", error instanceof Error ? error.name : "unknown");
  if (!res.headersSent) res.status(500).json({ success: false, message: "Something went wrong with the invitation. Try again." });
};

const respondToDailyLimit = (res: Response, outcome: DailyLimitReached) => {
  res.setHeader("Retry-After", outcome.retryAfterSeconds);
  res.status(429).json({ success: false, code: outcome.code, message: outcome.message, remaining: outcome.remaining });
};

const respondToCreate = (res: Response, outcome: CreateOutcome, single: boolean) => {
  if (outcome.kind === "limited") {
    respondToDailyLimit(res, outcome);
    return;
  }
  if (outcome.kind === "validation") {
    res.status(400).json({ success: false, code: outcome.code, message: outcome.message });
    return;
  }
  if (outcome.kind === "forbidden") {
    res.status(outcome.code === "TEAM_NOT_FOUND" ? 404 : 403).json({ success: false, code: outcome.code, message: outcome.message });
    return;
  }
  if (single) {
    const [row] = outcome.rows;
    if (row.outcome === "refused") {
      const status = row.code === "INVALID_EMAIL" ? 400 : 409;
      res.status(status).json({ success: false, code: row.code, message: row.message });
      return;
    }
    res.status(201).json({ success: true, invitation: row.invitation });
    return;
  }
  const invited = outcome.rows.filter((row) => row.outcome === "invited").length;
  res.status(200).json({ success: true, summary: { total: outcome.rows.length, invited, refused: outcome.rows.length - invited }, rows: outcome.rows });
};

export const createInvitationController = (service: InvitationService = invitations.service) => {
  const withActor = (handler: (req: AuthRequest, res: Response, actor: InvitingActor) => Promise<void>) =>
    (req: AuthRequest, res: Response): void => {
      const actor = actorOf(req);
      if (!actor) {
        res.status(401).json({ success: false, message: "Authentication required" });
        return;
      }
      if (!mayInvite(actor)) {
        res.status(403).json({ success: false, code: "INVITE_NOT_ALLOWED", message: "You don't have permission to manage invitations." });
        return;
      }
      handler(req, res, actor).catch(fail(res));
    };

  const respondToAccept = async (req: Request, res: Response, outcome: AcceptOutcome) => {
    switch (outcome.kind) {
      case "refused":
        refuseToken(res, outcome.code);
        return;
      case "validation":
        res.status(400).json({ success: false, code: outcome.code, message: outcome.message });
        return;
      case "invalid_identity":
        res.status(401).json({ success: false, code: "INVALID_GOOGLE_IDENTITY", message: "We couldn't verify your Google sign-in. Please try again." });
        return;
      case "email_mismatch":
        res.status(403).json({ success: false, code: "INVITATION_EMAIL_MISMATCH", message: "This invitation was sent to a different email address. Sign in with the invited email." });
        return;
      case "account_not_found":
        res.status(404).json({ success: false, code: "ACCOUNT_NOT_FOUND", message: "There's no account for this email yet. Create one to accept the invitation." });
        return;
      case "account_exists":
        res.status(409).json({ success: false, code: "ACCOUNT_EXISTS", message: "An account with this email already exists. Sign in to accept the invitation." });
        return;
      case "wrong_password":
        res.status(401).json({ success: false, code: "WRONG_PASSWORD", message: "Incorrect password. Please try again." });
        return;
      case "blocked":
        res.status(403).json({ success: false, code: "USER_BLOCKED", message: "Your account has been blocked. Please contact support." });
        return;
      case "conflict":
        res.status(409).json({ success: false, code: outcome.code, message: outcome.message });
        return;
      case "accepted": {
        const user = await getAuthenticatedUserAccount(outcome.userId);
        if (!user) throw new Error("Accepted account is missing");
        // The membership is in place; a Google accept still passes 2FA like /api/auth/google does.
        if (outcome.method === "sso" && await respondWithSecondFactorStep(req, res, { id: outcome.userId, organizationId: outcome.organizationId }, "sso")) return;
        const session = await createSession(req, res, { id: outcome.userId, organizationId: outcome.organizationId });
        res.status(200).json({
          success: true,
          message: "Invitation accepted",
          role: outcome.role,
          user: applicationUserResponse(user),
          accessToken: session.accessToken,
          tokenExpiresAt: session.expiresAt,
          tokenExpiresIn: session.expiresIn,
          sessionId: session.sessionId,
          ...bffRefreshResponse(req, session),
        });
      }
    }
  };

  return {
    list: withActor(async (req, res, actor) => {
      res.json({ success: true, invitations: await service.list(actor, { status: req.query.status }) });
    }),

    create: withActor(async (req, res, actor) => {
      respondToCreate(res, await service.create(actor, req.body ?? {}, correlationId(req)), true);
    }),

    createBulk: withActor(async (req, res, actor) => {
      respondToCreate(res, await service.createBulk(actor, req.body ?? {}, correlationId(req)), false);
    }),

    resend: withActor(async (req, res, actor) => {
      const outcome = await service.resend(actor, String(req.params.id), correlationId(req));
      if (outcome.kind === "not_found") {
        res.status(404).json({ success: false, code: "INVITATION_NOT_FOUND", message: "Invitation not found" });
      } else if (outcome.kind === "not_pending") {
        res.status(409).json({ success: false, code: "INVITATION_NOT_PENDING", message: `This invitation is ${outcome.status} and can't be resent.` });
      } else if (outcome.kind === "refused") {
        res.status(409).json({ success: false, code: outcome.code, message: outcome.message });
      } else if (outcome.kind === "cooldown") {
        res.setHeader("Retry-After", outcome.retryAfterSeconds);
        res.status(429).json({
          success: false,
          code: "INVITATION_RESEND_COOLDOWN",
          message: "This invitation was emailed a moment ago. Wait a few minutes before resending it.",
          retryAfterSeconds: outcome.retryAfterSeconds,
        });
      } else if (outcome.kind === "limited") {
        respondToDailyLimit(res, outcome);
      } else {
        res.json({ success: true, invitation: outcome.invitation });
      }
    }),

    revoke: withActor(async (req, res, actor) => {
      const outcome = await service.revoke(actor, String(req.params.id), correlationId(req));
      if (outcome.kind === "not_found") {
        res.status(404).json({ success: false, code: "INVITATION_NOT_FOUND", message: "Invitation not found" });
      } else if (outcome.kind === "not_pending") {
        res.status(409).json({ success: false, code: "INVITATION_NOT_PENDING", message: `This invitation is ${outcome.status} and can't be revoked.` });
      } else {
        res.json({ success: true, invitation: outcome.invitation });
      }
    }),

    // Public. The token travels in the body so it never lands in access logs.
    lookup: (req: Request, res: Response): void => {
      service.lookup(req.body?.token).then((outcome) => {
        if (outcome.kind === "refused") refuseToken(res, outcome.code);
        else res.json({ success: true, invitation: outcome.invitation });
      }).catch(fail(res));
    },

    acceptWithExistingAccount: (req: Request, res: Response): void => {
      if (rejectInvalidBffCredential(req, res)) return;
      service.acceptWithExistingAccount(req.body ?? {}, correlationId(req))
        .then((outcome) => respondToAccept(req, res, outcome))
        .catch(fail(res));
    },

    acceptWithNewAccount: (req: Request, res: Response): void => {
      if (rejectInvalidBffCredential(req, res)) return;
      service.acceptWithNewAccount(req.body ?? {}, correlationId(req))
        .then((outcome) => respondToAccept(req, res, outcome))
        .catch(fail(res));
    },

    acceptWithGoogle: (req: Request, res: Response): void => {
      if (rejectInvalidBffCredential(req, res)) return;
      service.acceptWithGoogle(req.body ?? {}, correlationId(req))
        .then((outcome) => respondToAccept(req, res, outcome))
        .catch(fail(res));
    },
  };
};
