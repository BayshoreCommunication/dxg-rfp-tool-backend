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
import TeamMembership from "../modal/teamMembershipModel";
import TwoFactorChallenge from "../modal/twoFactorChallengeModel";
import User from "../modal/userModel";
import UserTwoFactor from "../modal/userTwoFactorModel";

// Removes test sign-ups so the same people can sign up again from scratch. Dry run unless --apply.
// Deletes the accounts and, when every member of an organization is being removed, that
// organization with its domains, SSO, teams, invitations and access requests. Refuses an
// organization that has RFPs, or one whose Owner is removed while others stay. Security audit
// events and Postgres rows (keyed by Mongo ids, never by email) are left: a new sign-up gets new
// ids, so they can't collide.

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const apply = args.get("--apply") === "true";
const emails = (args.get("--emails") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const domain = args.get("--domain")?.trim().toLowerCase();
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (email: string) => new RegExp(`^${escapeRegex(email)}$`, "i");

const help = () => process.stdout.write(`Usage:
  node dist/scripts/purgeTestAccounts.js --domain=<domain>               list accounts on a domain
  node dist/scripts/purgeTestAccounts.js --emails=<a>,<b> [--apply]      remove those accounts
`);

const listDomain = async (onDomain: string) => {
  const users = await User.find({ email: new RegExp(`@${escapeRegex(onDomain)}$`, "i") }).select("email name createdAt").lean();
  const rows = [];
  for (const user of users) {
    const memberships = await OrganizationMembership.find({ userId: user._id }).select("organizationId roles status").lean();
    const orgs = await Organization.find({ _id: { $in: memberships.map((m) => m.organizationId) } }).select("name kind").lean();
    const nameOf = new Map(orgs.map((o) => [String(o._id), `${o.name} (${o.kind})`]));
    rows.push({
      email: user.email,
      createdAt: user.createdAt,
      organizations: memberships.map((m) => ({ organization: nameOf.get(String(m.organizationId)) ?? String(m.organizationId), roles: m.roles, status: m.status })),
    });
  }
  print({ domain: onDomain, accounts: rows });
};

type Plan = { counts: Record<string, number>; run: () => Promise<Record<string, number>> };

const plan = async (): Promise<Plan & { users: string[]; withoutAccount: string[]; organizations: string[]; refused: string[] }> => {
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
    if (org.kind !== "customer") { refused.push(`${label}: kind ${org.kind} is never removed`); continue; }
    const members = await OrganizationMembership.find({ organizationId: id, status: { $ne: "removed" } }).select("userId roles").lean();
    const others = members.filter((m) => !targeted.has(String(m.userId)));
    if (others.length === 0) {
      const proposals = await Proposal.countDocuments({ organizationId: id });
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

const main = async () => {
  if (!mongoUri) throw new Error("MONGODB_URL is required");
  if (!domain && emails.length === 0) return help();
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  try {
    if (emails.length === 0) return await listDomain(domain!);
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
