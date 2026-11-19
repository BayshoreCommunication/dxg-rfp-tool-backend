import type mongoose from "mongoose";
import AccessRequest, { ACCESS_REQUEST_STATUSES, type AccessRequestStatus } from "../../../modal/accessRequestModel";
import Organization from "../../../modal/organizationModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import User from "../../../modal/userModel";
import { isPublicMailDomain } from "../domainVerification/domain/domainRules";
import type { CreateOutcome, InvitationService } from "../invitations/application/manageInvitations";
import type { InvitingActor } from "../invitations/domain/invitationRules";

/* ORG-306: domain-match access requests.

   At signup, an email on a company domain is matched to the organization already using that
   domain: first one that VERIFIED it by DNS (ORG-305), otherwise the oldest organization with an
   active member who proved an email address on it (signup code, Google, Microsoft or an accepted
   invitation). That second rule closes the gap before anyone verifies the domain, which is when
   colleagues most often sign up. Public mail providers never match, and a domain merely added
   (not verified) in Settings proves nothing. The person may request access or create a separate
   organization. Auto-approve only ever applies to a DNS-verified domain.

   Approving a request, by an Owner or Admin or automatically when the organization turned on
   auto-approve, sends an ordinary invitation (ORG-203). Joining then goes through the accept
   page, which proves the email and creates the account, so a request never creates an account
   or a membership by itself. A denied person can still create their own organization. */

export { ACCESS_REQUEST_STATUSES };

export type DomainMatchBasis = "verified_domain" | "member_email";
export type DomainOrganization = { id: string; name: string; autoApproveDomain: boolean; basis: DomainMatchBasis };

const ADMIN_ROLES = ["owner", "organization_admin"];
const NAME_MAX = 200;
const objectIdPattern = /^[a-f0-9]{24}$/i;

export const emailDomainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

const RESERVED_EXAMPLE_DOMAINS = new Set(["example.com", "example.net", "example.org"]);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* The organization already using this email's company domain, if any (see the header).

   An organization that RFPilot staff BLOCKED still matches, exactly as it does when it is not
   blocked (owner decision, 2026-11-19). While it is blocked a sign-up on its domain must not
   silently get a separate organization, and an outsider must see what they would see without a
   block: the match at verify-otp, 409 ORGANIZATION_DOMAIN_MATCH at register, Google and a first
   Microsoft or company sign-in, with `separateOrganization: true` still the person's own choice.
   What a block changes is only what follows a REQUEST for access (see `request` below). */
export const organizationForEmailDomain = async (rawEmail: unknown): Promise<DomainOrganization | null> => {
  if (typeof rawEmail !== "string") return null;
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const domain = emailDomainOf(email);
  if (isPublicMailDomain(domain)) return null;

  const verified = await Organization.findOne({ verifiedDomains: domain, kind: "customer", status: "active" })
    .select("_id name autoApproveDomain")
    .lean<{ _id: mongoose.Types.ObjectId; name: string; autoApproveDomain?: boolean } | null>();
  if (verified) {
    return { id: String(verified._id), name: verified.name, autoApproveDomain: verified.autoApproveDomain === true, basis: "verified_domain" };
  }

  // Reserved example domains (RFC 2606) are shared placeholders, never one company.
  if (RESERVED_EXAMPLE_DOMAINS.has(domain)) return null;
  // Every account's email was proven when it was created, so an active member on the domain is
  // evidence the organization belongs to that company. Suffix match: small collection for now;
  // index an emailDomain field if this grows.
  const users = await User.find({ email: new RegExp(`@${escapeRegex(domain)}$`, "i") })
    .select("_id").limit(500).lean<{ _id: mongoose.Types.ObjectId }[]>();
  if (users.length === 0) return null;
  const memberships = await OrganizationMembership.find({ userId: { $in: users.map((u) => u._id) }, status: "active" })
    .select("organizationId").lean<{ organizationId: mongoose.Types.ObjectId }[]>();
  if (memberships.length === 0) return null;
  const organization = await Organization.findOne({
    _id: { $in: [...new Set(memberships.map((m) => String(m.organizationId)))] },
    kind: "customer",
    status: "active",
  }).sort({ createdAt: 1 }).select("_id name").lean<{ _id: mongoose.Types.ObjectId; name: string } | null>();
  if (!organization) return null;
  return { id: String(organization._id), name: organization.name, autoApproveDomain: false, basis: "member_email" };
};

export type AccessRequestView = {
  id: string;
  email: string;
  name: string;
  status: AccessRequestStatus;
  autoApproved: boolean;
  createdAt: string;
  decidedAt: string | null;
};

type Stored = {
  _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; email: string; name: string; status: AccessRequestStatus;
  autoApproved?: boolean; createdAt: Date; decidedAt?: Date | null;
};
const toView = (request: Stored): AccessRequestView => ({
  id: String(request._id),
  email: request.email,
  name: request.name,
  status: request.status,
  autoApproved: request.autoApproved === true,
  createdAt: request.createdAt.toISOString(),
  decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
});

export type Audit = (input: {
  organizationId: string; actorUserId?: string; action: string; targetId: string; reason: string; correlationId: string; metadata?: Record<string, unknown>;
}) => Promise<void>;

export type Notifier = {
  // Owners and Admins of the organization: a bell notification and an email.
  requestCreated(input: { organizationId: string; organizationName: string; requestId: string; name: string; email: string; recipients: Array<{ userId: string; email: string }> }): Promise<void>;
  requestDenied(input: { organizationName: string; email: string; name: string }): Promise<void>;
};

export type RequestOutcome =
  | { kind: "validation"; code: "INVALID_NAME" | "INVALID_EMAIL"; message: string }
  | { kind: "no_match" }
  | { kind: "account_exists" }
  | { kind: "pending"; organizationName: string }
  | { kind: "invited"; organizationName: string };

export type DecisionOutcome =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: AccessRequestStatus }
  | { kind: "invitation_refused"; code: string; message: string; status: number }
  | { kind: "decided"; request: AccessRequestView };

const firstInvited = (outcome: CreateOutcome) =>
  outcome.kind === "done" ? outcome.rows[0] : null;

export const createAccessRequestService = (deps: {
  invitations: Pick<InvitationService, "create">;
  notifier: Notifier;
  audit: Audit;
  now?: () => Date;
  /** The organization block gate (organizationBlock/organizationBlockGate.ts). Not given:
      nothing is blocked. A failed read rejects: the request fails and nothing is stored. */
  organizationBlocked?: (organizationId: string) => Promise<boolean>;
}) => {
  const now = deps.now ?? (() => new Date());

  const admins = async (organizationId: string) => {
    const memberships = await OrganizationMembership.find({
      organizationId, status: "active", roles: { $in: ADMIN_ROLES },
    }).select("userId roles").lean<Array<{ userId: mongoose.Types.ObjectId; roles: string[] }>>();
    const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) }, isBlocked: { $ne: true } })
      .select("_id email").lean<Array<{ _id: mongoose.Types.ObjectId; email: string }>>();
    const emailOf = new Map(users.map((u) => [String(u._id), u.email]));
    return memberships
      .filter((m) => emailOf.has(String(m.userId)))
      .map((m) => ({ userId: String(m.userId), email: emailOf.get(String(m.userId))!, roles: m.roles }));
  };

  /* Auto-approve invites on the organization's behalf: the invitation names its Owner. */
  const ownerActor = async (organizationId: string): Promise<InvitingActor | null> => {
    const owner = (await admins(organizationId)).find((admin) => admin.roles.includes("owner"));
    return owner ? { organizationId, userId: owner.userId, roles: ["owner"], managedTeamIds: [] } : null;
  };

  /* Signup: the email has been verified (signup code) by the caller. */
  const request = async (input: { email: unknown; name: unknown; correlationId: string }): Promise<RequestOutcome> => {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > NAME_MAX) return { kind: "validation", code: "INVALID_NAME", message: "Enter your name (up to 200 characters)." };
    const organization = await organizationForEmailDomain(email);
    if (!organization) return { kind: "no_match" };
    if (await User.exists({ email })) return { kind: "account_exists" };

    const pending = await AccessRequest.findOne({ organizationId: organization.id, email, status: "pending" }).select("_id").lean();
    if (pending) return { kind: "pending", organizationName: organization.name };

    /* The organization is blocked by RFPilot staff. The request is stored as `pending` and
       answered as any pending request, and its `organization.access_request.created` event is
       written as for any request (it is the requester's own action). But nothing is sent INTO the
       blocked organization: auto-approve does not run, so no invitation is created or emailed
       (the answer is `pending` even where the domain auto-approves, the one accepted tell), and
       its Owners and Admins get no notification and no email. After a reactivation the request
       is in their list like any other and they approve or deny it; no late notification is sent
       and auto-approve is not applied to it afterwards. Asked before anything is written. */
    const blocked = (await deps.organizationBlocked?.(organization.id)) === true;

    if (organization.autoApproveDomain && !blocked) {
      const actor = await ownerActor(organization.id);
      if (actor) {
        const outcome = await deps.invitations.create(actor, { email, role: "planner", teamId: null }, input.correlationId);
        const row = firstInvited(outcome);
        if (row?.outcome === "invited" || (row?.outcome === "refused" && row.code === "ALREADY_INVITED")) {
          const created = await AccessRequest.create({
            organizationId: organization.id, email, name, status: "approved", autoApproved: true, decidedAt: now(),
            invitationId: row.outcome === "invited" ? row.invitation.id : null,
          });
          await deps.audit({
            organizationId: organization.id, action: "organization.access_request.auto_approved", targetId: String(created._id),
            reason: "auto_approve_domain", correlationId: input.correlationId, metadata: { domain: emailDomainOf(email), role: "planner" },
          });
          return { kind: "invited", organizationName: organization.name };
        }
        // Anything else (the daily email cap, say) falls back to a request an Admin decides.
      }
    }

    let created;
    try {
      created = await AccessRequest.create({ organizationId: organization.id, email, name, status: "pending" });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return { kind: "pending", organizationName: organization.name };
      throw error;
    }
    await deps.audit({
      organizationId: organization.id, action: "organization.access_request.created", targetId: String(created._id),
      reason: "domain_match", correlationId: input.correlationId, metadata: { domain: emailDomainOf(email) },
    });
    if (blocked) return { kind: "pending", organizationName: organization.name };
    await deps.notifier.requestCreated({
      organizationId: organization.id, organizationName: organization.name, requestId: String(created._id), name, email,
      recipients: (await admins(organization.id)).map(({ userId, email: to }) => ({ userId, email: to })),
    }).catch((error) => console.error("Access request notification failed:", error instanceof Error ? error.name : "unknown"));
    return { kind: "pending", organizationName: organization.name };
  };

  const list = async (organizationId: string, status: AccessRequestStatus | "all" = "pending") => {
    const filter: Record<string, unknown> = { organizationId };
    if (status !== "all") filter.status = status;
    const rows = await AccessRequest.find(filter).sort({ createdAt: -1 }).limit(500).lean<Stored[]>();
    return rows.map(toView);
  };

  const loadPending = async (organizationId: string, id: string): Promise<Stored | DecisionOutcome> => {
    if (!objectIdPattern.test(id)) return { kind: "not_found" };
    const found = await AccessRequest.findOne({ _id: id, organizationId }).lean<Stored | null>();
    if (!found) return { kind: "not_found" };
    if (found.status !== "pending") return { kind: "not_pending", status: found.status };
    return found;
  };
  const isOutcome = (value: Stored | DecisionOutcome): value is DecisionOutcome => "kind" in value;

  const approve = async (actor: InvitingActor, id: string, input: { role?: unknown; teamId?: unknown }, correlationId: string): Promise<DecisionOutcome> => {
    const found = await loadPending(actor.organizationId, id);
    if (isOutcome(found)) return found;
    const role = typeof input.role === "string" && input.role ? input.role : "planner";
    const teamId = typeof input.teamId === "string" && input.teamId ? input.teamId : null;
    const outcome = await deps.invitations.create(actor, { email: found.email, role, teamId }, correlationId);
    if (outcome.kind === "validation") return { kind: "invitation_refused", code: outcome.code, message: outcome.message, status: 400 };
    if (outcome.kind === "forbidden") return { kind: "invitation_refused", code: outcome.code, message: outcome.message, status: 403 };
    if (outcome.kind === "limited") return { kind: "invitation_refused", code: outcome.code, message: outcome.message, status: 429 };
    const row = outcome.rows[0];
    if (row.outcome === "refused" && row.code !== "ALREADY_INVITED") {
      return { kind: "invitation_refused", code: row.code, message: row.message, status: 409 };
    }
    const at = now();
    const updated = await AccessRequest.findOneAndUpdate(
      { _id: found._id, status: "pending" },
      { $set: { status: "approved", decidedBy: actor.userId, decidedAt: at, invitationId: row.outcome === "invited" ? row.invitation.id : null } },
      { new: true },
    ).lean<Stored | null>();
    if (!updated) return { kind: "not_pending", status: "approved" };
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId, action: "organization.access_request.approved",
      targetId: id, reason: "approved", correlationId, metadata: { role, teamId },
    });
    return { kind: "decided", request: toView(updated) };
  };

  const deny = async (actor: InvitingActor, id: string, correlationId: string): Promise<DecisionOutcome> => {
    const found = await loadPending(actor.organizationId, id);
    if (isOutcome(found)) return found;
    const updated = await AccessRequest.findOneAndUpdate(
      { _id: found._id, status: "pending" },
      { $set: { status: "denied", decidedBy: actor.userId, decidedAt: now() } },
      { new: true },
    ).lean<Stored | null>();
    if (!updated) return { kind: "not_pending", status: "denied" };
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId, action: "organization.access_request.denied",
      targetId: id, reason: "denied", correlationId,
    });
    const organization = await Organization.findById(actor.organizationId).select("name").lean<{ name: string } | null>();
    // In the background: the decision is made whether or not the email goes out.
    void deps.notifier.requestDenied({ organizationName: organization?.name ?? "the organization", email: found.email, name: found.name })
      .catch((error) => console.error("Access request denial email failed:", error instanceof Error ? error.name : "unknown"));
    return { kind: "decided", request: toView(updated) };
  };

  const settings = async (organizationId: string) => {
    const organization = await Organization.findById(organizationId).select("autoApproveDomain verifiedDomains")
      .lean<{ autoApproveDomain?: boolean; verifiedDomains?: string[] } | null>();
    return { autoApproveDomain: organization?.autoApproveDomain === true, verifiedDomains: organization?.verifiedDomains ?? [] };
  };

  const setAutoApprove = async (actor: InvitingActor, value: unknown, correlationId: string) => {
    if (typeof value !== "boolean") return { kind: "validation" as const };
    // Auto-approve trusts the domain itself, so it needs DNS proof (ORG-305).
    if (value && (await settings(actor.organizationId)).verifiedDomains.length === 0) return { kind: "no_verified_domain" as const };
    await Organization.updateOne({ _id: actor.organizationId }, { $set: { autoApproveDomain: value } });
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId, action: "organization.settings.updated",
      targetId: actor.organizationId, reason: "access_request_auto_approve", correlationId, metadata: { setting: "autoApproveDomain", value },
    });
    return { kind: "updated" as const, settings: await settings(actor.organizationId) };
  };

  return { request, list, approve, deny, settings, setAutoApprove };
};

export type AccessRequestService = ReturnType<typeof createAccessRequestService>;
