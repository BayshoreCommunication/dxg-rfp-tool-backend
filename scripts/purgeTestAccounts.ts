import "../config/env";
import mongoose, { type Types } from "mongoose";
import { DATABASE_NAME } from "../config/db";
import AccessRequest from "../modal/accessRequestModel";
import Invitation from "../modal/invitationModel";
import InvitationEmailQuota from "../modal/invitationEmailQuotaModel";
import Notification from "../modal/notificationModel";
import Organization from "../modal/organizationModel";
import OrganizationDomain from "../modal/organizationDomainModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Otp from "../modal/otpModel";
import Proposal from "../modal/proposalsModel";
import RefreshSession from "../modal/refreshSessionModel";
import RfpShare from "../modal/rfpShareModel";
import Settings from "../modal/settingsModel";
import SsoConnection from "../modal/ssoConnectionModel";
import Team from "../modal/teamModel";
import OrganizationVendor from "../modal/organizationVendorModel";
import ProposalTemplate from "../modal/proposalTemplateModel";
import TeamMembership from "../modal/teamMembershipModel";
import TwoFactorChallenge from "../modal/twoFactorChallengeModel";
import User from "../modal/userModel";
import UserTwoFactor from "../modal/userTwoFactorModel";
import { organizationKindOf } from "../src/modules/tenancy/organizationKind";

// Removes test sign-ups so the same people can sign up again from scratch. Dry run unless --apply.
// Deletes the accounts and, when every member of an organization is being removed, that
// organization with its domains, SSO, teams, invitations and access requests. Refuses an
// organization that has RFPs, or one whose Owner is removed while others stay. Security audit
// events and Postgres rows (keyed by Mongo ids, never by email) are left: a new sign-up gets new
// ids, so they can't collide.
//
// --with-content also removes what the accounts own (docs/operations/services.md): every proposal,
// through the product's own archive and permanent delete, what those leave pointing at a deleted
// proposal, and the accounts' campaigns, personal templates and support tickets. Irreversible.
// Without the flag nothing below the flag's own branch runs and the report is what it always was.

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const withContent = args.get("--with-content") === "true";
const emails = (args.get("--emails") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const domain = args.get("--domain")?.trim().toLowerCase();
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;
// Anything else on the command line is refused, so a mistyped --with-content cannot fall through
// to the accounts-only path.
const KNOWN_FLAGS = ["--apply", "--with-content", "--emails", "--domain"];
const unknownArguments = [...args.keys()].filter((key) => !KNOWN_FLAGS.includes(key));

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (email: string) => new RegExp(`^${escapeRegex(email)}$`, "i");

const help = () => process.stdout.write(`Usage:
  node dist/scripts/purgeTestAccounts.js --domain=<domain>               list accounts on a domain
  node dist/scripts/purgeTestAccounts.js --emails=<a>,<b> [--apply]      remove those accounts
  node dist/scripts/purgeTestAccounts.js --emails=<a>,<b> --with-content [--apply]
                                                                         remove those accounts and everything they own
`);

const listDomain = async (onDomain: string) => {
  const users = await User.find({ email: new RegExp(`@${escapeRegex(onDomain)}$`, "i") }).select("email name createdAt").lean();
  const rows = [];
  for (const user of users) {
    const memberships = await OrganizationMembership.find({ userId: user._id }).select("organizationId roles status").lean();
    const orgs = await Organization.find({ _id: { $in: memberships.map((m) => m.organizationId) } }).select("name kind").lean();
    const nameOf = new Map(orgs.map((o) => [String(o._id), `${o.name} (${organizationKindOf(o)})`]));
    rows.push({
      email: user.email,
      createdAt: user.createdAt,
      organizations: memberships.map((m) => ({ organization: nameOf.get(String(m.organizationId)) ?? String(m.organizationId), roles: m.roles, status: m.status })),
    });
  }
  print({ domain: onDomain, accounts: rows });
};

type Plan = { counts: Record<string, number>; run: () => Promise<Record<string, number>> };

// goingProposalIds (--with-content only): proposals the content step deletes first, so they no
// longer keep an organization whose every member is removed.
const plan = async (goingProposalIds: Types.ObjectId[] = []): Promise<Plan & { users: string[]; userIds: string[]; withoutAccount: string[]; organizations: string[]; refused: string[] }> => {
  const users = await User.find({ $or: emails.map((email) => ({ email: exact(email) })) }).select("_id email").lean();
  // An address can hold only an access request or an invitation, with no account yet.
  const withoutAccount = emails.filter((email) => !users.some((u) => u.email.toLowerCase() === email));
  const userIds = users.map((u) => u._id as Types.ObjectId);
  const targeted = new Set(userIds.map(String));

  const memberships = await OrganizationMembership.find({ userId: { $in: userIds } }).select("organizationId").lean();
  const orgIds = [...new Set(memberships.map((m) => String(m.organizationId)))];
  const removable: Types.ObjectId[] = [];
  const refused: string[] = [];
  for (const id of orgIds) {
    const org = await Organization.findById(id).select("name kind").lean();
    if (!org) continue;
    const label = `${org.name} (${id})`;
    const kind = organizationKindOf(org);
    if (kind !== "customer") { refused.push(`${label}: kind ${kind} is never removed`); continue; }
    const members = await OrganizationMembership.find({ organizationId: id, status: { $ne: "removed" } }).select("userId roles").lean();
    const others = members.filter((m) => !targeted.has(String(m.userId)));
    if (others.length === 0) {
      const proposals = await Proposal.countDocuments({ organizationId: id, ...(goingProposalIds.length ? { _id: { $nin: goingProposalIds } } : {}) });
      if (proposals > 0) refused.push(`${label}: has ${proposals} RFP(s)`);
      else removable.push(org._id as Types.ObjectId);
    } else if (members.some((m) => targeted.has(String(m.userId)) && (m.roles ?? []).includes("owner"))) {
      refused.push(`${label}: its Owner is being removed but ${others.length} other member(s) stay`);
    }
  }

  const userEmails = emails.map(exact);
  const byUser = { userId: { $in: userIds } };
  const byOrg = { organizationId: { $in: removable } };
  // scope-exempt: an operator script removing whole accounts and organizations across tenants
  const steps: Array<[string, mongoose.Model<any>, Record<string, unknown>]> = [
    ["organizationDomains", OrganizationDomain, byOrg],
    ["ssoConnections", SsoConnection, byOrg],
    ["teams", Team, byOrg],
    ["organizationVendors", OrganizationVendor, byOrg],
    ["proposalTemplates", ProposalTemplate, byOrg],
    ["invitationEmailQuotas", InvitationEmailQuota, byOrg],
    ["invitations", Invitation, { $or: [byOrg, { email: { $in: userEmails } }] }],
    ["accessRequests", AccessRequest, { $or: [byOrg, { email: { $in: userEmails } }] }],
    ["teamMemberships", TeamMembership, { $or: [byOrg, byUser] }],
    ["organizationMemberships", OrganizationMembership, { $or: [byOrg, byUser] }],
    ["notifications", Notification, { $or: [byOrg, byUser] }],
    ["settings", Settings, { $or: [byOrg, byUser] }],
    ["rfpShares", RfpShare, { $or: [byOrg, byUser] }],
    ["refreshSessions", RefreshSession, byUser],
    ["userTwoFactor", UserTwoFactor, byUser],
    ["twoFactorChallenges", TwoFactorChallenge, byUser],
    ["otps", Otp, { email: { $in: userEmails } }],
    ["users", User, { _id: { $in: userIds } }],
    ["organizations", Organization, { _id: { $in: removable } }],
  ];
  const counts: Record<string, number> = {};
  for (const [name, model, filter] of steps) counts[name] = await model.countDocuments(filter);
  return {
    users: users.map((u) => u.email),
    userIds: userIds.map(String),
    withoutAccount,
    organizations: removable.map(String),
    refused,
    counts,
    run: async () => {
      const deleted: Record<string, number> = {};
      for (const [name, model, filter] of steps) deleted[name] = (await model.deleteMany(filter)).deletedCount ?? 0;
      return deleted;
    },
  };
};

// --with-content. Content first, accounts last, and an account goes only when it owns no proposal.
const purgeWithContent = async () => {
  const { postgresEnabled, closePostgres, withPostgresTransaction } = await import("../config/postgres");
  const content = await import("../src/modules/accountPurge/purgeAccountContent");
  const contentPlan = await content.planAccountContent({ emails, postgresEnabled: postgresEnabled() });
  const going = content.doomedProposalIds(contentPlan);
  const p = await plan(going.map((id) => new mongoose.Types.ObjectId(id)));
  // The proposals' private source documents, read from Postgres in a READ ONLY transaction with
  // the tenant settings the product's artifact purge uses (so the app role reads under RLS).
  const liveSources: Array<{ proposalId: string; live: number; held: number; expired: number }> = [];
  const unreachable: string[] = [];
  if (going.length && postgresEnabled() && contentPlan.refused.length === 0) {
    const { postgresPool } = await import("../config/postgres");
    const client = await postgresPool().connect();
    try {
      await client.query("BEGIN READ ONLY");
      const byOrganization = new Map<string, string[]>();
      for (const account of contentPlan.accounts) for (const proposal of account.proposals) byOrganization.set(String(proposal.organizationId), [...(byOrganization.get(String(proposal.organizationId)) ?? []), proposal.id]);
      for (const [organizationId, proposalIds] of byOrganization) {
        await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [organizationId]);
        const org = await client.query<{ id: string; status: string }>("SELECT id, status FROM rfpilot.organizations WHERE external_mongo_id=$1", [organizationId]);
        if (!org.rows[0]) continue; // nothing of this organization is in Postgres: nothing to purge
        // The product's purge will not enter an organization that is not active in Postgres.
        if (org.rows[0].status !== "active") { unreachable.push(`organization ${organizationId}: ${org.rows[0].status} in PostgreSQL, so the product cannot purge its proposals' source documents`); continue; }
        await client.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
        // Held and expired are what purgeProposalArtifacts counts as not deletable.
        const rows = await client.query<{ proposal_id: string; live: number; held: number; expired: number }>(
          `SELECT p.external_mongo_id AS proposal_id, count(*)::int AS live,
                  count(*) FILTER (WHERE s.legal_hold OR coalesce(s.retention_until > now(), false))::int AS held,
                  count(*) FILTER (WHERE s.status = 'expired' AND NOT (s.legal_hold OR coalesce(s.retention_until > now(), false)))::int AS expired
             FROM rfpilot.document_sources s JOIN rfpilot.proposal_references p ON p.id = s.proposal_reference_id
            WHERE p.organization_id = $2 AND p.external_mongo_id = ANY($1) AND s.deleted_at IS NULL GROUP BY 1 ORDER BY 1`,
          [proposalIds, org.rows[0].id],
        );
        for (const row of rows.rows) liveSources.push({ proposalId: row.proposal_id, live: row.live, held: row.held, expired: row.expired });
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await closePostgres();
    }
  }
  const refused = [...p.refused, ...contentPlan.refused, ...unreachable, ...content.sourceRefusals(liveSources)];
  const contentCounts = content.contentTotals(contentPlan);
  const summary = {
    database: DATABASE_NAME, withContent: true, users: p.users, withoutAccount: p.withoutAccount, organizationsRemoved: p.organizations, refused,
    accounts: content.describeAccounts(contentPlan),
    privateSourceDocuments: liveSources.reduce((sum, row) => sum + row.live, 0),
  };
  const footer = { removedBeyondTheProductPath: content.BEYOND_PRODUCT_PATH, stays: content.RETAINED };
  const total = [...Object.values(p.counts), ...Object.values(contentCounts)].reduce((a, b) => a + b, 0);
  if (total === 0) return print({ mode: "nothing-found", ...summary });
  const wouldDelete = { content: contentCounts, accounts: p.counts };
  if (refused.length) {
    process.exitCode = 1;
    return print({ mode: "refused", ...summary, wouldDelete, ...footer });
  }
  if (!apply) return print({ mode: "dry-run", ...summary, wouldDelete, ...footer });

  // Everything below writes. The product modules and storage are loaded only here, so a dry run
  // cannot reach S3 at all, and the only Postgres statements it runs are the read above.
  const { archiveOwnedProposal } = await import("../src/modules/proposals/composition");
  // The product's permanent delete, wired exactly as src/modules/proposals/composition.ts wires
  // it for the route (same application function, same repository, same artifact purge), except
  // that the purge's result is kept: the route's function reports only whether it finished.
  const { createPermanentlyDeleteOwnedProposal } = await import("../src/modules/proposals/application/mutateOwnedProposal");
  const { mongoProposalWriteRepository } = await import("../src/modules/proposals/infrastructure/mongo/mongoProposalWriteRepository");
  const { purgeProposalArtifacts } = await import("../src/modules/dataFoundation/purgeProposalArtifacts");
  type PurgeResult = Awaited<ReturnType<typeof purgeProposalArtifacts>>[number];
  const purgeResults = new Map<string, PurgeResult>();
  const permanentlyDeleteOwnedProposal = createPermanentlyDeleteOwnedProposal(mongoProposalWriteRepository, async (purgeTargets) => {
    const results = purgeTargets.length ? await purgeProposalArtifacts(purgeTargets) : [];
    for (const result of results) purgeResults.set(result.proposalMongoId, result);
    return results;
  });
  const { runWithTenant } = await import("../src/modules/shared/tenancy/tenantContext");
  const { s3PrivateDocumentStorage } = await import("../src/modules/documentIngestion/s3PrivateDocumentStorage");
  const { findOrphanedProposals } = await import("../src/modules/tenancy/migrationVerification");
  type Target = { proposalId: string; organizationId: string; ownerUserId: string };
  // The product functions read the request's tenant and actor; here that is the proposal's owner.
  const asOwner = <T>(target: Target, work: () => Promise<T>) =>
    runWithTenant({ organizationId: target.organizationId, userId: target.ownerUserId, rfpActor: content.ownerOnlyActor(target.organizationId, target.ownerUserId) }, work);
  const orphansIn = async () => {
    const ids = new Set<string>();
    for (const organizationId of contentPlan.organizationIds) {
      for (const row of (await findOrphanedProposals({ organizationId, sampleSize: Number.MAX_SAFE_INTEGER })).byOrganization) row.sample.forEach((id) => ids.add(id));
    }
    return ids;
  };
  try {
    const orphansBefore = await orphansIn();
    let contentDeleted: Record<string, number>;
    try {
      contentDeleted = await content.runContentPurge(contentPlan, {
        ...content.mongoContentPurgePorts,
        archive: (target) => asOwner(target, () => archiveOwnedProposal({ proposalId: target.proposalId, ownerUserId: target.ownerUserId })),
        permanentlyDelete: async (target) => {
          const result = await asOwner(target, () => permanentlyDeleteOwnedProposal({ proposalId: target.proposalId, ownerUserId: target.ownerUserId }));
          const purge = purgeResults.get(target.proposalId);
          return { ...result, purge: purge && { errorCode: purge.errorCode, skipped: purge.skipped, sources: purge.sources } };
        },
        // The same tenant settings the product's artifact purge uses, so the app role can read under RLS.
        liveSourceDocuments: (target) => withPostgresTransaction(async (c) => {
          await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [target.organizationId]);
          const org = await c.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1", [target.organizationId]);
          if (!org.rows[0]) return 0;
          await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
          // Live as the product counts it: any source not tombstoned, deletion_pending included.
          const live = await c.query<{ n: string }>(
            "SELECT count(*) AS n FROM rfpilot.document_sources s JOIN rfpilot.proposal_references p ON p.id = s.proposal_reference_id WHERE p.organization_id=$2 AND p.external_mongo_id=$1 AND s.deleted_at IS NULL",
            [target.proposalId, org.rows[0].id],
          );
          return Number(live.rows[0]?.n ?? 0);
        }),
        deleteStoredObject: (objectKey) => s3PrivateDocumentStorage.delete(objectKey),
      });
    } catch (error) {
      if (!(error instanceof content.ContentPurgeError)) throw error;
      process.exitCode = 1;
      return print({ mode: "failed", ...summary, failed: error.detail, accountsRemoved: [], deleted: { content: error.deletedSoFar, accounts: {} }, next: "No account was removed. Fix the cause and run the same command again: what is already gone is skipped. Source documents a failed artifact purge left deletion_pending are finished by the product's daily reconciler, not by this tool." });
    }
    const stillOwned = await content.proposalsStillOwnedBy(p.userIds);
    // Planned again now that the content is gone; the first plan's counts are stale.
    const accounts = await plan();
    if (stillOwned.length || accounts.refused.length) {
      process.exitCode = 1;
      return print({ mode: "failed", ...summary, failed: { step: "before removing the accounts", proposalsStillOwned: stillOwned, refused: accounts.refused }, accountsRemoved: [], deleted: { content: contentDeleted, accounts: {} }, next: "No account was removed." });
    }
    const deleted = { content: contentDeleted, accounts: await accounts.run() };
    const orphansAfter = await orphansIn();
    const newOrphans = [...orphansAfter].filter((id) => !orphansBefore.has(id));
    const ownedByRemovedAccounts = await content.proposalsStillOwnedBy(p.userIds);
    if (newOrphans.length || ownedByRemovedAccounts.length) process.exitCode = 1;
    print({
      mode: "applied", ...summary, deleted,
      ownerCheck: { organizationsChecked: contentPlan.organizationIds, proposalsWithoutActiveOwnerBefore: orphansBefore.size, proposalsWithoutActiveOwnerAfter: orphansAfter.size, newlyWithoutActiveOwner: newOrphans, stillOwnedByRemovedAccounts: ownedByRemovedAccounts },
      ...footer,
    });
  } finally {
    await closePostgres();
  }
};

const main = async () => {
  if (unknownArguments.length) {
    process.stderr.write(`Unknown argument(s): ${unknownArguments.join(" ")}. Nothing was read or changed.\n`);
    help();
    process.exitCode = 1;
    return;
  }
  if (!mongoUri) throw new Error("MONGODB_URL is required");
  if (!domain && emails.length === 0) return help();
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  try {
    if (emails.length === 0) return await listDomain(domain!);
    if (withContent) return await purgeWithContent();
    const p = await plan();
    const summary = { database: DATABASE_NAME, users: p.users, withoutAccount: p.withoutAccount, organizationsRemoved: p.organizations, refused: p.refused };
    const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
    if (total === 0) return print({ mode: "nothing-found", ...summary });
    if (p.refused.length) return print({ mode: "refused", ...summary, wouldDelete: p.counts });
    if (!apply) return print({ mode: "dry-run", ...summary, wouldDelete: p.counts });
    print({ mode: "applied", ...summary, deleted: await p.run() });
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
