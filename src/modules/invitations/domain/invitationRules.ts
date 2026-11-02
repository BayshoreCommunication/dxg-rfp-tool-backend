import crypto from "node:crypto";

// Owner is never invited: there is exactly one, and it moves only by ownership transfer.
export const INVITABLE_ROLES = ["organization_admin", "team_manager", "planner", "viewer"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// The reminder goes out once the invitation has a day or less left, i.e. on day six.
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
export const MAX_BULK_INVITATIONS = 500;

const ADMIN_ROLES = ["owner", "organization_admin"];
// A Team Manager invites people to work in their team, never people who would manage others.
const MANAGER_INVITABLE_ROLES: readonly InvitableRole[] = ["planner", "viewer"];

export const isInvitableRole = (value: unknown): value is InvitableRole =>
  typeof value === "string" && (INVITABLE_ROLES as readonly string[]).includes(value);

export type InvitingActor = {
  organizationId: string;
  userId: string;
  roles: readonly string[];
  managedTeamIds: readonly string[];
};

export const isOrganizationAdmin = (actor: Pick<InvitingActor, "roles">): boolean =>
  actor.roles.some((role) => ADMIN_ROLES.includes(role));

export type InviteRefusal =
  | "INVITE_NOT_ALLOWED"
  | "MANAGER_INVITES_DISABLED"
  | "ROLE_NOT_ALLOWED"
  | "TEAM_REQUIRED"
  | "TEAM_NOT_MANAGED";

// Who may invite whom. Admins invite any invitable role into any team. A Team Manager invites
// planners and viewers into a team they manage, and only when the organization allows it.
export const inviteRefusal = (
  actor: InvitingActor,
  input: { role: InvitableRole; teamId: string | null },
  organization: { allowManagerInvites: boolean },
): InviteRefusal | null => {
  if (isOrganizationAdmin(actor)) return null;
  if (!actor.roles.includes("team_manager")) return "INVITE_NOT_ALLOWED";
  if (!organization.allowManagerInvites) return "MANAGER_INVITES_DISABLED";
  if (!MANAGER_INVITABLE_ROLES.includes(input.role)) return "ROLE_NOT_ALLOWED";
  if (!input.teamId) return "TEAM_REQUIRED";
  if (!actor.managedTeamIds.includes(input.teamId)) return "TEAM_NOT_MANAGED";
  return null;
};

// May this actor see, resend or revoke an existing invitation? The same rule as creating it.
export const mayManageInvitation = (
  actor: InvitingActor,
  invitation: { role: InvitableRole; teamId: string | null },
  organization: { allowManagerInvites: boolean },
): boolean => inviteRefusal(actor, invitation, organization) === null;

const EMAIL_PATTERN =
  /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export const isValidEmail = (value: string): boolean => value.length <= 254 && EMAIL_PATTERN.test(value);

// A pasted list: commas, semicolons or new lines between entries, with or without display names
// (`"Jane Doe" <jane@example.com>`). Blank entries are dropped; everything else is kept, in order,
// so an invalid entry is reported on its own row instead of disappearing.
export const parseEmailList = (input: unknown): string[] => {
  const pieces = Array.isArray(input)
    ? input.map((entry) => (typeof entry === "string" ? entry : ""))
    : typeof input === "string"
      ? input.split(/[\n\r,;]+/)
      : [];
  return pieces
    .map((piece) => {
      const bracketed = piece.match(/<([^<>]*)>/);
      return (bracketed ? bracketed[1] : piece).trim();
    })
    .filter((piece) => piece.length > 0);
};

// 256 bits from the CSPRNG. Only the SHA-256 is stored, so a database read can't produce a link.
export const generateInvitationToken = (): string => crypto.randomBytes(32).toString("base64url");

export const hashInvitationToken = (token: string): string =>
  crypto.createHash("sha256").update(token, "utf8").digest("hex");

export const looksLikeInvitationToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export type TokenRefusal =
  | "INVITATION_INVALID"
  | "INVITATION_SUPERSEDED"
  | "INVITATION_ALREADY_USED"
  | "INVITATION_REVOKED"
  | "INVITATION_EXPIRED";

// The messages say what happened to the link and what to do next, and never which organization,
// email or role it was for: whoever holds a dead link learns nothing they didn't already know.
export const TOKEN_REFUSAL_MESSAGES: Record<TokenRefusal, string> = {
  INVITATION_INVALID: "This invitation link isn't valid. Check that you copied the whole link.",
  INVITATION_SUPERSEDED: "A newer invitation was sent for this link. Use the link in the most recent email.",
  INVITATION_ALREADY_USED: "This invitation has already been used. Sign in to continue.",
  INVITATION_REVOKED: "This invitation was withdrawn. Ask your organization's admin for a new one.",
  INVITATION_EXPIRED: "This invitation has expired. Ask your organization's admin to send a new one.",
};

export type InvitationTokenState = {
  status: InvitationStatus;
  expiresAt: Date;
  // True when the presented token is the current link, false when it's a replaced one.
  current: boolean;
};

// Order matters: a used, withdrawn or expired invitation says so even through an old link, and an
// old link to a still-open invitation says a newer one was sent.
export const tokenRefusal = (state: InvitationTokenState | null, now: Date): TokenRefusal | null => {
  if (!state) return "INVITATION_INVALID";
  if (state.status === "accepted") return "INVITATION_ALREADY_USED";
  if (state.status === "revoked") return "INVITATION_REVOKED";
  if (state.status === "expired" || state.expiresAt.getTime() <= now.getTime()) return "INVITATION_EXPIRED";
  if (!state.current) return "INVITATION_SUPERSEDED";
  return null;
};
