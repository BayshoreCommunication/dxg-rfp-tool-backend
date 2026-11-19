/* Organization block (owner decision, 2026-11-18; docs/DECISIONS.md "RFPilot staff block and
   reactivate a customer organization"). RFPilot staff may block a whole customer organization
   and reactivate it. A block closes everything for that organization: member sign-in and
   sessions, its public links, and its background work. Data is kept.

   THE RULE EXISTS ONCE, HERE. An organization is blocked when, and only when, its document
   carries the dedicated `blocked` marker with a real date in `blocked.at`. The marker has no
   schema default, so a document that lacks the field (every organization that staff never
   blocked, and every document written before this change) is by construction NOT blocked.
   `Organization.status` is a different thing (`inactive` is written by a placement rollback) and
   is never read here. Every enforcement point asks `isOrganizationBlocked`, directly or through
   `organizationBlockGate`; none re-implements it (tests/organization-block-guard.test.js). */

export type OrganizationBlockMarker = {
  at: Date;
  /** The staff organization and account the block is recorded for. Never returned to a customer. */
  byStaffOrganizationId: string;
  byStaffAccountId: string;
};

type MaybeBlocked = { blocked?: { at?: unknown } | null } | null | undefined;

/** True only for an organization document whose `blocked.at` is a valid date. A missing
    organization, a missing or null marker, or a marker without a real date is not blocked. */
export const isOrganizationBlocked = (organization: MaybeBlocked): boolean => {
  const at = organization?.blocked?.at;
  return at instanceof Date && !Number.isNaN(at.getTime());
};

/** Since when, or null when the organization is not blocked. */
export const blockedSince = (organization: MaybeBlocked): Date | null =>
  isOrganizationBlocked(organization) ? (organization!.blocked!.at as Date) : null;

/* What a MEMBER of a blocked organization is told (sign-in, an authenticated request, a session
   refresh). The dashboard shows a plain message for this code. A vendor or an invited person is
   never told: public surfaces answer exactly as they do for a link that does not exist. */
export const ORGANIZATION_BLOCKED = {
  code: "ORGANIZATION_BLOCKED",
  message: "Your organization's access to RFPilot is paused. Contact RFPilot support.",
} as const;

/* The revoke reason of a session ended because staff blocked the organization. Like the reason
   of a staff membership change (auth/domain/ports/sessionPorts.ts, `isStaffCausedRevokeReason`)
   it marks a revocation that RFPilot staff caused, so presenting
   such a session's last refresh token again writes no "reuse detected" event in the customer
   organization (customers see no staff activity). */
export const ORGANIZATION_BLOCK_REVOKE_REASON = "staff_organization_blocked";

export class OrganizationBlockedError extends Error {
  readonly code = ORGANIZATION_BLOCKED.code;
  readonly status = 403;
  constructor() {
    super(ORGANIZATION_BLOCKED.message);
    this.name = "OrganizationBlockedError";
  }
}
