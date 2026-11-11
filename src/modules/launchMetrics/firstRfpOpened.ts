import OrganizationMembership from "../../../modal/organizationMembershipModel";

type StampFirstOpen = (input: { organizationId: string; userId: string; at: Date }) => Promise<unknown>;

// Set once: the filter matches only while the field is empty, so later opens change nothing.
// Like lastSignedInAt, it leaves the membership version and updatedAt alone.
const stampMembership: StampFirstOpen = ({ organizationId, userId, at }) =>
  OrganizationMembership.updateOne(
    { organizationId, userId, status: "active", firstRfpOpenedAt: null },
    { $set: { firstRfpOpenedAt: at } },
    { timestamps: false },
  );

// ORG-505: nothing recorded a member opening an RFP, which the PRD metric "time from accept to
// first RFP opened" needs. This keeps the first time only, per membership. It is a measurement,
// so it never delays or fails the read it rides on.
export const createRecordFirstRfpOpened = (stamp: StampFirstOpen = stampMembership, clock: () => Date = () => new Date()) =>
  async (input: { organizationId?: string | null; userId?: string | null; accountType?: string | null }): Promise<void> => {
    if (!input.organizationId || !input.userId || input.accountType === "admin") return;
    try {
      await stamp({ organizationId: input.organizationId, userId: input.userId, at: clock() });
    } catch {
      // Counted as "not yet opened" until the next open.
    }
  };

export const recordFirstRfpOpened = createRecordFirstRfpOpened();
