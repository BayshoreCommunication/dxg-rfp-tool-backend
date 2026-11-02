import { generateInvitationToken, hashInvitationToken } from "../domain/invitationRules";
import type { InvitationMailer, InvitationRepository, InvitationTeamDirectory, OrganizationDirectory } from "../domain/ports";

export const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_LEASE_MS = 5 * 60 * 1000;

export type DispatchResult = "sent" | "failed" | "sending";

// Every email carries a link minted for it. The raw token never touches the database, so a failed
// send can't be retried with the same link: each attempt rotates the token in the same write that
// claims the attempt, and an attempt that lost its claim can't mark a newer one as done.
export const createInvitationDispatcher = (deps: {
  invitations: InvitationRepository;
  organizations: OrganizationDirectory;
  teams: InvitationTeamDirectory;
  mailer: InvitationMailer;
  acceptUrl: (token: string) => string;
  now?: () => Date;
  onError?: (error: unknown) => void;
}) => {
  const now = deps.now ?? (() => new Date());

  const dispatch = async (invitationId: string): Promise<DispatchResult> => {
    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const at = now();
    const claimed = await deps.invitations.claimDelivery(invitationId, {
      now: at,
      leaseUntil: new Date(at.getTime() + DELIVERY_LEASE_MS),
      tokenHash,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });
    // Someone else holds the attempt, it was already sent, or the invitation closed.
    if (!claimed) return "sending";
    try {
      const [organization, inviterName, teams] = await Promise.all([
        deps.organizations.find(claimed.organizationId),
        deps.organizations.userName(claimed.invitedBy),
        claimed.teamId ? deps.teams.findTeams(claimed.organizationId, [claimed.teamId]) : Promise.resolve(new Map<string, { name: string | null }>()),
      ]);
      if (!organization) throw new Error("Invitation organization is unavailable");
      await deps.mailer.send({
        kind: claimed.delivery.kind,
        to: claimed.email,
        organizationName: organization.name,
        inviterName,
        role: claimed.role,
        teamName: claimed.teamId ? teams.get(claimed.teamId)?.name ?? null : null,
        acceptUrl: deps.acceptUrl(token),
        expiresAt: claimed.expiresAt,
      });
      await deps.invitations.completeDelivery(invitationId, { now: now(), outcome: "sent", tokenHash });
      return "sent";
    } catch (error) {
      deps.onError?.(error);
      await deps.invitations.completeDelivery(invitationId, { now: now(), outcome: "failed", tokenHash }).catch(() => undefined);
      return "failed";
    }
  };

  return {
    dispatch,
    // Bulk invites answer at once and send afterwards, one at a time; whatever fails here is
    // picked up again by the delivery sweep.
    dispatchInBackground(invitationIds: readonly string[]): void {
      void (async () => {
        for (const id of invitationIds) {
          try {
            await dispatch(id);
          } catch (error) {
            deps.onError?.(error);
          }
        }
      })();
    },
  };
};

export type InvitationDispatcher = ReturnType<typeof createInvitationDispatcher>;
