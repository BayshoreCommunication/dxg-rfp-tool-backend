import { bcryptPasswordHasher, bcryptPasswordVerifier } from "../../shared/security/bcryptPasswordHasher";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { mongoAuthAccountRepository } from "../auth/infrastructure/mongo/mongoAuthAccountRepository";
import { createInvitationDispatcher } from "./application/dispatchInvitations";
import { createInvitationService } from "./application/manageInvitations";
import { createInvitationSweep } from "./application/sweepInvitations";
import { mongoInvitationSweepRepository } from "./infrastructure/mongoInvitationSweepRepository";
import type { InvitationMailer, InvitationTeamDirectory } from "./domain/ports";
import { createMongoInvitationAcceptance } from "./infrastructure/mongoInvitationAcceptance";
import { mongoInvitationRepository } from "./infrastructure/mongoInvitationRepository";
import {
  mongoInviteeDirectory,
  mongoOrganizationDirectory,
  noTeamPlacementYet,
  unverifiedTeamDirectory,
  type TeamPlacement,
} from "./infrastructure/mongoInviteeDirectory";
import { defaultInvitationMailer } from "./infrastructure/invitationMailer";

// The dashboard's accept page (ORG-205). FRONTEND_URL is the dashboard origin.
export const invitationAcceptUrl = (token: string): string => {
  const base = (process.env.FRONTEND_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
  return `${base}/invite/${encodeURIComponent(token)}`;
};

export const createInvitationModule = (overrides: {
  mailer?: InvitationMailer;
  teams?: InvitationTeamDirectory;
  placeInTeam?: TeamPlacement;
  now?: () => Date;
} = {}) => {
  const teams = overrides.teams ?? unverifiedTeamDirectory;
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
    acceptance: createMongoInvitationAcceptance(overrides.placeInTeam ?? noTeamPlacementYet),
    credentials: mongoAuthAccountRepository,
    passwords: { hash: (value) => bcryptPasswordHasher.hash(value), verify: (value, hash) => bcryptPasswordVerifier.verify(value, hash) },
    dispatcher,
    audit: mongoSecurityAuditWriter,
    now: overrides.now,
  });
  const sweep = createInvitationSweep({ sweeps: mongoInvitationSweepRepository, dispatcher, now: overrides.now });
  return { service, dispatcher, sweep };
};

export const invitations = createInvitationModule();
export const sweepInvitations = () => invitations.sweep();
