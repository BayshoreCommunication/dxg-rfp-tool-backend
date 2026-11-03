import { bcryptPasswordHasher, bcryptPasswordVerifier } from "../../shared/security/bcryptPasswordHasher";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { mongoAuthAccountRepository } from "../auth/infrastructure/mongo/mongoAuthAccountRepository";
import { googleIdTokenVerifier } from "../auth/infrastructure/identity/googleIdTokenVerifier";
import { cryptoSecretGenerator } from "../auth/infrastructure/security/cryptoSecretGenerator";
import type { GoogleIdentityVerifier } from "../auth/domain/ports/googleIdentityPorts";
import { createInvitationDispatcher } from "./application/dispatchInvitations";
import { createInvitationService } from "./application/manageInvitations";
import { createInvitationSweep } from "./application/sweepInvitations";
import { mongoInvitationSweepRepository } from "./infrastructure/mongoInvitationSweepRepository";
import { DEFAULT_DAILY_INVITATION_EMAIL_LIMIT } from "./domain/invitationRules";
import type { InvitationEmailQuota, InvitationMailer, InvitationTeamDirectory } from "./domain/ports";
import { createMongoInvitationAcceptance } from "./infrastructure/mongoInvitationAcceptance";
import { mongoInvitationRepository } from "./infrastructure/mongoInvitationRepository";
import { mongoInvitationEmailQuota } from "./infrastructure/mongoInvitationEmailQuota";
import { mongoInviteeDirectory, mongoOrganizationDirectory } from "./infrastructure/mongoInviteeDirectory";
import { placeInTeam, teamsInvitationDirectory, type TeamPlacement } from "./infrastructure/teamsInvitationDirectory";
import { defaultInvitationMailer } from "./infrastructure/invitationMailer";
import { mongoCompanySsoFor, mongoSsoRequiredFor } from "../sso/infrastructure/mongoSsoRepositories";

// The dashboard's accept page (ORG-205). FRONTEND_URL is the dashboard origin.
export const invitationAcceptUrl = (token: string): string => {
  const base = (process.env.FRONTEND_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
  return `${base}/invite/${encodeURIComponent(token)}`;
};

// A positive whole number from the environment, else the default.
export const dailyInvitationEmailLimit = (value = process.env.INVITATION_DAILY_EMAIL_LIMIT): number => {
  const parsed = Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_INVITATION_EMAIL_LIMIT;
};

export const createInvitationModule = (overrides: {
  mailer?: InvitationMailer;
  teams?: InvitationTeamDirectory;
  placeInTeam?: TeamPlacement;
  quota?: InvitationEmailQuota;
  google?: GoogleIdentityVerifier;
  dailyEmailLimit?: number;
  resendCooldownMs?: number;
  now?: () => Date;
} = {}) => {
  const teams = overrides.teams ?? teamsInvitationDirectory;
  const dispatcher = createInvitationDispatcher({
    invitations: mongoInvitationRepository,
    organizations: mongoOrganizationDirectory,
    teams,
    mailer: overrides.mailer ?? defaultInvitationMailer(),
    acceptUrl: invitationAcceptUrl,
    now: overrides.now,
    // The error can quote provider responses; only say that it happened.
    onError: () => console.error("[Invitations] Invitation email delivery failed"),
  });
  const service = createInvitationService({
    invitations: mongoInvitationRepository,
    invitees: mongoInviteeDirectory,
    organizations: mongoOrganizationDirectory,
    teams,
    acceptance: createMongoInvitationAcceptance(overrides.placeInTeam ?? placeInTeam),
    credentials: mongoAuthAccountRepository,
    passwords: { hash: (value) => bcryptPasswordHasher.hash(value), verify: (value, hash) => bcryptPasswordVerifier.verify(value, hash) },
    dispatcher,
    audit: mongoSecurityAuditWriter,
    quota: overrides.quota ?? mongoInvitationEmailQuota,
    google: overrides.google ?? googleIdTokenVerifier,
    randomSecret: () => cryptoSecretGenerator.generate(),
    ssoRequiredFor: mongoSsoRequiredFor,
    companySsoFor: mongoCompanySsoFor,
    dailyEmailLimit: overrides.dailyEmailLimit ?? dailyInvitationEmailLimit(),
    resendCooldownMs: overrides.resendCooldownMs,
    now: overrides.now,
  });
  const sweep = createInvitationSweep({ sweeps: mongoInvitationSweepRepository, dispatcher, now: overrides.now });
  return { service, dispatcher, sweep };
};

export const invitations = createInvitationModule();
export const sweepInvitations = () => invitations.sweep();
