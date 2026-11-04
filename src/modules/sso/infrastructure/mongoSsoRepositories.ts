import mongoose from "mongoose";
import Organization from "../../../../modal/organizationModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import SsoConnection from "../../../../modal/ssoConnectionModel";
import User from "../../../../modal/userModel";
import { createCustomerWithOrganization } from "../../auth/infrastructure/mongo/customerOrganization";
import { emailDomain, type VerifiedPerson } from "../domain/ssoRules";
import type { ActiveConnection, FederatedAccount } from "../application/federatedSignIn";
import type { StoredConnection } from "../application/manageSsoConnection";

type ConnectionDoc = {
  _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; issuer: string; clientId: string;
  clientSecretSealed: string; domains: string[]; status: "draft" | "active"; lastTestedAt: Date | null;
  lastTestOutcome: string | null; version: number; updatedAt: Date;
};

const toStored = (doc: ConnectionDoc): StoredConnection => ({
  id: String(doc._id),
  organizationId: String(doc.organizationId),
  issuer: doc.issuer,
  clientId: doc.clientId,
  clientSecretSealed: doc.clientSecretSealed,
  domains: doc.domains,
  status: doc.status,
  lastTestedAt: doc.lastTestedAt,
  lastTestOutcome: doc.lastTestOutcome,
  version: doc.version,
  updatedAt: doc.updatedAt,
});

export const mongoSsoConnectionRepository = {
  async find(organizationId: string) {
    const doc = await SsoConnection.findOne({ organizationId }).lean<ConnectionDoc | null>();
    return doc ? toStored(doc) : null;
  },
  async upsert(input: {
    organizationId: string; issuer: string; clientId: string; clientSecretSealed: string; domains: string[];
    actorUserId: string; expectedVersion: number | null;
  }) {
    const fields = {
      issuer: input.issuer, clientId: input.clientId, clientSecretSealed: input.clientSecretSealed,
      domains: input.domains, updatedByUserId: input.actorUserId,
    };
    if (input.expectedVersion === null) {
      try {
        const created = await SsoConnection.create({ organizationId: input.organizationId, ...fields, status: "draft", version: 1 });
        return toStored(created.toObject() as unknown as ConnectionDoc);
      } catch (error) {
        if ((error as { code?: number }).code === 11000) return "version_conflict" as const;
        throw error;
      }
    }
    const doc = await SsoConnection.findOneAndUpdate(
      { organizationId: input.organizationId, version: input.expectedVersion },
      { $set: fields, $inc: { version: 1 } },
      { new: true },
    ).lean<ConnectionDoc | null>();
    return doc ? toStored(doc) : "version_conflict" as const;
  },
  async setStatus(organizationId: string, status: "draft" | "active") {
    const doc = await SsoConnection.findOneAndUpdate(
      { organizationId }, { $set: { status }, $inc: { version: 1 } }, { new: true },
    ).lean<ConnectionDoc | null>();
    return doc ? toStored(doc) : null;
  },
  async recordTest(organizationId: string, outcome: string, at: Date) {
    await SsoConnection.updateOne({ organizationId }, { $set: { lastTestedAt: at, lastTestOutcome: outcome } });
  },
  async remove(organizationId: string) {
    return (await SsoConnection.deleteOne({ organizationId })).deletedCount === 1;
  },
  async domainsClaimedElsewhere(organizationId: string, domains: string[]) {
    const others = await SsoConnection.find({ organizationId: { $ne: organizationId }, domains: { $in: domains } })
      .select("domains").lean<{ domains: string[] }[]>();
    const wanted = new Set(domains);
    return [...new Set(others.flatMap((other) => other.domains.filter((d) => wanted.has(d))))];
  },
};

export const createMongoConnectionLookup = (openSecret: (sealed: string, organizationId: string) => string) => {
  const active = (doc: ConnectionDoc | null): ActiveConnection | null => doc ? {
    id: String(doc._id),
    organizationId: String(doc.organizationId),
    issuer: doc.issuer,
    clientId: doc.clientId,
    clientSecret: openSecret(doc.clientSecretSealed, String(doc.organizationId)),
    domains: doc.domains,
  } : null;
  return {
    async activeForDomain(domain: string) {
      return active(await SsoConnection.findOne({ domains: domain, status: "active" }).lean<ConnectionDoc | null>());
    },
    async activeById(id: string) {
      if (!mongoose.isValidObjectId(id)) return null;
      return active(await SsoConnection.findOne({ _id: id, status: "active" }).lean<ConnectionDoc | null>());
    },
    async organizationVerifiedDomains(organizationId: string) {
      return (await Organization.findById(organizationId).select("verifiedDomains").lean<{ verifiedDomains?: string[] } | null>())?.verifiedDomains ?? [];
    },
  };
};

type UserDoc = {
  _id: mongoose.Types.ObjectId; organizationId?: mongoose.Types.ObjectId; isBlocked?: boolean;
  federatedIdentities?: { issuer: string; subject: string }[];
};
const toAccount = (doc: UserDoc | null): FederatedAccount | null => doc ? {
  userId: String(doc._id),
  organizationId: doc.organizationId ? String(doc.organizationId) : null,
  isBlocked: Boolean(doc.isBlocked),
  identities: (doc.federatedIdentities ?? []).map(({ issuer, subject }) => ({ issuer, subject })),
} : null;
const ACCOUNT_FIELDS = "_id organizationId isBlocked federatedIdentities role";
const customerOnly = { role: "customer" };

const identityOf = (person: VerifiedPerson, at: Date) =>
  ({ provider: person.provider, issuer: person.issuer, subject: person.subject, linkedAt: at });

export const createMongoFederatedAccounts = (randomPasswordHash: () => Promise<string>) => ({
  async findByIdentity(issuer: string, subject: string) {
    return toAccount(await User.findOne({ ...customerOnly, federatedIdentities: { $elemMatch: { issuer, subject } } })
      .select(ACCOUNT_FIELDS).lean<UserDoc | null>());
  },
  async findByEmail(email: string) {
    return toAccount(await User.findOne({ ...customerOnly, email }).select(ACCOUNT_FIELDS).lean<UserDoc | null>());
  },
  async link(userId: string, person: VerifiedPerson) {
    await User.updateOne(
      { _id: userId, "federatedIdentities.issuer": { $ne: person.issuer } },
      { $push: { federatedIdentities: identityOf(person, new Date()) } },
    );
  },
  async createOwner(person: VerifiedPerson) {
    const user = await createCustomerWithOrganization({
      name: person.name,
      email: person.email,
      password: await randomPasswordHash(),
      isVerified: true,
      ...(person.avatar ? { avatar: person.avatar } : {}),
      federatedIdentities: [identityOf(person, new Date())],
    });
    return { userId: String(user._id), organizationId: String(user.organizationId) };
  },
  async joinOrganization(organizationId: string, person: VerifiedPerson, role: "planner") {
    const passwordHash = await randomPasswordHash();
    const session = await mongoose.startSession();
    try {
      let userId = "";
      await session.withTransaction(async () => {
        // Upsert on a fresh id, as signup does, so the model's save hook never re-hashes the hash.
        const user = await User.findOneAndUpdate(
          { _id: new mongoose.Types.ObjectId() },
          {
            $setOnInsert: {
              name: person.name, email: person.email, password: passwordHash, organizationId, role: "customer",
              isBlocked: false, isVerified: true, ...(person.avatar ? { avatar: person.avatar } : {}),
              federatedIdentities: [identityOf(person, new Date())],
            },
          },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true, session },
        ).select("_id").lean<{ _id: mongoose.Types.ObjectId } | null>();
        if (!user) throw new Error("SSO account was not created");
        await OrganizationMembership.create(
          [{ organizationId, userId: user._id, roles: [role], status: "active", activatedAt: new Date() }],
          { session },
        );
        userId = String(user._id);
      });
      return { userId };
    } finally {
      await session.endSession();
    }
  },
  async membership(organizationId: string, userId: string) {
    const doc = await OrganizationMembership.findOne({ organizationId, userId }).select("status roles").lean<{ status: string; roles: string[] } | null>();
    return doc ? { status: doc.status, roles: doc.roles } : null;
  },
  async addMembership(organizationId: string, userId: string, role: "planner") {
    await OrganizationMembership.updateOne(
      { organizationId, userId },
      { $setOnInsert: { organizationId, userId, roles: [role], status: "active", activatedAt: new Date() } },
      { upsert: true },
    );
  },
});

export const mongoSsoOrganizations = {
  async verifiedDomains(organizationId: string) {
    return (await Organization.findById(organizationId).select("verifiedDomains").lean<{ verifiedDomains?: string[] } | null>())?.verifiedDomains ?? [];
  },
  async requireSso(organizationId: string) {
    return Boolean((await Organization.findById(organizationId).select("requireSso").lean<{ requireSso?: boolean } | null>())?.requireSso);
  },
  async setRequireSso(organizationId: string, value: boolean) {
    await Organization.updateOne({ _id: organizationId }, { $set: { requireSso: value } });
  },
  async nonOwnerMembersOnDomains(organizationId: string, domains: string[]) {
    const members = await OrganizationMembership.find({ organizationId, status: "active", roles: { $ne: "owner" } })
      .select("userId").lean<{ userId: mongoose.Types.ObjectId }[]>();
    if (!members.length) return [];
    const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select("_id email").lean<{ _id: mongoose.Types.ObjectId; email: string }[]>();
    const wanted = new Set(domains);
    return users.filter((user) => wanted.has(emailDomain(user.email))).map((user) => String(user._id));
  },
};

/* Require SSO: an email on an active connection's domain, in an organization that requires
   SSO, must use that connection. The organization's Owner is exempt (break-glass), and so is
   anyone who is a member of a different organization (their own account, their own rules). */
export const mongoSsoRequiredFor = async (email: string): Promise<boolean> => {
  const connection = await SsoConnection.findOne({ domains: emailDomain(email), status: "active" })
    .select("organizationId").lean<{ organizationId: mongoose.Types.ObjectId } | null>();
  if (!connection) return false;
  const organization = await Organization.findById(connection.organizationId).select("requireSso").lean<{ requireSso?: boolean } | null>();
  if (!organization?.requireSso) return false;
  const user = await User.findOne({ email, role: "customer" }).select("_id organizationId").lean<{ _id: mongoose.Types.ObjectId; organizationId?: mongoose.Types.ObjectId } | null>();
  if (!user) return true;
  if (user.organizationId && String(user.organizationId) !== String(connection.organizationId)) return false;
  const membership = await OrganizationMembership.findOne({ organizationId: connection.organizationId, userId: user._id })
    .select("roles").lean<{ roles: string[] } | null>();
  return !membership?.roles.includes("owner");
};

/* Whether the invite page should offer company sign-in: the inviting organization has an
   active connection that covers the invited email's domain. */
export const mongoCompanySsoFor = async (organizationId: string, email: string): Promise<boolean> =>
  Boolean(await SsoConnection.exists({ organizationId, domains: emailDomain(email), status: "active" }));

/* Identifier-first sign-in: does any active connection cover this domain? */
export const mongoCompanySsoForDomain = async (domain: string): Promise<boolean> =>
  Boolean(await SsoConnection.exists({ domains: domain, status: "active" }));
