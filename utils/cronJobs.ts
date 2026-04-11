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

export const startCronJobs = () => {
  // Run once immediately on startup
  runExpirationCheck();

  // Run every 12 hours (12 * 60 * 60 * 1000 ms)
  setInterval(() => {
    runExpirationCheck();
  }, 12 * 60 * 60 * 1000);
};
