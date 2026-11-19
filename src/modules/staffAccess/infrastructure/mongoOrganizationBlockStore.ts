import mongoose, { type ClientSession } from "mongoose";
import Organization from "../../../../modal/organizationModel";
import RefreshSession from "../../../../modal/refreshSessionModel";
import SecurityAuditEvent from "../../../../modal/securityAuditEventModel";
import { safeAuditMetadata } from "../../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { ORGANIZATION_BLOCK_REVOKE_REASON, blockedSince, isOrganizationBlocked, type OrganizationBlockMarker } from "../../organizationBlock/domain";
import type { OrganizationBlockAudit, OrganizationBlockOutcome, OrganizationBlockStore } from "../domain";

/* The ONLY writer of the organization block marker (owner decision, 2026-11-18). Reached only
   from routes/adminOrganizationBlockRoute.ts, through the staff block service.

   Each write is one MongoDB transaction: the organization is read inside it, the marker is set
   or removed, for a block every live session OF THAT ORGANIZATION is ended, and the staff-side
   event is inserted (into `audit.organizationId`, the STAFF organization), so all of it commits
   or none of it does. Nothing here writes a document of the customer organization other than
   the marker on its own organization document and the status of its own refresh sessions, and
   no audit event is written in the customer organization.

   Every filter names the organization the path gave. BLOCKING requires kind `customer` and
   excludes the staff organization; a write that matches nothing changes nothing. REACTIVATING an
   organization that carries the marker removes it whatever the organization has become since
   (it only removes a marker; otherwise such an organization could never be reactivated), by `_id`
   and the marker itself; for an organization that carries no marker the same rule as blocking
   applies and nothing is written. */

const oid = (value: string) => new mongoose.Types.ObjectId(value);
type Row = { _id: unknown; kind?: string; blocked?: { at?: unknown } | null };
type Applied = Exclude<OrganizationBlockOutcome, string>;

const appendEvent = async (audit: OrganizationBlockAudit, reason: string, metadata: Record<string, unknown>, session: ClientSession) => {
  await SecurityAuditEvent.create([{
    organizationId: oid(audit.organizationId),
    actorUserId: oid(audit.actorUserId),
    action: audit.action,
    targetType: audit.targetType,
    targetId: audit.targetId,
    decision: "allowed",
    reason,
    correlationId: audit.correlationId,
    metadata: safeAuditMetadata({ ...audit.metadata, ...metadata }),
  }], { session });
};

const inTransaction = async (
  organizationId: string,
  staffOrganizationId: string,
  work: (organization: Row, filter: Record<string, unknown>, session: ClientSession) => Promise<Applied | "not_manageable">,
  /** Reactivation only: an organization that carries the marker passes whatever it is now. */
  allowMarked = false,
): Promise<OrganizationBlockOutcome> => {
  const session = await mongoose.startSession();
  let outcome: OrganizationBlockOutcome = "not_found";
  try {
    await session.withTransaction(async () => {
      const organization = await Organization.findOne({ _id: oid(organizationId) }).session(session).select("kind blocked").lean<Row | null>();
      if (!organization) { outcome = "not_found"; return; }
      if (allowMarked && isOrganizationBlocked(organization)) {
        outcome = await work(organization, { _id: oid(organizationId), "blocked.at": { $type: "date" } }, session);
        return;
      }
      if (organization.kind !== "customer" || organizationId === staffOrganizationId) { outcome = "not_manageable"; return; }
      outcome = await work(organization, { _id: oid(organizationId), kind: "customer" }, session);
    });
  } finally {
    await session.endSession();
  }
  return outcome;
};

export const mongoOrganizationBlockStore: OrganizationBlockStore = {
  block: (input) =>
    inTransaction(input.organizationId, input.staffOrganizationId, async (organization, filter, session) => {
      const organizationId = oid(input.organizationId);
      // Sessions are ended on every block request, also a repeated one: a session that slipped in
      // while an earlier block committed is closed by asking again.
      const endSessions = async () => (await RefreshSession.updateMany(
        { organizationId, status: { $ne: "revoked" } },
        { $set: { status: "revoked", revokedAt: input.now, revokeReason: ORGANIZATION_BLOCK_REVOKE_REASON } },
        { session },
      )).modifiedCount;
      if (isOrganizationBlocked(organization)) {
        const since = blockedSince(organization);
        const sessionsEnded = await endSessions();
        await appendEvent(input.audit, "organization_already_blocked", { changed: false, before: { blocked: true, blockedAt: since }, after: { blocked: true, blockedAt: since }, sessionsEnded }, session);
        return { changed: false, blockedAt: since, sessionsEnded };
      }
      const marker: OrganizationBlockMarker = { at: input.now, byStaffOrganizationId: input.staffOrganizationId, byStaffAccountId: input.staffAccountId };
      // Written through the collection so the organization's `updatedAt` does not move for a
      // staff action.
      const written = await Organization.collection.updateOne(filter, { $set: { blocked: marker } }, { session });
      if (written.matchedCount !== 1) return "not_manageable";
      const sessionsEnded = await endSessions();
      await appendEvent(input.audit, "organization_blocked", { changed: true, before: { blocked: false, blockedAt: null }, after: { blocked: true, blockedAt: input.now }, sessionsEnded }, session);
      return { changed: true, blockedAt: input.now, sessionsEnded };
    }),

  reactivate: (input) =>
    inTransaction(input.organizationId, input.staffOrganizationId, async (organization, filter, session) => {
      if (!isOrganizationBlocked(organization)) {
        // No marker to remove: the full rule applies, as for a block (the service's verdict).
        if (!input.manageable) return "not_manageable";
        await appendEvent(input.audit, "organization_not_blocked", { changed: false, before: { blocked: false, blockedAt: null }, after: { blocked: false, blockedAt: null } }, session);
        return { changed: false, blockedAt: null, sessionsEnded: 0 };
      }
      const since = blockedSince(organization);
      const written = await Organization.collection.updateOne(filter, { $unset: { blocked: "" } }, { session });
      if (written.matchedCount !== 1) return "not_manageable";
      await appendEvent(input.audit, "organization_reactivated", { changed: true, before: { blocked: true, blockedAt: since }, after: { blocked: false, blockedAt: null }, reactivatedAt: input.now }, session);
      return { changed: true, blockedAt: null, sessionsEnded: 0 };
    }, true),
};
