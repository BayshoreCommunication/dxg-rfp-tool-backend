import type mongoose from "mongoose";
import AccessRequest, { ACCESS_REQUEST_STATUSES, type AccessRequestStatus } from "../../../modal/accessRequestModel";
import Organization from "../../../modal/organizationModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import User from "../../../modal/userModel";
import { isPublicMailDomain } from "../domainVerification/domain/domainRules";
import type { CreateOutcome, InvitationService } from "../invitations/application/manageInvitations";
import type { InvitingActor } from "../invitations/domain/invitationRules";

/* ORG-306: domain-match access requests.

   At signup, an email whose domain an organization has VERIFIED (ORG-305) is matched to that
   organization; public mail providers never match, and an unverified claim never reveals an
   organization. The person may request access or create a separate organization.

   Approving a request, by an Owner or Admin or automatically when the organization turned on
   auto-approve, sends an ordinary invitation (ORG-203). Joining then goes through the accept
   page, which proves the email and creates the account, so a request never creates an account
   or a membership by itself. A denied person can still create their own organization. */

export { ACCESS_REQUEST_STATUSES };

export type DomainOrganization = { id: string; name: string; autoApproveDomain: boolean };

const ADMIN_ROLES = ["owner", "organization_admin"];
const NAME_MAX = 200;
const objectIdPattern = /^[a-f0-9]{24}$/i;

export const emailDomainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/* The organization that verified this email's domain, if any. */
export const verifiedDomainOrganization = async (rawEmail: unknown): Promise<DomainOrganization | null> => {
  if (typeof rawEmail !== "string") return null;
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const domain = emailDomainOf(email);
  if (isPublicMailDomain(domain)) return null;
  const organization = await Organization.findOne({ verifiedDomains: domain, kind: "customer", status: "active" })
    .select("_id name autoApproveDomain")
    .lean<{ _id: mongoose.Types.ObjectId; name: string; autoApproveDomain?: boolean } | null>();
  if (!organization) return null;
  return { id: String(organization._id), name: organization.name, autoApproveDomain: organization.autoApproveDomain === true };
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
    const organization = await verifiedDomainOrganization(email);
    if (!organization) return { kind: "no_match" };
    if (await User.exists({ email })) return { kind: "account_exists" };

    const pending = await AccessRequest.findOne({ organizationId: organization.id, email, status: "pending" }).select("_id").lean();
    if (pending) return { kind: "pending", organizationName: organization.name };

    if (organization.autoApproveDomain) {
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
