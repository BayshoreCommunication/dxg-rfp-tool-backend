import crypto from "node:crypto";
import {
  allowedVerificationMethods,
  isPublicMailDomain,
  normalizeDomain,
  txtRecordValue,
} from "../domain/domainRules";

export type DomainStatus = "pending" | "verified" | "unverified";
export type DomainMethod = "dns_txt" | "admin_email";

export type DomainRecord = {
  id: string;
  organizationId: string;
  domain: string;
  status: DomainStatus;
  verificationToken: string;
  method: DomainMethod | null;
  verifiedByUserId: string | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckOutcome: string | null;
  nextCheckAt: Date;
  createdAt: Date;
};

export interface DomainRepository {
  list(organizationId: string): Promise<DomainRecord[]>;
  findById(organizationId: string, id: string): Promise<DomainRecord | null>;
  countForOrganization(organizationId: string): Promise<number>;
  isVerifiedElsewhere(domain: string, organizationId: string): Promise<boolean>;
  create(input: { organizationId: string; domain: string; verificationToken: string; addedByUserId: string; nextCheckAt: Date }): Promise<DomainRecord | "duplicate">;
  /** Also adds the domain to the organization's verifiedDomains. "claimed" when another organization holds it verified. */
  markVerified(input: { id: string; method: DomainMethod; verifiedByUserId: string | null; now: Date; nextCheckAt: Date; outcome: string }): Promise<"verified" | "claimed">;
  /** Also removes the domain from the organization's verifiedDomains. */
  markUnverified(input: { id: string; now: Date; nextCheckAt: Date; outcome: string }): Promise<void>;
  recordCheck(input: { id: string; now: Date; nextCheckAt: Date; outcome: string }): Promise<void>;
  /** Also removes the domain from the organization's verifiedDomains. */
  remove(organizationId: string, id: string): Promise<DomainRecord | null>;
  due(now: Date, limit: number): Promise<DomainRecord[]>;
}

export type TxtLookup =
  | { kind: "records"; values: string[] }
  | { kind: "none" }
  | { kind: "error"; code: string };

export interface TxtResolver {
  resolve(domain: string): Promise<TxtLookup>;
}

export interface AdminEmailDirectory {
  /** Active member with organization:manage whose account email is at the domain. */
  qualifies(organizationId: string, userId: string, domain: string): Promise<boolean>;
}

export interface DomainAudit {
  append(input: {
    organizationId?: string;
    actorUserId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    decision: "allowed" | "denied" | "created" | "revoked" | "detected";
    reason: string;
    correlationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const RECHECK_VERIFIED_MS = 7 * DAY;
export const RETRY_DNS_ERROR_MS = HOUR;
export const MAX_DOMAINS_PER_ORGANIZATION = 20;
// A new claim is checked every 15 minutes for its first day (DNS propagation), then daily.
export const pendingRecheckMs = (createdAt: Date, now: Date) =>
  now.getTime() - createdAt.getTime() < DAY ? 15 * MINUTE : DAY;

type Dependencies = {
  domains: DomainRepository;
  resolver: TxtResolver;
  adminEmails: AdminEmailDirectory;
  audit: DomainAudit;
  methods?: () => { dnsTxt: boolean; adminEmail: boolean };
  now?: () => Date;
  token?: () => string;
};

export const verificationInstructions = (record: Pick<DomainRecord, "domain" | "verificationToken">) => ({
  type: "TXT" as const,
  name: record.domain,
  value: txtRecordValue(record.verificationToken),
});

export const createDomainVerification = (dependencies: Dependencies) => {
  const now = dependencies.now ?? (() => new Date());
  const methods = dependencies.methods ?? (() => allowedVerificationMethods());
  const newToken = dependencies.token ?? (() => crypto.randomBytes(16).toString("hex"));
  const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

  const audit = (record: Pick<DomainRecord, "id" | "organizationId" | "domain">, action: string, decision: "created" | "allowed" | "revoked" | "detected", reason: string, correlationId: string, actorUserId?: string, metadata: Record<string, unknown> = {}) =>
    dependencies.audit.append({
      organizationId: record.organizationId,
      actorUserId,
      action,
      targetType: "organization_domain",
      targetId: record.id,
      decision,
      reason,
      correlationId,
      metadata: { domain: record.domain, ...metadata },
    });

  const verifyNow = async (record: DomainRecord, method: DomainMethod, verifiedByUserId: string | null, correlationId: string, actorUserId?: string) => {
    const at = now();
    const result = await dependencies.domains.markVerified({
      id: record.id, method, verifiedByUserId, now: at, nextCheckAt: after(at, RECHECK_VERIFIED_MS), outcome: method === "dns_txt" ? "txt_record_found" : "admin_email_domain",
    });
    if (result === "claimed") {
      await dependencies.domains.recordCheck({ id: record.id, now: at, nextCheckAt: after(at, pendingRecheckMs(record.createdAt, at)), outcome: "verified_by_another_organization" });
      return false;
    }
    await audit(record, "organization.domain.verified", "allowed", method, correlationId, actorUserId);
    return true;
  };

  /** One verification or re-check. Only a definitive DNS answer changes a verified domain. */
  const check = async (record: DomainRecord, correlationId: string, actorUserId?: string) => {
    const at = now();
    if (record.status === "verified" && record.method === "admin_email" && methods().adminEmail && record.verifiedByUserId &&
      await dependencies.adminEmails.qualifies(record.organizationId, record.verifiedByUserId, record.domain)) {
      await dependencies.domains.recordCheck({ id: record.id, now: at, nextCheckAt: after(at, RECHECK_VERIFIED_MS), outcome: "admin_email_domain" });
      return "verified" as const;
    }
    const lookup = await dependencies.resolver.resolve(record.domain);
    if (lookup.kind === "error") {
      // SERVFAIL, timeouts: try again soon and leave the status alone.
      await dependencies.domains.recordCheck({ id: record.id, now: at, nextCheckAt: after(at, RETRY_DNS_ERROR_MS), outcome: `dns_error:${lookup.code}` });
      return record.status;
    }
    const found = lookup.kind === "records" && lookup.values.includes(txtRecordValue(record.verificationToken));
    if (found) {
      if (record.status === "verified") {
        await dependencies.domains.recordCheck({ id: record.id, now: at, nextCheckAt: after(at, RECHECK_VERIFIED_MS), outcome: "txt_record_found" });
        return "verified" as const;
      }
      return (await verifyNow(record, "dns_txt", actorUserId ?? null, correlationId, actorUserId)) ? "verified" as const : record.status;
    }
    if (record.status === "verified") {
      await dependencies.domains.markUnverified({ id: record.id, now: at, nextCheckAt: after(at, DAY), outcome: "txt_record_missing" });
      await audit(record, "organization.domain.unverified", "revoked", "txt_record_missing", correlationId, actorUserId);
      return "unverified" as const;
    }
    await dependencies.domains.recordCheck({ id: record.id, now: at, nextCheckAt: after(at, pendingRecheckMs(record.createdAt, at)), outcome: "txt_record_missing" });
    return record.status;
  };

  const add = async (input: { organizationId: string; actorUserId: string; actorEmail: string; domain: unknown; correlationId: string }) => {
    const domain = normalizeDomain(input.domain);
    if (!domain) return { kind: "invalid" as const };
    if (isPublicMailDomain(domain)) return { kind: "not_verifiable" as const };
    if (await dependencies.domains.countForOrganization(input.organizationId) >= MAX_DOMAINS_PER_ORGANIZATION) return { kind: "limit" as const };
    // Don't hint which organization; just that it isn't available.
    if (await dependencies.domains.isVerifiedElsewhere(domain, input.organizationId)) return { kind: "unavailable" as const };
    const at = now();
    const created = await dependencies.domains.create({
      organizationId: input.organizationId,
      domain,
      verificationToken: newToken(),
      addedByUserId: input.actorUserId,
      // The background job picks it up on its next pass.
      nextCheckAt: at,
    });
    if (created === "duplicate") return { kind: "already_added" as const };
    await audit(created, "organization.domain.added", "created", "admin_added", input.correlationId, input.actorUserId);
    const actorEmailDomain = input.actorEmail.toLowerCase().split("@")[1];
    if (methods().adminEmail && actorEmailDomain === domain) {
      await verifyNow(created, "admin_email", input.actorUserId, input.correlationId, input.actorUserId);
    }
    return { kind: "added" as const, record: (await dependencies.domains.findById(input.organizationId, created.id)) ?? created };
  };

  const list = (organizationId: string) => dependencies.domains.list(organizationId);

  const checkNow = async (input: { organizationId: string; id: string; actorUserId: string; correlationId: string }) => {
    const record = await dependencies.domains.findById(input.organizationId, input.id);
    if (!record) return { kind: "not_found" as const };
    await check(record, input.correlationId, input.actorUserId);
    return { kind: "checked" as const, record: (await dependencies.domains.findById(input.organizationId, input.id))! };
  };

  const remove = async (input: { organizationId: string; id: string; actorUserId: string; correlationId: string }) => {
    const removed = await dependencies.domains.remove(input.organizationId, input.id);
    if (!removed) return { kind: "not_found" as const };
    await audit(removed, "organization.domain.removed", "revoked", "admin_removed", input.correlationId, input.actorUserId, { wasVerified: removed.status === "verified" });
    return { kind: "removed" as const };
  };

  /** The background job: every domain whose next check is due, oldest first. */
  const sweep = async (input: { limit?: number; correlationId?: string } = {}) => {
    const due = await dependencies.domains.due(now(), input.limit ?? 100);
    const counts = { checked: 0, verified: 0, unverified: 0, pending: 0, failed: 0 };
    for (const record of due) {
      try {
        const outcome = await check(record, input.correlationId ?? crypto.randomUUID());
        counts.checked += 1;
        counts[outcome] += 1;
      } catch {
        counts.failed += 1;
      }
    }
    return counts;
  };

  return { add, list, checkNow, remove, sweep };
};

export type DomainVerification = ReturnType<typeof createDomainVerification>;
