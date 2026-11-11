import { createNotification } from "./notificationService";
import Proposal from "../modal/proposalsModel";
import Settings from "../modal/settingsModel";
import { proposalLifecycle } from "../src/modules/proposalLifecycle/composition";

const parseExpiryDays = (expirySetting?: string): number | null => {
  if (!expirySetting || typeof expirySetting !== "string") return null;
  const match = expirySetting.match(/(\d+)/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  return Number.isFinite(days) && days > 0 ? days : null;
};

export const runExpirationCheck = async () => {
  try {
    // Expiry is a published-proposal lifecycle: it closes something vendors can
    // see. isActive defaults to true, so unsubmitted drafts were being swept up
    // too — warned about, then auto-expired to "rejected" a week after creation
    // even though they had never left the planner's hands.
    const activeProposals = await Proposal.find({
      isActive: true,
      status: { $ne: "unsubmitted" },
    });
    const settingsByUserId = new Map<string, any>();
    
    for (const proposal of activeProposals) {
      const userId = proposal.userId;
      const userIdText = userId ? String(userId) : "";
      let settings = userIdText ? settingsByUserId.get(userIdText) : null;
      if (!settings && userIdText) {
        settings = await Settings.findOne({ userId });
        settingsByUserId.set(userIdText, settings);
      }
      const expirySetting = settings?.proposals?.expiryDate;
      const days = parseExpiryDays(expirySetting);
      if (!days) continue;

      const creationDate = new Date(proposal.createdAt);
      const expiryDate = new Date(creationDate.getTime() + days * 24 * 60 * 60 * 1000);
      const now = new Date();
      const msUntilExpiry = expiryDate.getTime() - now.getTime();
      const proposalTitle = proposal.event?.eventName?.trim() || "Untitled Proposal";

      if (userIdText && msUntilExpiry > 0 && msUntilExpiry <= 24 * 60 * 60 * 1000) {
        const expiryDay = expiryDate.toISOString().slice(0, 10);
        await createNotification({
          userId: userIdText,
          proposalId: String(proposal._id),
          type: "proposal_expiring_soon",
          title: "Proposal expires tomorrow",
          message: `"${proposalTitle}" will expire on ${expiryDate.toLocaleDateString()}.`,
          dedupeKey: `proposal-expiring-soon:${proposal._id}:${expiryDay}`,
          metadata: {
            expiryDate: expiryDate.toISOString(),
          },
        });
      }

      if (now > expiryDate) {
        proposal.isActive = false;
        proposal.isOpen = false;
        proposal.status = "rejected";
        // save() writes only the modified paths, so it can't clobber a concurrent lifecycle write.
        await proposal.save();
        if (proposal.organizationId) {
          await proposalLifecycle.record({
            organizationId: String(proposal.organizationId),
            proposalId: String(proposal._id),
            actor: { type: "system" },
            reason: "expired",
          });
        }
        if (userIdText) {
          await createNotification({
            userId: userIdText,
            proposalId: String(proposal._id),
            type: "proposal_expired",
            title: "Proposal expired",
            message: `"${proposalTitle}" has expired and is now closed.`,
            dedupeKey: `proposal-expired:${proposal._id}`,
            metadata: {
              expiryDate: expiryDate.toISOString(),
            },
          });
        }
        console.log(`[Cron] Auto-expired proposal ${proposal._id}`);
      }
    }
  } catch (error) {
    console.error(`[Cron] Proposal expiration error:`, error);
  }
};

export const purgeArchivedProposals = async () => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const doomed = await Proposal.find({ isArchived: true, archivedAt: { $lte: thirtyDaysAgo } })
      .select("_id organizationId")
      .lean<{ _id: unknown; organizationId?: unknown }[]>();
    if (!doomed.length) return;
    const ids = doomed.map((doc) => String(doc._id));
    // Propagate to private storage and Postgres source rows BEFORE the Mongo
    // delete. Done the other way round, a crash between the two steps strands
    // document bytes with nothing left to identify them; this order leaves the
    // authoritative record in place so the next run retries.
    const { purgeProposalArtifacts } = await import("../src/modules/dataFoundation/purgeProposalArtifacts");
    await purgeProposalArtifacts(doomed.map((doc) => ({ proposalMongoId: String(doc._id), organizationMongoId: String(doc.organizationId ?? "") })).filter((row) => row.organizationMongoId));
    const result = await Proposal.deleteMany({ _id: { $in: ids } });
    if (result.deletedCount > 0) {
      console.log(`[Cron] Purged ${result.deletedCount} archived proposal(s) older than 30 days`);
    }
  } catch (error) {
    console.error("[Cron] Archive purge error:", error);
  }
};

const runRetentionSweep = async () => {
  try {
    const { sweepExpiredArtifacts, retentionSweepEnabled } = await import(
      "../src/modules/dataFoundation/retentionSweeper"
    );
    if (!retentionSweepEnabled()) return;
    const result = await sweepExpiredArtifacts();
    const total = Object.values(result.deleted).reduce((sum, n) => sum + n, 0);
    console.log(
      `[Cron] Retention sweep ${result.dryRun ? "(dry run)" : "applied"}: ${total} row(s) across ${result.organizations} organization(s)`,
      result.deleted,
    );
  } catch (error) {
    console.error("[Cron] Retention sweep error:", error);
  }
};

export const runVendorDraftCleanup = async () => {
  try {
    const { cleanupExpiredVendorResponseDrafts } = await import(
      "../src/modules/vendorResponses/composition"
    );
    const result = await cleanupExpiredVendorResponseDrafts();
    if (result.drafts > 0) {
      console.log(
        `[Cron] Vendor draft cleanup processed ${result.drafts} draft(s): ${result.deletedDocuments} document(s) deleted, ${result.retainedDocuments} retained, ${result.failedDocuments} pending retry`,
      );
    }
  } catch {
    // Do not print provider errors, object keys, filenames, or draft payloads.
    console.error("[Cron] Vendor draft cleanup failed");
  }
};

// ORG-109: proposals whose owner is no longer an active member of the proposal's organization.
// The PRD tracks "orphaned RFPs = 0"; a non-zero count needs a reassignment. Counts only, no ids.
export const runOrphanedProposalCheck = async () => {
  try {
    const { findOrphanedProposals } = await import("../src/modules/tenancy/migrationVerification");
    const result = await findOrphanedProposals({ sampleSize: 0 });
    if (result.total > 0) {
      console.warn(`[Cron] Orphaned proposals: ${result.total} across ${result.byOrganization.length} organization(s)`);
    } else {
      console.log("[Cron] Orphaned proposals: 0");
    }
  } catch {
    console.error("[Cron] Orphaned proposal check failed");
  }
};

// ORG-204: expire invitations, queue the day-six reminder, and send or retry invitation email.
// Counts only: never addresses or links.
export const runInvitationSweep = async () => {
  try {
    const { sweepInvitations } = await import("../src/modules/invitations/composition");
    const result = await sweepInvitations();
    if (result.expired || result.remindersQueued || result.sent || result.failed) {
      console.log(
        `[Cron] Invitations: ${result.expired} expired, ${result.remindersQueued} reminder(s) queued, ${result.sent} email(s) sent, ${result.failed} failed`,
      );
    }
  } catch {
    console.error("[Cron] Invitation sweep failed");
  }
};

// ORG-305: verifies pending domains and re-checks verified ones weekly. Each run takes the
// domains whose next check is due; removing a TXT record un-verifies on the re-check.
export const runDomainVerificationSweep = async () => {
  try {
    const { domainVerification } = await import("../src/modules/domainVerification/composition");
    const result = await domainVerification.sweep({ limit: 200 });
    if (result.skipped) {
      console.log("[Cron] Domain verification: previous sweep still running, skipped");
      return;
    }
    if (result.checked > 0 || result.failed > 0) {
      console.log(`[Cron] Domain verification: ${result.checked} checked, ${result.verified} verified, ${result.unverified} unverified, ${result.pending} pending, ${result.failed} failed`);
    }
  } catch {
    console.error("[Cron] Domain verification sweep failed");
  }
};

export const startCronJobs = () => {
  // Run once immediately on startup
  runExpirationCheck();
  purgeArchivedProposals();

  // Run every 12 hours
  setInterval(() => {
    runExpirationCheck();
  }, 12 * 60 * 60 * 1000);

  // Run archive purge once per day (24 hours)
  setInterval(() => {
    purgeArchivedProposals();
  }, 24 * 60 * 60 * 1000);

  // Retention enforcement, once per day. Deny-by-default and dry-run by
  // default: RETENTION_SWEEP_ENABLED turns on reporting, RETENTION_SWEEP_APPLY
  // is the separate decision to actually delete. Not run on startup — a
  // deletion pass should happen on a predictable schedule, not on every deploy.
  setInterval(() => {
    void runRetentionSweep();
  }, 24 * 60 * 60 * 1000);

  // Draft cleanup is intentionally not run during process startup. It is a
  // deletion workflow and should execute on the predictable daily schedule.
  setInterval(() => {
    void runVendorDraftCleanup();
  }, 24 * 60 * 60 * 1000);

  // Every 15 minutes: a failed invitation email is retried within the hour, and the day-six
  // reminder goes out within 15 minutes of the invitation having a day left.
  void runInvitationSweep();
  setInterval(() => {
    void runInvitationSweep();
  }, 15 * 60 * 1000);

  void runDomainVerificationSweep();
  setInterval(() => {
    void runDomainVerificationSweep();
  }, 15 * 60 * 1000);

  // Read-only, so it also runs on startup and gives a deploy an immediate reading.
  void runOrphanedProposalCheck();
  setInterval(() => {
    void runOrphanedProposalCheck();
  }, 24 * 60 * 60 * 1000);
};
