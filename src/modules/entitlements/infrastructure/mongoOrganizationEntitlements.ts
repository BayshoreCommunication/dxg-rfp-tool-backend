import mongoose, { type ClientSession } from "mongoose";
import Organization from "../../../../modal/organizationModel";
import {
  PLAN_IDS,
  PlanLimitReachedError,
  planIdOf,
  planTable,
  proposalLimitOf,
  type OrganizationPlanState,
} from "../domain/plans";

const PLAN_FIELDS = "kind plan proposalsCreated";

/* The organization is always the caller's own (the session's organization, or the tenant a
   trusted job runs under); nothing here takes an organization id from a request. */
export const loadOrganizationPlanState = async (
  organizationId: string,
  session?: ClientSession,
): Promise<OrganizationPlanState | null> => {
  if (!mongoose.isValidObjectId(organizationId)) return null;
  return Organization.findOne({ _id: organizationId, status: "active" })
    .select(PLAN_FIELDS)
    .session(session ?? null)
    .lean<OrganizationPlanState | null>();
};

// One clause per way an organization may create another RFP: exempt, on a plan without a limit,
// or under its plan's limit. Rows written before plans existed have no plan or counter, so an
// absent plan is the free trial and an absent counter is zero.
const slotAvailable = (env: NodeJS.ProcessEnv): Record<string, unknown> => {
  const table = planTable(env);
  const unlimited = PLAN_IDS.filter((plan) => table[plan].proposalLimit === null);
  const underLimit = (limit: number) => ({ $expr: { $lt: [{ $ifNull: ["$proposalsCreated", 0] }, limit] } });
  const knownPlans: string[] = [...PLAN_IDS];
  return {
    $or: [
      { kind: "legacy_holding" },
      { plan: { $in: unlimited } },
      ...PLAN_IDS.filter((plan) => table[plan].proposalLimit !== null)
        .map((plan) => ({ plan, ...underLimit(table[plan].proposalLimit as number) })),
      // Absent or unrecognized plan values are held to the free trial.
      { plan: { $nin: knownPlans }, ...underLimit(table.free_trial.proposalLimit as number) },
    ],
  };
};

/* Takes one RFP slot: a single conditional increment, so two creates racing for the last slot
   can't both pass. Run it inside the transaction that inserts the RFP; a failed insert then
   rolls the count back, and a successful one can never be uncounted. The counter is never
   decremented anywhere, so deleting an RFP doesn't free a slot. */
export const claimProposalSlot = async (
  organizationId: string,
  session: ClientSession,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  const claimed = await Organization.findOneAndUpdate(
    { _id: organizationId, status: "active", ...slotAvailable(env) },
    { $inc: { proposalsCreated: 1 } },
    { session, new: true, timestamps: false },
  ).select("_id").lean();
  if (claimed) return;
  const organization = await loadOrganizationPlanState(organizationId, session);
  if (!organization) throw new Error("Organization is inactive or unavailable");
  throw new PlanLimitReachedError(
    planIdOf(organization),
    proposalLimitOf(organization, env) ?? 0,
    Math.max(0, Math.floor(organization.proposalsCreated ?? 0)),
  );
};
