import mongoose from "mongoose";
import Proposal from "../../../../modal/proposalsModel";
import { canAccessRfp, rfpListScope, type RfpAction, type RfpActor } from "../domain/rfpAccessPolicy";
import { currentRfpActor, currentTenantOrNull } from "../../shared/tenancy/tenantContext";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import { resolveRfpActor } from "./resolveRfpActor";

// Thrown when a proposal exists in the actor's organization but the access policy refuses the
// action. Controllers map it to 403; a proposal outside the organization stays a plain miss (404).
export class ProposalAccessDeniedError extends Error {
  readonly status = 403;
  readonly code = "PROPOSAL_ACCESS_DENIED";
  constructor() {
    super("You don't have access to this proposal");
    this.name = "ProposalAccessDeniedError";
  }
}

export const isProposalAccessDenied = (error: unknown): error is ProposalAccessDeniedError =>
  error instanceof ProposalAccessDeniedError;

// For controller catch blocks: answers 403 and returns true when the error is an access denial.
export const respondIfProposalAccessDenied = (
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown,
): boolean => {
  if (!isProposalAccessDenied(error)) return false;
  res.status(403).json({ success: false, code: error.code, message: error.message });
  return true;
};

// The request's actor, checked against the user id the caller passed down. Ports still carry
// that id, so a mismatch means a caller is acting for someone else and must not be scoped as them.
export const requestActorFor = (userId: string): RfpActor => {
  const actor = currentRfpActor();
  if (String(actor.userId) !== String(userId)) throw new Error("Proposal access actor does not match the requesting user");
  return actor;
};

// The caller's filter narrowed to the actor's organization and to what the policy lets them do.
// $and keeps the policy's _id/$or clauses from overwriting or merging with the caller's own.
export const scopeProposalFilter = (
  actor: RfpActor,
  action: RfpAction,
  filter: Record<string, unknown> = {},
): Record<string, unknown> => ({ $and: [filter, rfpListScope(actor, action)] });

// Call after a scoped single-proposal query found nothing: throws when the proposal is in the
// actor's organization (so the miss was a refusal), and returns quietly when it isn't there.
export const assertProposalMissIsNotFound = async (actor: RfpActor, proposalId: unknown, action: RfpAction): Promise<void> => {
  if (!mongoose.isValidObjectId(proposalId)) return;
  const proposal = await Proposal.findOne({ _id: proposalId, organizationId: actor.organizationId })
    .select("organizationId userId teamId")
    .lean<{ _id: unknown; organizationId?: unknown; userId?: unknown; teamId?: unknown } | null>();
  if (!proposal) return;
  const decision = canAccessRfp(actor, {
    id: String(proposal._id),
    organizationId: proposal.organizationId as string,
    ownerUserId: proposal.userId as string,
    teamId: (proposal.teamId as string | undefined) ?? null,
  }, action);
  if (!decision.allowed) throw new ProposalAccessDeniedError();
};

// Whether the requesting actor may perform action on the proposal. "not_found" covers a bad id
// and a proposal outside the organization; an in-organization refusal throws (403).
export const checkRequestProposalAccess = async (
  actorUserId: string,
  proposalId: string,
  action: RfpAction,
): Promise<"allowed" | "not_found"> => {
  const actor = requestActorFor(actorUserId);
  if (!mongoose.isValidObjectId(proposalId)) return "not_found";
  if (await Proposal.exists(scopeProposalFilter(actor, action, { _id: proposalId }))) return "allowed";
  await assertProposalMissIsNotFound(actor, proposalId, action);
  return "not_found";
};

export type ActingUser = { organizationId: string; userId: string };

// The policy actor for a user acting in an organization. Inside an authenticated request it is the
// one the middleware resolved; elsewhere (durable jobs carry the organization and user that queued
// them) it is rebuilt from the membership, so a job can't outlive the access that started it.
export const actorFor = async ({ organizationId, userId }: ActingUser): Promise<RfpActor> => {
  const requestActor = currentTenantOrNull()?.rfpActor;
  if (requestActor && String(requestActor.userId) === String(userId) && String(requestActor.organizationId) === String(organizationId)) {
    return requestActor;
  }
  const membership = await OrganizationMembership.findOne({ organizationId, userId }).select("roles status").lean();
  return resolveRfpActor({ organizationId: String(organizationId), userId: String(userId), roles: membership?.roles ?? [], status: membership?.status ?? "removed" });
};

// Single-proposal filter for an acting user. Use with explainProposalMiss after a miss.
export const proposalFilterFor = async (who: ActingUser, action: RfpAction, filter: Record<string, unknown>) =>
  scopeProposalFilter(await actorFor(who), action, filter);

export const explainProposalMiss = async (who: ActingUser, proposalId: unknown, action: RfpAction) =>
  assertProposalMissIsNotFound(await actorFor(who), proposalId, action);

// Vendor responses and submissions inherit their proposal's decision. Organization-wide actors
// need only the organization; everyone else is narrowed to the proposals the policy lets them reach.
export const vendorRecordScope = async (who: ActingUser, action: RfpAction): Promise<Record<string, unknown>> => {
  const actor = await actorFor(who);
  const organizationId = new mongoose.Types.ObjectId(String(actor.organizationId));
  // An organization-wide scope is the organization filter alone.
  if (Object.keys(rfpListScope(actor, action)).length === 1) return { organizationId };
  const proposalIds = await Proposal.distinct("_id", scopeProposalFilter(actor, action));
  return { organizationId, proposalId: { $in: proposalIds } };
};

// After a scoped lookup of one vendor record missed: a record in the actor's organization whose
// proposal the policy refuses is a 403; anything else stays a miss.
export const explainVendorRecordMiss = async (
  who: ActingUser,
  model: { findOne(filter: Record<string, unknown>): { select(fields: string): { lean<T>(): Promise<T> } } },
  recordId: unknown,
  action: RfpAction,
): Promise<void> => {
  if (!mongoose.isValidObjectId(recordId)) return;
  const record = await model.findOne({ _id: recordId, organizationId: who.organizationId }).select("proposalId").lean<{ proposalId?: unknown } | null>();
  if (record?.proposalId) await explainProposalMiss(who, record.proposalId, action);
};
