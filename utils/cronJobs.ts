import Proposal from "../modal/proposalsModel";
import Settings from "../modal/settingsModel";

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
      if (!expirySetting || typeof expirySetting !== "string") continue;

      const match = expirySetting.match(/(\d+)/);
      if (!match) continue;

      const days = parseInt(match[1], 10);
      if (isNaN(days) || days <= 0) continue;

      const creationDate = new Date(proposal.createdAt);
      const expiryDate = new Date(creationDate.getTime() + days * 24 * 60 * 60 * 1000);
      const now = new Date();

      if (now > expiryDate) {
        proposal.isActive = false;
        proposal.isOpen = false;
        proposal.status = "rejected";
        await proposal.save();
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
