import mongoose from "mongoose";
import EmailCampaign from "../../../modal/emailModel";
import Organization from "../../../modal/organizationModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import ProposalCanonicalSnapshot from "../../../modal/proposalCanonicalSnapshotModel";
import ProposalStatusTransition from "../../../modal/proposalStatusTransitionModel";
import ProposalTemplate from "../../../modal/proposalTemplateModel";
import Proposal from "../../../modal/proposalsModel";
import PublicAccessGrant from "../../../modal/publicAccessGrantModel";
import RfpShare from "../../../modal/rfpShareModel";
import SupportAttachment from "../../../modal/supportAttachmentModel";
import SupportMessage from "../../../modal/supportMessageModel";
import SupportTicket from "../../../modal/supportTicketModel";
import User from "../../../modal/userModel";
import VendorConfirmationDelivery from "../../../modal/vendorConfirmationDeliveryModel";
import VendorResponse from "../../../modal/vendorResponseModel";
import VendorResponseQuestionnaireVersion from "../../../modal/vendorResponseQuestionnaireVersionModel";
import VendorSubmissionDraft from "../../../modal/vendorSubmissionDraftModel";
import VendorSubmission from "../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../modal/vendorSubmissionVersionModel";
import type { RfpActor } from "../identity/domain/rfpAccessPolicy";

// The content half of `scripts/purgeTestAccounts.ts --with-content`: what a test account owns
// beyond the account itself. Proposals go through the product's own archive and permanent-delete
// functions; this module removes what those leave pointing at a deleted proposal or a deleted
// user. The accounts themselves are removed by the script, as before.
//
// scope-exempt: an operator purge that works across organizations by design. Every read and
// write below goes through the raw driver collection (`Model.collection`), never a Mongoose
// query: several of these models refuse deletes in their schema hooks (questionnaire versions,
// submission drafts), and the hooks are there for the product, not for removing a whole account.
//
// The staff/admin collection is never touched: the module that defines it is not imported here,
// accounts are found in the customer `users` collection only, and everything after that is keyed
// by those users' ids. tests/purge-accounts-with-content.test.js holds that as a source check.

type Id = mongoose.Types.ObjectId;
type AnyModel = mongoose.Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const oid = (value: unknown): Id => new mongoose.Types.ObjectId(String(value));

// ---------------------------------------------------------------------------------------------
// What happens to each collection. Every collection src/modules/tenancy/mongoTenantMove.ts lists
// as belonging to a customer has an entry (a test fails when one is added there and not here).
// ---------------------------------------------------------------------------------------------

export type CollectionDecision = {
  decision: "deleted" | "left";
  // product: the product's own permanent delete. content: this module. account: the account
  // step in scripts/purgeTestAccounts.ts (unchanged). none: nothing removes it.
  by: "product" | "content" | "account" | "none";
  why: string;
};

export const COLLECTION_DECISIONS: Record<string, CollectionDecision> = {
  // Customer collections (mongoTenantMove.ts).
  users: { decision: "deleted", by: "account", why: "the account itself" },
  proposals: { decision: "deleted", by: "product", why: "every proposal the account owns, through archive then permanent delete, with the product's artifact purge" },
  settings: { decision: "deleted", by: "account", why: "the account's settings" },
  emailcampaigns: { decision: "deleted", by: "content", why: "campaigns the account sent, and any campaign for a deleted proposal" },
  notifications: { decision: "deleted", by: "account", why: "the account's own notifications; another member's notification about a deleted proposal is theirs and stays, as after the product's own delete" },
  refreshsessions: { decision: "deleted", by: "account", why: "the account's sessions" },
  supporttickets: { decision: "deleted", by: "content", why: "tickets the account opened" },
  supportmessages: { decision: "deleted", by: "content", why: "every message on those tickets, staff replies included" },
  supportattachments: { decision: "deleted", by: "content", why: "attachments on those tickets and uploads the account never sent, with their stored files" },
  vendorresponses: { decision: "deleted", by: "content", why: "responses to a deleted proposal" },
  vendorsubmissions: { decision: "deleted", by: "content", why: "submissions to a deleted proposal" },
  vendorsubmissionversions: { decision: "deleted", by: "content", why: "submission versions of a deleted proposal" },
  vendorsubmissiondrafts: { decision: "deleted", by: "content", why: "vendor drafts for a deleted proposal" },
  vendorconfirmationdeliveries: { decision: "deleted", by: "content", why: "confirmation deliveries for a deleted proposal" },
  vendorresponsequestionnaireversions: { decision: "deleted", by: "content", why: "questionnaires published for a deleted proposal" },
  proposalcanonicalsnapshots: { decision: "deleted", by: "content", why: "migration snapshots of a deleted proposal" },
  publicaccessgrants: { decision: "deleted", by: "content", why: "public links to a deleted proposal" },
  // Not in the tenant-move inventory, but they point at a proposal or a user.
  proposalstatustransitions: { decision: "deleted", by: "content", why: "lifecycle history of a deleted proposal" },
  rfpshares: { decision: "deleted", by: "content", why: "shares of a deleted proposal (shares given to the account go with the account)" },
  proposaltemplates: { decision: "deleted", by: "content", why: "the account's personal templates, which only it could see; organization templates stay because other members use them" },
  organizationmemberships: { decision: "deleted", by: "account", why: "the account's memberships" },
  teammemberships: { decision: "deleted", by: "account", why: "the account's team memberships" },
  supportaccessgrants: { decision: "left", by: "none", why: "never deleted by design (ORG-404): a past grant and the activity under it stay on the record" },
  securityauditevents: { decision: "left", by: "none", why: "append-only security history, keyed by ids a new sign-up never reuses" },
  supportcannedreplies: { decision: "left", by: "none", why: "staff-owned" },
  admins: { decision: "left", by: "none", why: "staff accounts are a separate collection this tool never reads or writes, whatever their email" },
};

// What is left outside MongoDB, printed in every report.
export const RETAINED = [
  { what: "PostgreSQL rfpilot.users and rfpilot.proposal_references rows, AI runs, evidence and audit_events", why: "immutable by design and keyed by MongoDB ids, never by email: a new sign-up gets new ids. The product's own permanent delete leaves the same rows" },
  { what: "PostgreSQL document_sources (tombstoned) and conversations (archived)", why: "the product's artifact purge marks them and deletes the private source objects from storage; the rows stay" },
  { what: "MongoDB security audit events and support access grants", why: "append-only history" },
  { what: "Files in the public asset bucket (proposal uploads, vendor documents)", why: "the product does not delete them when a proposal or a vendor response is deleted, and neither does this tool" },
  { what: "Organization records the account created: invitations it sent, vendor-list entries, teams, organization templates", why: "they belong to the organization and its other members still use them" },
  { what: "The staff/admin account with the same email, if there is one", why: "the admins collection is never read or written" },
] as const;

type DependentRule = { name: string; model: AnyModel; field: string };

// Documents that hang off one proposal. The product's permanent delete removes none of them.
export const PROPOSAL_DEPENDENTS: DependentRule[] = [
  { name: "vendorresponses", model: VendorResponse, field: "proposalId" },
  { name: "vendorsubmissions", model: VendorSubmission, field: "proposalId" },
  { name: "vendorsubmissionversions", model: VendorSubmissionVersion, field: "proposalId" },
  { name: "vendorsubmissiondrafts", model: VendorSubmissionDraft, field: "proposalId" },
  { name: "vendorconfirmationdeliveries", model: VendorConfirmationDelivery, field: "proposalId" },
  { name: "vendorresponsequestionnaireversions", model: VendorResponseQuestionnaireVersion, field: "proposalId" },
  { name: "proposalcanonicalsnapshots", model: ProposalCanonicalSnapshot, field: "legacyProposalId" },
  { name: "publicaccessgrants", model: PublicAccessGrant, field: "resourceId" },
  { name: "proposalstatustransitions", model: ProposalStatusTransition, field: "proposalId" },
  { name: "rfpshares", model: RfpShare, field: "proposalId" },
  { name: "emailcampaigns", model: EmailCampaign, field: "proposalId" },
];

// Documents the account owns outside any proposal.
export const ACCOUNT_CONTENT: Array<{ name: string; model: AnyModel }> = [
  { name: "emailcampaigns", model: EmailCampaign },
  { name: "proposaltemplates", model: ProposalTemplate },
  { name: "supportattachments", model: SupportAttachment },
  { name: "supportmessages", model: SupportMessage },
  { name: "supporttickets", model: SupportTicket },
];

// ---------------------------------------------------------------------------------------------
// Pure rules.
// ---------------------------------------------------------------------------------------------

export type OrganizationFact = { id: string; name: string; kind: string } | { id: string; missing: true };
export type ProposalFact = { id: string; organizationId: string | null; ownerUserId: string | null; archived: boolean; titled: boolean };

// The only identity the product path is given: the proposal's owner as a plain Planner, with no
// managed teams and no shares. The access policy lets that actor archive and delete what it owns
// and nothing else, so an account that is an organization Owner, Admin or Team Manager still
// cannot reach a colleague's proposal through this tool, and an account whose membership is
// suspended or already removed can still be purged.
export const ownerOnlyActor = (organizationId: string, userId: string): RfpActor => ({
  organizationId, userId, roles: ["planner"], membershipStatus: "active", managedTeamIds: [], shares: new Map(),
});

// A proposal about to be deleted that is not owned by an account being purged.
export const ownershipViolations = (proposals: ProposalFact[], targetedUserIds: ReadonlySet<string>): string[] =>
  proposals
    .filter((proposal) => !proposal.ownerUserId || !targetedUserIds.has(proposal.ownerUserId))
    .map((proposal) => `proposal ${proposal.id}: its owner is not one of the accounts being purged`);

// Reasons to refuse the whole run. Nothing is deleted when this returns anything.
export const contentRefusals = (input: {
  proposals: ProposalFact[]; targetedUserIds: ReadonlySet<string>; organizations: OrganizationFact[]; postgresEnabled: boolean;
}): string[] => {
  const refused = ownershipViolations(input.proposals, input.targetedUserIds);
  for (const organization of input.organizations) {
    if ("missing" in organization) refused.push(`organization ${organization.id}: not found, so its content cannot be attributed`);
    else if (organization.kind !== "customer") refused.push(`${organization.name} (${organization.id}): kind ${organization.kind} holds a customer waiting to be placed; its content is never purged`);
  }
  for (const proposal of input.proposals) {
    if (!proposal.organizationId) refused.push(`proposal ${proposal.id}: has no organization, so the product cannot delete it or purge its stored documents`);
  }
  if (input.proposals.length > 0 && !input.postgresEnabled) {
    refused.push("PostgreSQL is not enabled here (POSTGRES_FOUNDATION_ENABLED): the product's artifact purge would skip the proposals' private source documents");
  }
  return refused;
};

export type AccountContent = {
  userId: string;
  email: string;
  organizations: Array<{ id: string; name: string; kind: string; roles: string[]; status: string }>;
  proposals: ProposalFact[];
  // Per collection, the _ids that would go (as strings). Dependents of a proposal are listed
  // under the proposal's owner; a campaign this account sent for someone else's proposal is here.
  documents: Record<string, string[]>;
  storedObjectKeys: string[];
};

export type ContentPlan = { accounts: AccountContent[]; refused: string[]; organizationIds: string[] };

export const doomedProposalIds = (plan: ContentPlan): string[] => plan.accounts.flatMap((account) => account.proposals.map((proposal) => proposal.id));

// Distinct documents per collection across accounts (two purged accounts can share a campaign).
export const contentTotals = (plan: ContentPlan): Record<string, number> => {
  const ids = new Map<string, Set<string>>();
  const add = (name: string, values: string[]) => {
    if (values.length === 0) return;
    const set = ids.get(name) ?? new Set<string>();
    for (const value of values) set.add(value);
    ids.set(name, set);
  };
  for (const account of plan.accounts) {
    add("proposals", account.proposals.map((proposal) => proposal.id));
    for (const [name, values] of Object.entries(account.documents)) add(name, values);
    add("storedSupportFiles", account.storedObjectKeys);
  }
  return Object.fromEntries([...ids].map(([name, set]) => [name, set.size]));
};

// The per-account part of the report: ids and counts, never content.
export const describeAccounts = (plan: ContentPlan) => plan.accounts.map((account) => ({
  email: account.email,
  organizations: account.organizations.map((o) => ({ organization: `${o.name} (${o.kind})`, id: o.id, roles: o.roles, status: o.status })),
  proposals: { count: account.proposals.length, withTitle: account.proposals.filter((p) => p.titled).length, alreadyArchived: account.proposals.filter((p) => p.archived).length, ids: account.proposals.map((p) => p.id) },
  wouldDelete: {
    ...(account.proposals.length ? { proposals: account.proposals.length } : {}),
    ...Object.fromEntries(Object.entries(account.documents).filter(([, ids]) => ids.length > 0).map(([name, ids]) => [name, ids.length])),
    ...(account.storedObjectKeys.length ? { storedSupportFiles: account.storedObjectKeys.length } : {}),
  },
}));

// Collections removed here that the product's own permanent delete would have left behind.
export const BEYOND_PRODUCT_PATH = [...new Set([...PROPOSAL_DEPENDENTS, ...ACCOUNT_CONTENT].map((rule) => rule.name))].sort();

// ---------------------------------------------------------------------------------------------
// Applying: pure orchestration over ports, so the stop rules can be tested without a database.
// ---------------------------------------------------------------------------------------------

export class ContentPurgeError extends Error {
  constructor(
    readonly detail: { email: string; proposalId?: string; step: string; reason: string },
    readonly deletedSoFar: Record<string, number>,
  ) {
    super(`${detail.step} failed for ${detail.email}${detail.proposalId ? `, proposal ${detail.proposalId}` : ""}: ${detail.reason}`);
    this.name = "ContentPurgeError";
  }
}

type ProposalTarget = { proposalId: string; organizationId: string; ownerUserId: string };

export type ContentPurgePorts = {
  // null when the proposal no longer exists; otherwise who owns it now and whether it is archived.
  proposalState(proposalId: string): Promise<{ ownerUserId: string | null; organizationId: string | null; archived: boolean } | null>;
  // The product's own functions, run as the owner.
  archive(target: ProposalTarget): Promise<{ kind: string }>;
  permanentlyDelete(target: ProposalTarget): Promise<{ kind: string }>;
  // Private source documents of the proposal that the product's artifact purge left live.
  liveSourceDocuments(target: ProposalTarget): Promise<number>;
  deleteProposalDependents(proposalId: string): Promise<Record<string, number>>;
  deleteStoredObject(objectKey: string): Promise<void>;
  deleteAccountContent(account: AccountContent): Promise<Record<string, number>>;
};

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Removes the content of every account in the plan, one account at a time, and stops at the
// first thing that does not go as the product says it should. The caller removes accounts only
// when this returns.
//
// Per proposal: archive (the product's precondition for a permanent delete), remove what hangs
// off it, permanently delete, then check the artifact purge left no live source document. The
// dependents go before the proposal so a run that stops half way can simply be run again: the
// proposal is still there, still owned by the account, and is found by the next plan.
export const runContentPurge = async (plan: ContentPlan, ports: ContentPurgePorts): Promise<Record<string, number>> => {
  const deleted: Record<string, number> = {};
  const count = (counts: Record<string, number>) => {
    for (const [name, n] of Object.entries(counts)) if (n) deleted[name] = (deleted[name] ?? 0) + n;
  };
  for (const account of plan.accounts) {
    const fail = (step: string, reason: string, proposalId?: string) => new ContentPurgeError({ email: account.email, proposalId, step, reason }, { ...deleted });
    for (const proposal of account.proposals) {
      const target = { proposalId: proposal.id, organizationId: String(proposal.organizationId), ownerUserId: account.userId };
      const attempt = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
        try { return await work(); } catch (error) { throw error instanceof ContentPurgeError ? error : fail(step, reasonOf(error), proposal.id); }
      };
      const state = await attempt("reading the proposal", () => ports.proposalState(proposal.id));
      if (!state) continue; // already gone
      // Read again at the last moment: the plan may be minutes old.
      if (state.ownerUserId !== account.userId || state.organizationId !== target.organizationId) {
        throw fail("ownership check", "the proposal is no longer owned by this account in this organization", proposal.id);
      }
      if (!state.archived) {
        const archived = await attempt("archive", () => ports.archive(target));
        if (archived.kind !== "archived") throw fail("archive", `the product answered ${archived.kind}`, proposal.id);
      }
      count(await attempt("removing the proposal's dependent documents", () => ports.deleteProposalDependents(proposal.id)));
      const result = await attempt("permanent delete", () => ports.permanentlyDelete(target));
      if (result.kind !== "deleted") throw fail("permanent delete", `the product answered ${result.kind}`, proposal.id);
      count({ proposals: 1 });
      const live = await attempt("artifact purge check", () => ports.liveSourceDocuments(target));
      if (live > 0) throw fail("artifact purge", `${live} private source document(s) of the deleted proposal were not purged; see proposal_artifacts_purge_failed in the log`, proposal.id);
    }
    // Stored files first: a row whose file could not be deleted stays, so the file is not lost track of.
    for (const objectKey of account.storedObjectKeys) {
      try { await ports.deleteStoredObject(objectKey); } catch (error) { throw fail("deleting a stored support attachment", reasonOf(error)); }
      count({ storedSupportFiles: 1 });
    }
    try { count(await ports.deleteAccountContent(account)); } catch (error) { throw fail("removing the account's campaigns, templates and tickets", reasonOf(error)); }
  }
  return deleted;
};

// ---------------------------------------------------------------------------------------------
// MongoDB: the read-only plan and the write ports.
// ---------------------------------------------------------------------------------------------

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (email: string) => new RegExp(`^${escapeRegex(email)}$`, "i");
const idsOf = async (model: AnyModel, filter: Record<string, unknown>): Promise<Id[]> =>
  (await model.collection.find(filter, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id as Id);
const strings = (ids: unknown[]) => ids.map(String);

// Reads only. Emails are matched exactly, case-insensitively, in the customer users collection.
export const planAccountContent = async (input: { emails: string[]; postgresEnabled: boolean }): Promise<ContentPlan> => {
  if (input.emails.length === 0) return { accounts: [], refused: [], organizationIds: [] };
  const users = await User.collection
    .find({ $or: input.emails.map((email) => ({ email: exact(email) })) }, { projection: { _id: 1, email: 1 } })
    .sort({ email: 1, _id: 1 })
    .toArray();
  const targeted = new Set(users.map((user) => String(user._id)));
  const organizationIds = new Set<string>();
  const drafts: Array<Omit<AccountContent, "organizations"> & { memberships: Array<{ organizationId: string; roles: string[]; status: string }> }> = [];

  for (const user of users) {
    const userId = user._id as Id;
    const memberships = (await OrganizationMembership.collection
      .find({ userId }, { projection: { organizationId: 1, roles: 1, status: 1 } }).toArray())
      .map((m) => ({ organizationId: String(m.organizationId), roles: (m.roles as string[]) ?? [], status: String(m.status ?? "active") }));
    const proposals = (await Proposal.collection
      .find({ userId }, { projection: { _id: 1, organizationId: 1, userId: 1, isArchived: 1, "event.eventName": 1 } })
      .sort({ _id: 1 }).toArray())
      .map((p): ProposalFact => ({
        id: String(p._id),
        organizationId: p.organizationId ? String(p.organizationId) : null,
        ownerUserId: p.userId ? String(p.userId) : null,
        archived: p.isArchived === true,
        titled: typeof p.event?.eventName === "string" && p.event.eventName.trim().length > 0,
      }));
    const proposalIds = proposals.map((p) => oid(p.id));

    const documents: Record<string, string[]> = {};
    const add = (name: string, ids: unknown[]) => { documents[name] = [...new Set([...(documents[name] ?? []), ...strings(ids)])]; };
    for (const rule of PROPOSAL_DEPENDENTS) {
      if (proposalIds.length) add(rule.name, await idsOf(rule.model, { [rule.field]: { $in: proposalIds } }));
    }
    add("emailcampaigns", await idsOf(EmailCampaign, { userId }));
    add("proposaltemplates", await idsOf(ProposalTemplate, { ownerUserId: userId, scope: "personal" }));
    const tickets = await SupportTicket.collection.find({ requesterUserId: userId }, { projection: { _id: 1, organizationId: 1 } }).toArray();
    const ticketIds = tickets.map((t) => t._id as Id);
    add("supporttickets", ticketIds);
    const messages = ticketIds.length
      ? await SupportMessage.collection.find({ ticketId: { $in: ticketIds } }, { projection: { _id: 1, "attachments.objectKey": 1 } }).toArray()
      : [];
    add("supportmessages", messages.map((m) => m._id));
    const attachments = await SupportAttachment.collection
      .find({ $or: [{ ticketId: { $in: ticketIds } }, { uploaderUserId: userId }] }, { projection: { _id: 1, objectKey: 1 } }).toArray();
    add("supportattachments", attachments.map((a) => a._id));
    const storedObjectKeys = [...new Set([
      ...attachments.map((a) => a.objectKey as unknown),
      ...messages.flatMap((m) => ((m.attachments as Array<{ objectKey?: unknown }> | undefined) ?? []).map((a) => a.objectKey)),
    ].filter((key): key is string => typeof key === "string" && key.length > 0))].sort();

    const campaignOrganizations = await EmailCampaign.collection.distinct("organizationId", { userId });
    for (const id of [...memberships.map((m) => m.organizationId), ...proposals.map((p) => p.organizationId), ...tickets.map((t) => t.organizationId), ...campaignOrganizations]) {
      if (id) organizationIds.add(String(id));
    }
    drafts.push({ userId: String(userId), email: String(user.email), memberships, proposals, documents, storedObjectKeys });
  }

  const found = await Organization.collection
    .find({ _id: { $in: [...organizationIds].map(oid) } }, { projection: { _id: 1, name: 1, kind: 1 } }).toArray();
  const byId = new Map(found.map((o) => [String(o._id), { id: String(o._id), name: String(o.name ?? ""), kind: String(o.kind ?? "customer") }]));
  const organizations: OrganizationFact[] = [...organizationIds].sort().map((id) => byId.get(id) ?? { id, missing: true as const });

  // Read every proposal about to go once more by id alone, and judge its owner from that read.
  const doomed = drafts.flatMap((draft) => draft.proposals.map((p) => oid(p.id)));
  const reread = doomed.length
    ? (await Proposal.collection.find({ _id: { $in: doomed } }, { projection: { _id: 1, organizationId: 1, userId: 1 } }).toArray())
      .map((p): ProposalFact => ({ id: String(p._id), organizationId: p.organizationId ? String(p.organizationId) : null, ownerUserId: p.userId ? String(p.userId) : null, archived: false, titled: false }))
    : [];

  return {
    accounts: drafts.map(({ memberships, ...draft }) => ({
      ...draft,
      organizations: memberships.map((m) => {
        const organization = byId.get(m.organizationId);
        return { id: m.organizationId, name: organization?.name ?? "(not found)", kind: organization?.kind ?? "unknown", roles: m.roles, status: m.status };
      }),
    })),
    refused: contentRefusals({ proposals: reread, targetedUserIds: targeted, organizations, postgresEnabled: input.postgresEnabled }),
    organizationIds: [...organizationIds].sort(),
  };
};

const deleteByIds = async (model: AnyModel, ids: string[]): Promise<number> =>
  ids.length ? (await model.collection.deleteMany({ _id: { $in: ids.map(oid) } })).deletedCount ?? 0 : 0;

// The MongoDB half of the ports. The product functions and storage are supplied by the script.
export const mongoContentPurgePorts: Pick<ContentPurgePorts, "proposalState" | "deleteProposalDependents" | "deleteAccountContent"> = {
  async proposalState(proposalId) {
    const proposal = await Proposal.collection.findOne({ _id: oid(proposalId) }, { projection: { organizationId: 1, userId: 1, isArchived: 1 } });
    if (!proposal) return null;
    return {
      ownerUserId: proposal.userId ? String(proposal.userId) : null,
      organizationId: proposal.organizationId ? String(proposal.organizationId) : null,
      archived: proposal.isArchived === true,
    };
  },
  async deleteProposalDependents(proposalId) {
    const counts: Record<string, number> = {};
    for (const rule of PROPOSAL_DEPENDENTS) {
      const n = (await rule.model.collection.deleteMany({ [rule.field]: oid(proposalId) })).deletedCount ?? 0;
      if (n) counts[rule.name] = n;
    }
    return counts;
  },
  async deleteAccountContent(account) {
    const counts: Record<string, number> = {};
    for (const rule of ACCOUNT_CONTENT) {
      const n = await deleteByIds(rule.model, account.documents[rule.name] ?? []);
      if (n) counts[rule.name] = n;
    }
    return counts;
  },
};

// Proposals still owned by any of these users, in any organization. Zero before an account goes.
export const proposalsStillOwnedBy = async (userIds: string[]): Promise<string[]> =>
  userIds.length ? strings(await idsOf(Proposal, { userId: { $in: userIds.map(oid) } })) : [];
