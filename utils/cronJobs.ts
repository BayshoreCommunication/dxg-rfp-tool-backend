import { createNotification } from "./notificationService";
import Proposal from "../modal/proposalsModel";
import Settings from "../modal/settingsModel";

const parseExpiryDays = (expirySetting?: string): number | null => {
  if (!expirySetting || typeof expirySetting !== "string") return null;
  const match = expirySetting.match(/(\d+)/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  return Number.isFinite(days) && days > 0 ? days : null;
};

export const runExpirationCheck = async () => {
  try {
    const activeProposals = await Proposal.find({ isActive: true });
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
        await proposal.save();
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
      .select("_id")
      .lean<{ _id: unknown }[]>();
    if (!doomed.length) return;
    const ids = doomed.map((doc) => String(doc._id));
    // Propagate to private storage and Postgres source rows BEFORE the Mongo
    // delete. Done the other way round, a crash between the two steps strands
    // document bytes with nothing left to identify them; this order leaves the
    // authoritative record in place so the next run retries.
    const { purgeProposalArtifacts } = await import("../src/modules/dataFoundation/purgeProposalArtifacts");
    await purgeProposalArtifacts(ids);
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
};
