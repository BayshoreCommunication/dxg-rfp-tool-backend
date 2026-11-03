// Fixtures for the membership-management suites (ORG-206/207/307): an organization with one
// member per role, each with a real refresh session and access token.
import { randomMongoId } from "./setup";
import type { AddressInfo } from "node:net";
import http from "node:http";
import express from "express";
import mongoose from "mongoose";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Proposal from "../modal/proposalsModel";
import RefreshSession from "../modal/refreshSessionModel";
import SecurityAuditEvent from "../modal/securityAuditEventModel";
import Team from "../modal/teamModel";
import TeamMembership from "../modal/teamMembershipModel";
import User from "../modal/userModel";
import { authenticate, AuthRequest } from "../middleware/auth";
import { authenticationSessions } from "../src/modules/auth/composition";
import organizationMembersRoutes from "../routes/organizationMembersRoute";

export const ROLES = ["owner", "organization_admin", "team_manager", "planner", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export type Member = { userId: string; email: string; accessToken: string; refreshToken: string; sessionId: string };
export type Fixture = { organizationId: string; members: Record<Role, Member> };

export const SLUG_PREFIX = "intg-members-";

export const signIn = async (organizationId: string, userId: string, email: string) => {
  const membership = await OrganizationMembership.findOne({ organizationId, userId }).lean();
  const roles = membership?.roles ?? [];
  const session = await authenticationSessions.begin({
    account: { userId, accountType: "planner", email, organizationId, role: "customer", roles, rolesVersion: membership?.version ?? 1 },
    correlationId: randomMongoId(),
  });
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, sessionId: session.sessionId };
};

export const seedOrganization = async (label = "Members Org"): Promise<Fixture> => {
  const organization = await Organization.create({ name: label, slug: `${SLUG_PREFIX}${randomMongoId().slice(0, 12)}` });
  const organizationId = String(organization._id);
  const members = {} as Record<Role, Member>;
  for (const role of ROLES) {
    const email = `${role}-${randomMongoId().slice(0, 10)}@example.com`;
    const user = await User.create({ name: `${role} person`, email, password: "not-a-real-hash", role: "customer", organizationId: organization._id, isBlocked: false });
    const userId = String(user._id);
    await OrganizationMembership.create({ organizationId, userId, roles: [role], status: "active" });
    members[role] = { userId, email, ...(await signIn(organizationId, userId, email)) };
  }
  return { organizationId, members };
};

export const createProposals = async (organizationId: string, ownerUserId: string, count: number) => {
  const created = await Proposal.collection.insertMany(Array.from({ length: count }, (_, i) => ({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    userId: new mongoose.Types.ObjectId(ownerUserId),
    status: "unsubmitted", isDraft: true, eventName: `Fixture event ${i}`, createdAt: new Date(), updatedAt: new Date(),
  })));
  return Object.values(created.insertedIds).map(String);
};

export const startApp = () => {
  const app = express();
  app.use(express.json());
  app.get("/me", authenticate, (req: AuthRequest, res) => {
    res.json({ roles: req.rfpActor!.roles, rolesVersion: req.user!.rolesVersion });
  });
  app.use("/api/organization", organizationMembersRoutes);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { server, call };
};

export const stopApp = (server: http.Server | undefined) => {
  server?.closeAllConnections();
  server?.close();
};

export const membershipOf = (organizationId: string, userId: string) =>
  OrganizationMembership.findOne({ organizationId, userId }).lean();

export const auditEvents = (organizationId: string, action: string) =>
  SecurityAuditEvent.find({ organizationId, action }).sort({ createdAt: 1 }).lean();

export const cleanupOrganizations = async () => {
  const orgs = await Organization.find({ slug: new RegExp(`^${SLUG_PREFIX}`) }).select("_id").lean();
  const ids = orgs.map((o) => o._id);
  await Promise.all([
    OrganizationMembership.deleteMany({ organizationId: { $in: ids } }),
    RefreshSession.deleteMany({ organizationId: { $in: ids } }),
    Proposal.collection.deleteMany({ organizationId: { $in: ids } }),
    Team.collection.deleteMany({ organizationId: { $in: ids } }),
    TeamMembership.collection.deleteMany({ organizationId: { $in: ids } }),
    User.deleteMany({ organizationId: { $in: ids } }),
    Organization.deleteMany({ _id: { $in: ids } }),
  ]);
};
