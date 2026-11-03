import InvitationEmailQuota from "../../../../modal/invitationEmailQuotaModel";
import type { InvitationEmailQuota as InvitationEmailQuotaPort } from "../domain/ports";

const DAY_MS = 24 * 60 * 60 * 1000;
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

// One counter per organization per UTC day. The increment is conditional on staying within the
// limit, so concurrent requests can't overshoot it; the first request of the day inserts it.
export const mongoInvitationEmailQuota: InvitationEmailQuotaPort = {
  async reserve({ organizationId, count, limit, now }) {
    if (count <= 0) return { ok: true };
    const day = now.toISOString().slice(0, 10);
    const remainingNow = async () => {
      const current = await InvitationEmailQuota.findOne({ organizationId, day }).select("count").lean<{ count: number } | null>();
      return Math.max(0, limit - (current?.count ?? 0));
    };
    if (count > limit) return { ok: false, remaining: await remainingNow() };
    const increment = async () =>
      (await InvitationEmailQuota.updateOne({ organizationId, day, count: { $lte: limit - count } }, { $inc: { count } })).modifiedCount === 1;
    if (await increment()) return { ok: true };
    // No row yet for today: the first insert wins. A request that loses that race (or found the
    // row created since its increment) tries the conditional increment once more before refusing.
    if (!(await InvitationEmailQuota.exists({ organizationId, day }))) {
      try {
        await InvitationEmailQuota.create({ organizationId, day, count, expiresAt: new Date(Date.parse(`${day}T00:00:00Z`) + 2 * DAY_MS) });
        return { ok: true };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    if (await increment()) return { ok: true };
    return { ok: false, remaining: await remainingNow() };
  },
};
