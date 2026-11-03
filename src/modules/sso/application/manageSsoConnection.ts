import { connectionDomains, parseIssuer } from "../domain/ssoRules";
import type { ProviderMetadata } from "../domain/ports";

/* Owner/Admin management of the organization's company-OIDC connection and the Require SSO
   switch. The organization is always the caller's session organization. */

export type StoredConnection = {
  id: string;
  organizationId: string;
  issuer: string;
  clientId: string;
  clientSecretSealed: string;
  domains: string[];
  status: "draft" | "active";
  lastTestedAt: Date | null;
  lastTestOutcome: string | null;
  version: number;
  updatedAt: Date;
};

export type ConnectionView = {
  issuer: string;
  clientId: string;
  hasClientSecret: true;
  domains: string[];
  status: "draft" | "active";
  lastTestedAt: string | null;
  lastTestOutcome: string | null;
  version: number;
  updatedAt: string;
};

export type ManageSsoDependencies = {
  connections: {
    find(organizationId: string): Promise<StoredConnection | null>;
    upsert(input: {
      organizationId: string; issuer: string; clientId: string; clientSecretSealed: string; domains: string[];
      actorUserId: string; expectedVersion: number | null;
    }): Promise<StoredConnection | "version_conflict">;
    setStatus(organizationId: string, status: "draft" | "active"): Promise<StoredConnection | null>;
    recordTest(organizationId: string, outcome: string, at: Date): Promise<void>;
    remove(organizationId: string): Promise<boolean>;
    /** Another organization's active connection already claims one of these domains. */
    domainsClaimedElsewhere(organizationId: string, domains: string[]): Promise<string[]>;
  };
  organizations: {
    verifiedDomains(organizationId: string): Promise<string[]>;
    requireSso(organizationId: string): Promise<boolean>;
    setRequireSso(organizationId: string, value: boolean): Promise<void>;
    /** Active members whose email is on `domains`, excluding Owners. */
    nonOwnerMembersOnDomains(organizationId: string, domains: string[]): Promise<string[]>;
  };
  discover(issuer: string): Promise<ProviderMetadata>;
  fetchKeys(jwksUri: string): Promise<number>;
  seal(secret: string, organizationId: string): string;
  redirectUri(): string;
  allowInsecureLocalhost(): boolean;
  revokeMemberSessions(input: { userId: string; organizationId: string; correlationId: string; reason: string }): Promise<number>;
  audit(event: {
    organizationId: string; actorUserId: string; action: string; reason: string; correlationId: string; metadata?: Record<string, unknown>;
  }): Promise<void>;
  now(): Date;
};

type Actor = { organizationId: string; userId: string };

const view = (connection: StoredConnection): ConnectionView => ({
  issuer: connection.issuer,
  clientId: connection.clientId,
  hasClientSecret: true,
  domains: connection.domains,
  status: connection.status,
  lastTestedAt: connection.lastTestedAt?.toISOString() ?? null,
  lastTestOutcome: connection.lastTestOutcome,
  version: connection.version,
  updatedAt: connection.updatedAt.toISOString(),
});

export const createManageSsoConnection = (deps: ManageSsoDependencies) => {
  const read = async (actor: Actor) => {
    const [connection, requireSso, verifiedDomains] = await Promise.all([
      deps.connections.find(actor.organizationId),
      deps.organizations.requireSso(actor.organizationId),
      deps.organizations.verifiedDomains(actor.organizationId),
    ]);
    return { connection: connection ? view(connection) : null, requireSso, redirectUri: deps.redirectUri(), verifiedDomains };
  };

  const save = async (actor: Actor, input: Record<string, unknown>, correlationId: string) => {
    const issuer = parseIssuer(input.issuer, deps.allowInsecureLocalhost());
    const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
    const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
    const version = input.version === undefined || input.version === null ? null : Number(input.version);
    if (!issuer) return { kind: "validation" as const, message: "Enter the issuer URL your identity provider gives you (it starts with https://)." };
    if (!clientId || clientId.length > 300) return { kind: "validation" as const, message: "Enter the client ID." };
    if (clientSecret.length > 2000) return { kind: "validation" as const, message: "The client secret is too long." };
    if (version !== null && !Number.isInteger(version)) return { kind: "validation" as const, message: "Reload the page and try again." };

    const domains = connectionDomains(input.domains, await deps.organizations.verifiedDomains(actor.organizationId));
    if (!domains) return { kind: "validation" as const, message: "Choose at least one verified domain." };
    if ("unverified" in domains) return { kind: "domain_not_verified" as const, domains: domains.unverified };
    const claimed = await deps.connections.domainsClaimedElsewhere(actor.organizationId, domains.domains);
    if (claimed.length) return { kind: "domain_not_verified" as const, domains: claimed };

    const existing = await deps.connections.find(actor.organizationId);
    if (!existing && !clientSecret) return { kind: "validation" as const, message: "Enter the client secret." };
    if (existing && version !== null && version !== existing.version) return { kind: "version_conflict" as const };

    try {
      await deps.discover(issuer);
    } catch {
      return { kind: "issuer_unreachable" as const };
    }
    const saved = await deps.connections.upsert({
      organizationId: actor.organizationId,
      issuer,
      clientId,
      clientSecretSealed: clientSecret ? deps.seal(clientSecret, actor.organizationId) : existing!.clientSecretSealed,
      domains: domains.domains,
      actorUserId: actor.userId,
      expectedVersion: existing ? existing.version : null,
    });
    if (saved === "version_conflict") return { kind: "version_conflict" as const };
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId, action: "organization.sso.updated",
      reason: existing ? "connection_updated" : "connection_created", correlationId,
      metadata: { issuer, domains: domains.domains, secretChanged: Boolean(clientSecret) },
    });
    return { kind: "saved" as const, connection: view(saved) };
  };

  const test = async (actor: Actor, correlationId: string) => {
    const connection = await deps.connections.find(actor.organizationId);
    if (!connection) return { kind: "not_found" as const };
    const problems: string[] = [];
    let authorizationEndpoint: string | null = null;
    try {
      const metadata = await deps.discover(connection.issuer);
      authorizationEndpoint = metadata.authorization_endpoint;
      const keys = await deps.fetchKeys(metadata.jwks_uri).catch(() => 0);
      if (keys === 0) problems.push("The identity provider publishes no signing keys.");
    } catch {
      problems.push("We couldn't read the identity provider's OpenID configuration at this issuer URL.");
    }
    const ok = problems.length === 0;
    await deps.connections.recordTest(actor.organizationId, ok ? "ok" : "failed", deps.now());
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId, action: "organization.sso.tested",
      reason: ok ? "settings_ok" : "settings_failed", correlationId,
    });
    return { kind: "tested" as const, ok, issuer: connection.issuer, authorizationEndpoint, problems };
  };

  const setStatus = async (actor: Actor, status: unknown, correlationId: string) => {
    if (status !== "active" && status !== "draft") return { kind: "validation" as const };
    const existing = await deps.connections.find(actor.organizationId);
    if (!existing) return { kind: "not_found" as const };
    if (status === "draft" && (await deps.organizations.requireSso(actor.organizationId))) {
      await deps.organizations.setRequireSso(actor.organizationId, false);
    }
    const updated = await deps.connections.setStatus(actor.organizationId, status);
    if (!updated) return { kind: "not_found" as const };
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId,
      action: status === "active" ? "organization.sso.enabled" : "organization.sso.disabled",
      reason: status === "active" ? "connection_enabled" : "connection_disabled", correlationId,
    });
    return { kind: "updated" as const, connection: view(updated) };
  };

  const remove = async (actor: Actor, correlationId: string) => {
    await deps.organizations.setRequireSso(actor.organizationId, false);
    const removed = await deps.connections.remove(actor.organizationId);
    if (!removed) return { kind: "not_found" as const };
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId, action: "organization.sso.deleted",
      reason: "connection_deleted", correlationId,
    });
    return { kind: "removed" as const };
  };

  const setRequireSso = async (actor: Actor, value: unknown, correlationId: string) => {
    if (typeof value !== "boolean") return { kind: "validation" as const };
    const connection = await deps.connections.find(actor.organizationId);
    if (value && connection?.status !== "active") return { kind: "connection_not_active" as const };
    const current = await deps.organizations.requireSso(actor.organizationId);
    if (current === value) return { kind: "updated" as const, requireSso: value, signedOutMembers: 0 };
    await deps.organizations.setRequireSso(actor.organizationId, value);
    let signedOutMembers = 0;
    if (value && connection) {
      // Their existing Google/Microsoft sessions end; next time they must use the company sign-in.
      for (const userId of await deps.organizations.nonOwnerMembersOnDomains(actor.organizationId, connection.domains)) {
        if (userId === actor.userId) continue;
        const revoked = await deps.revokeMemberSessions({ userId, organizationId: actor.organizationId, correlationId, reason: "sso_required" });
        if (revoked > 0) signedOutMembers += 1;
      }
    }
    await deps.audit({
      organizationId: actor.organizationId, actorUserId: actor.userId, action: "organization.settings.updated",
      reason: value ? "require_sso_enabled" : "require_sso_disabled", correlationId,
      metadata: { setting: "requireSso", from: current, to: value, signedOutMembers },
    });
    return { kind: "updated" as const, requireSso: value, signedOutMembers };
  };

  return { read, save, test, setStatus, remove, setRequireSso };
};

export type ManageSsoConnection = ReturnType<typeof createManageSsoConnection>;
