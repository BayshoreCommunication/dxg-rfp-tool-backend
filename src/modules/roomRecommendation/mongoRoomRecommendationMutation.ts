import Proposal from "../../../modal/proposalsModel";

/**
 * The only Mongo write surface for room recommendations. Mirrors
 * mongoProposalCandidateMutation: the version/lifecycle/ownership guards live
 * in the update filter so check-and-write is one atomic operation. Two
 * room-specific guards are added on top:
 *
 * - each touched room index must still exist (`roomByRoom.N` element check),
 * - each touched room's roomFunction must still equal the label captured at
 *   generation time. The proposal version only moves on AI applications, not
 *   on ordinary wizard saves, so the label guard is what protects against a
 *   planner reordering or replacing rooms between generation and apply.
 */
export type RoomMutationGuard = { roomIndex: number; roomLabel: string };

export const mongoRoomRecommendationMutation = {
  async snapshot(input: { organizationMongoId: string; actorUserMongoId: string; proposalMongoId: string }) {
    const row = await Proposal.findOne({
      _id: input.proposalMongoId,
      userId: input.actorUserMongoId,
      organizationId: input.organizationMongoId,
    }).select("version status isDraft isArchived roomByRoom").lean<Record<string, unknown>>();
    if (!row) return null;
    return {
      version: Number(row.version || 1),
      status: String(row.status || ""),
      isDraft: row.isDraft === true,
      isArchived: row.isArchived === true,
      roomByRoom: Array.isArray(row.roomByRoom) ? (row.roomByRoom as Record<string, unknown>[]) : [],
    };
  },
  async apply(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    expectedVersion: number;
    guards: RoomMutationGuard[];
    /** Scalar writes: mongo dot path -> normalized wizard value. */
    sets: Record<string, string>;
    /** Array appends: mongo dot path -> values added via $addToSet (never removes). */
    appends: Record<string, string[]>;
  }): Promise<{ version: number } | null> {
    const versionFilter = input.expectedVersion === 1
      ? { $or: [{ version: 1 }, { version: { $exists: false } }] }
      : { version: input.expectedVersion };
    const roomGuards = Object.fromEntries(
      input.guards.map((guard) => [`roomByRoom.${guard.roomIndex}.roomFunction`, guard.roomLabel]),
    );
    const update: Record<string, unknown> = { $inc: { version: 1 } };
    if (Object.keys(input.sets).length) update.$set = input.sets;
    if (Object.keys(input.appends).length)
      update.$addToSet = Object.fromEntries(
        Object.entries(input.appends).map(([path, values]) => [path, { $each: values }]),
      );
    const row = await Proposal.findOneAndUpdate(
      {
        _id: input.proposalMongoId,
        userId: input.actorUserMongoId,
        organizationId: input.organizationMongoId,
        status: "unsubmitted",
        isDraft: true,
        isArchived: { $ne: true },
        ...versionFilter,
        ...roomGuards,
      },
      update,
      { new: true },
    ).select("version").lean<{ version: number }>();
    return row ? { version: Number(row.version) } : null;
  },
};
